package snapshot

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/store"
)

// Crosswalk tables, the indexes and the FTS table are created after loading
const Schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE item(id INTEGER PRIMARY KEY, qid INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL, label TEXT, original_title TEXT, year INTEGER, lang TEXT, country TEXT, runtime INTEGER, parent_qid INTEGER, ordinal INTEGER);
CREATE TABLE xid(item_id INTEGER NOT NULL, ns TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, value)) WITHOUT ROWID;
CREATE TABLE title(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, title TEXT NOT NULL, normalized TEXT NOT NULL, lang TEXT NOT NULL, kind TEXT NOT NULL);
`

const indexes = `
CREATE INDEX xid_item ON xid(item_id);
CREATE INDEX title_item ON title(item_id);
CREATE INDEX title_normalized ON title(normalized);
CREATE VIRTUAL TABLE title_fts USING fts5(title, normalized, content='title', content_rowid='id', tokenize='trigram remove_diacritics 1');
INSERT INTO title_fts(title_fts) VALUES('rebuild');
INSERT INTO title_fts(title_fts) VALUES('optimize');
`

// Contents of the meta table of one crosswalk file
type Meta struct {
	Version     string
	BuiltAt     time.Time
	Source      string
	License     string
	Items       int64
	XIDs        int64
	QLeverIndex string
}

// Row and byte totals one build wrote
type Counts struct {
	Meta   Meta
	Kinds  map[string]int64
	XIDs   map[string]int64
	Titles map[string]int64
	Bytes  int64
}

// Stores a dataset at path as a WAL-mode file whose WAL is checkpointed and removed
func Write(ctx context.Context, path string, d *Dataset, builtAt time.Time) (Counts, error) {
	builtAt = builtAt.UTC().Truncate(time.Second)
	c := Counts{
		Meta:  Meta{Version: builtAt.Format(VersionLayout), BuiltAt: builtAt, Source: Source, License: License, QLeverIndex: d.Index},
		Kinds: map[string]int64{}, XIDs: map[string]int64{}, Titles: map[string]int64{},
	}
	tmp := path + ".tmp"
	if err := RemoveDB(tmp); err != nil {
		return c, err
	}
	db, err := sql.Open("sqlite", store.DSN(tmp))
	if err != nil {
		return c, err
	}
	db.SetMaxOpenConns(1)
	if err := load(ctx, db, d, &c); err != nil {
		return c, errors.Join(err, db.Close(), RemoveDB(tmp))
	}
	if err := db.Close(); err != nil {
		return c, errors.Join(err, RemoveDB(tmp))
	}
	if fi, err := os.Stat(tmp + "-wal"); err == nil && fi.Size() > 0 {
		return c, errors.Join(fmt.Errorf("snapshot: %s-wal still holds %d bytes after the checkpoint", tmp, fi.Size()), RemoveDB(tmp))
	}
	for _, companion := range []string{tmp + "-wal", tmp + "-shm"} {
		if err := os.Remove(companion); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return c, err
		}
	}
	if err := PinHeader(tmp); err != nil {
		return c, errors.Join(err, RemoveDB(tmp))
	}
	if err := RemoveDB(path); err != nil {
		return c, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return c, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return c, err
	}
	c.Bytes = fi.Size()
	return c, nil
}

// Header fields SQLite rewrites on every page 1 write, pinned so builds and peer replicas match byte for byte
const (
	headerCounter  = 1
	headerSoftware = 3000000
)

// Writes the fixed change counter, version-valid-for, and library version into a closed database file
func PinHeader(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	header := make([]byte, 100)
	if _, err := io.ReadFull(f, header); err != nil {
		_ = f.Close()
		return fmt.Errorf("snapshot: read header of %s: %w", path, err)
	}
	if string(header[:16]) != "SQLite format 3\x00" {
		_ = f.Close()
		return fmt.Errorf("snapshot: %s is not a SQLite file", path)
	}
	binary.BigEndian.PutUint32(header[24:], headerCounter)
	binary.BigEndian.PutUint32(header[92:], headerCounter)
	binary.BigEndian.PutUint32(header[96:], headerSoftware)
	if _, err := f.WriteAt(header, 0); err != nil {
		_ = f.Close()
		return err
	}
	return errors.Join(f.Sync(), f.Close())
}

// Deletes a database file with its WAL, shared memory, and journal companions
func RemoveDB(path string) error {
	for _, p := range []string{path, path + "-wal", path + "-shm", path + "-journal"} {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Writes every row, builds the indexes, vacuums, and truncates the WAL
func load(ctx context.Context, db *sql.DB, d *Dataset, c *Counts) error {
	if _, err := db.ExecContext(ctx, Schema); err != nil {
		return fmt.Errorf("snapshot: schema: %w", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	insItem, err := tx.PrepareContext(ctx, `INSERT INTO item(id, qid, kind, label, original_title, year, lang, country, runtime, parent_qid, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	insXID, err := tx.PrepareContext(ctx, `INSERT INTO xid(item_id, ns, value) VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	insTitle, err := tx.PrepareContext(ctx, `INSERT INTO title(id, item_id, title, normalized, lang, kind) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	written := map[int64]string{}
	for _, it := range d.Items {
		written[it.QID] = it.Kind
	}
	for _, it := range d.Items {
		parent := it.ParentQID
		if want := parentKind(it.Kind); parent != 0 && written[parent] != want {
			parent = 0
		}
		if _, err := insItem.ExecContext(ctx, it.QID, it.QID, it.Kind, null(it.Label), null(it.OriginalTitle), nullInt(int64(it.Year)),
			null(it.Lang), null(strings.Join(it.Countries, ",")), nullInt(int64(it.Runtime)), nullInt(parent), nullInt(int64(it.Ordinal))); err != nil {
			return fmt.Errorf("snapshot: item Q%d: %w", it.QID, err)
		}
		c.Kinds[it.Kind]++
		for _, x := range it.XIDs {
			if _, err := insXID.ExecContext(ctx, it.QID, x.Namespace, x.Value); err != nil {
				return fmt.Errorf("snapshot: xid %s:%s of Q%d: %w", x.Namespace, x.Value, it.QID, err)
			}
			c.XIDs[x.Namespace]++
			c.Meta.XIDs++
		}
		if len(it.Titles) >= maxTitles {
			return fmt.Errorf("snapshot: Q%d has %d titles, the id layout holds %d", it.QID, len(it.Titles), maxTitles-1)
		}
		for n, t := range it.Titles {
			if _, err := insTitle.ExecContext(ctx, it.QID<<16|int64(n), it.QID, t.Text, model.Normalize(t.Text), t.Lang, t.Kind); err != nil {
				return fmt.Errorf("snapshot: title of Q%d: %w", it.QID, err)
			}
			c.Titles[t.Kind]++
		}
		c.Meta.Items++
	}
	meta := [][2]string{
		{"version", c.Meta.Version},
		{"built_at", c.Meta.BuiltAt.Format(time.RFC3339)},
		{"source", c.Meta.Source},
		{"license", c.Meta.License},
		{"items", strconv.FormatInt(c.Meta.Items, 10)},
		{"xids", strconv.FormatInt(c.Meta.XIDs, 10)},
		{"qlever_index", c.Meta.QLeverIndex},
	}
	for _, kv := range meta {
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES (?, ?)`, kv[0], kv[1]); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, stmt := range []string{indexes, "VACUUM", "PRAGMA wal_checkpoint(TRUNCATE)"} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("snapshot: %s: %w", strings.Fields(stmt)[0], err)
		}
	}
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return err
	}
	if mode != "wal" {
		return fmt.Errorf("snapshot: journal mode is %s, peers need wal", mode)
	}
	return nil
}

// Kind an item's parent must have to be linked
func parentKind(kind string) string {
	switch kind {
	case model.KindSeason:
		return model.KindSeries
	case model.KindEpisode:
		return model.KindSeason
	}
	return ""
}

func null(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(n int64) any {
	if n == 0 {
		return nil
	}
	return n
}

// Reads the meta table of a crosswalk file through an open handle
func ReadMeta(ctx context.Context, db *sql.DB) (Meta, error) {
	rows, err := db.QueryContext(ctx, `SELECT key, value FROM meta`)
	if err != nil {
		return Meta{}, fmt.Errorf("snapshot: read meta: %w", err)
	}
	defer func() { _ = rows.Close() }()
	kv := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return Meta{}, err
		}
		kv[k] = v
	}
	if err := rows.Err(); err != nil {
		return Meta{}, err
	}
	m := Meta{Version: kv["version"], Source: kv["source"], License: kv["license"], QLeverIndex: kv["qlever_index"]}
	if m.BuiltAt, err = time.Parse(time.RFC3339, kv["built_at"]); err != nil {
		return Meta{}, fmt.Errorf("snapshot: meta built_at: %w", err)
	}
	if m.Items, err = strconv.ParseInt(kv["items"], 10, 64); err != nil {
		return Meta{}, fmt.Errorf("snapshot: meta items: %w", err)
	}
	if m.XIDs, err = strconv.ParseInt(kv["xids"], 10, 64); err != nil {
		return Meta{}, fmt.Errorf("snapshot: meta xids: %w", err)
	}
	if m.Version == "" {
		return Meta{}, errors.New("snapshot: meta has no version")
	}
	return m, nil
}

// Connection string that opens a crosswalk file immutable so no WAL or shared memory file appears beside it
func ReadOnlyDSN(path string) string {
	p := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" {
		p = "/" + p
	}
	escaped := strings.NewReplacer("%", "%25", "?", "%3f", "#", "%23").Replace(p)
	return "file:" + escaped + "?mode=ro&immutable=1&_pragma=query_only(1)"
}
