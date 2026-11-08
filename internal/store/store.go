// Package store opens the application database and applies embedded migrations
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"time"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	atlassqlite "ariga.io/atlas/sql/sqlite"
	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	_ "modernc.org/sqlite"

	"github.com/nickheyer/DiscoFlix/internal/store/ent"
)

//go:embed migrations/*.sql migrations/atlas.sum
var migrationFS embed.FS

// FileName is the application database file inside the data directory
const FileName = "app.db"

// Store owns the application database connection and the Ent client over it
type Store struct {
	DB   *sql.DB
	Ent  *ent.Client
	Path string
	log  *slog.Logger
}

// MigrateReport describes what Migrate did
type MigrateReport struct {
	Applied  int
	Snapshot string
}

// DSN builds the connection string with WAL, foreign keys, busy timeout, and immediate write locks
func DSN(path string) string {
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Add("_pragma", "temp_store(MEMORY)")
	q.Set("_txlock", "immediate")
	return "file:" + path + "?" + q.Encode()
}

// Open connects to app.db inside dataDir, creating the directory when missing
func Open(ctx context.Context, dataDir string, log *slog.Logger) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return nil, fmt.Errorf("store: create data dir: %w", err)
	}
	path := filepath.Join(dataDir, FileName)
	db, err := sql.Open("sqlite", DSN(path))
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetConnMaxLifetime(0)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	drv := entsql.OpenDB(dialect.SQLite, db)
	return &Store{DB: db, Ent: ent.NewClient(ent.Driver(drv)), Path: path, log: log}, nil
}

// Migrate applies pending embedded migrations after snapshotting a populated database
func (s *Store) Migrate(ctx context.Context, operatorVersion string) (MigrateReport, error) {
	dir := atlasmigrate.OpenMemDir("")
	defer func() { _ = dir.Close() }()
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return MigrateReport{}, fmt.Errorf("store: read migrations: %w", err)
	}
	for _, e := range entries {
		data, err := fs.ReadFile(migrationFS, "migrations/"+e.Name())
		if err != nil {
			return MigrateReport{}, fmt.Errorf("store: read %s: %w", e.Name(), err)
		}
		if err := dir.WriteFile(e.Name(), data); err != nil {
			return MigrateReport{}, fmt.Errorf("store: stage %s: %w", e.Name(), err)
		}
	}
	drv, err := atlassqlite.Open(s.DB)
	if err != nil {
		return MigrateReport{}, fmt.Errorf("store: atlas driver: %w", err)
	}
	rrw := &revisions{db: s.DB}
	if err := rrw.init(ctx); err != nil {
		return MigrateReport{}, err
	}
	ex, err := atlasmigrate.NewExecutor(drv, dir, rrw,
		atlasmigrate.WithOperatorVersion(operatorVersion),
		atlasmigrate.WithLogger(migrateLogger{s.log}),
	)
	if err != nil {
		return MigrateReport{}, fmt.Errorf("store: executor: %w", err)
	}
	pending, err := ex.Pending(ctx)
	if errors.Is(err, atlasmigrate.ErrNoPendingFiles) {
		return MigrateReport{}, nil
	}
	if err != nil {
		return MigrateReport{}, fmt.Errorf("store: pending migrations: %w", err)
	}
	report := MigrateReport{Applied: len(pending)}
	applied, err := rrw.ReadRevisions(ctx)
	if err != nil {
		return MigrateReport{}, err
	}
	if len(applied) > 0 {
		report.Snapshot = fmt.Sprintf("%s.before-%s-%s", s.Path, pending[0].Version(), time.Now().UTC().Format("20060102T150405Z"))
		if err := s.Snapshot(ctx, report.Snapshot); err != nil {
			return MigrateReport{}, err
		}
	}
	if err := ex.ExecuteN(ctx, 0); err != nil {
		return MigrateReport{}, fmt.Errorf("store: migrate: %w", err)
	}
	return report, nil
}

// Snapshot writes a consistent copy of the live database to dst using VACUUM INTO
func (s *Store) Snapshot(ctx context.Context, dst string) error {
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("store: snapshot target %s already exists", dst)
	}
	if _, err := s.DB.ExecContext(ctx, "VACUUM INTO ?", dst); err != nil {
		return fmt.Errorf("store: snapshot: %w", err)
	}
	return nil
}

// Close closes the Ent client and the underlying connection pool
func (s *Store) Close() error {
	return s.Ent.Close()
}

// migrateLogger forwards Atlas executor events to slog
type migrateLogger struct{ log *slog.Logger }

func (l migrateLogger) Log(e atlasmigrate.LogEntry) {
	switch v := e.(type) {
	case atlasmigrate.LogExecution:
		l.log.Info("migrations pending", "from", v.From, "to", v.To, "files", len(v.Files))
	case atlasmigrate.LogFile:
		l.log.Info("applying migration", "version", v.Version, "description", v.Desc)
	case atlasmigrate.LogError:
		l.log.Error("migration failed", "error", v.Error, "statement", v.SQL)
	case atlasmigrate.LogDone:
		l.log.Info("migrations applied")
	}
}
