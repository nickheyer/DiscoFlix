package identity

import (
	"context"
	"database/sql"
	"encoding/gob"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"time"

	"github.com/alexedwards/scs/v2"
	_ "modernc.org/sqlite"

	"github.com/nickheyer/DiscoFlix/internal/store"
)

// SessionFile is the session database inside the data directory
const SessionFile = "sessions.db"

// CookieName carries the session token
const CookieName = "df_session"

func init() {
	gob.Register(time.Time{})
}

// sessionStore keeps scs sessions in their own SQLite file
type sessionStore struct{ db *sql.DB }

func openSessionStore(ctx context.Context, dataDir string) (*sessionStore, error) {
	db, err := sql.Open("sqlite", store.DSN(filepath.Join(dataDir, SessionFile)))
	if err != nil {
		return nil, fmt.Errorf("identity: open sessions: %w", err)
	}
	db.SetMaxOpenConns(4)
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, data BLOB NOT NULL, expiry REAL NOT NULL);
		CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expiry)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("identity: sessions schema: %w", err)
	}
	return &sessionStore{db: db}, nil
}

func (s *sessionStore) Find(token string) ([]byte, bool, error) {
	return s.FindCtx(context.Background(), token)
}

func (s *sessionStore) FindCtx(ctx context.Context, token string) ([]byte, bool, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT data FROM sessions WHERE token = ? AND expiry > ?`, token, unixFloat(time.Now())).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

func (s *sessionStore) Commit(token string, data []byte, expiry time.Time) error {
	return s.CommitCtx(context.Background(), token, data, expiry)
}

func (s *sessionStore) CommitCtx(ctx context.Context, token string, data []byte, expiry time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (token, data, expiry) VALUES (?, ?, ?)
		ON CONFLICT(token) DO UPDATE SET data = excluded.data, expiry = excluded.expiry`, token, data, unixFloat(expiry))
	return err
}

func (s *sessionStore) Delete(token string) error {
	return s.DeleteCtx(context.Background(), token)
}

func (s *sessionStore) DeleteCtx(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}

func (s *sessionStore) All() (map[string][]byte, error) {
	return s.AllCtx(context.Background())
}

func (s *sessionStore) AllCtx(ctx context.Context) (map[string][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT token, data FROM sessions WHERE expiry > ?`, unixFloat(time.Now()))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]byte{}
	for rows.Next() {
		var token string
		var data []byte
		if err := rows.Scan(&token, &data); err != nil {
			return nil, err
		}
		out[token] = data
	}
	return out, rows.Err()
}

// cleanup removes expired rows
func (s *sessionStore) cleanup(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expiry <= ?`, unixFloat(time.Now()))
	return err
}

func unixFloat(t time.Time) float64 { return float64(t.UnixNano()) / 1e9 }

// newSessionManager configures scs with the SQLite store and the cookie policy
func newSessionManager(st *sessionStore, secure bool) *scs.SessionManager {
	sm := scs.New()
	sm.Store = st
	sm.Lifetime = 30 * 24 * time.Hour
	sm.IdleTimeout = 14 * 24 * time.Hour
	sm.HashTokenInStore = true
	sm.Cookie = scs.SessionCookie{
		Name:     CookieName,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		Persist:  true,
	}
	return sm
}

type sessionLoadedKey struct{}

// sessionLoaded reports whether the request passed through the session middleware
func sessionLoaded(ctx context.Context) bool {
	v, _ := ctx.Value(sessionLoadedKey{}).(bool)
	return v
}
