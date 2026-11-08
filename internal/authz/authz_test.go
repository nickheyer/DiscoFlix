package authz

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/nickheyer/DiscoFlix/internal/store"
)

func TestModelCheckAndOutbox(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	ctx := context.Background()
	st, err := store.Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if _, err := st.Migrate(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	a, err := Open(ctx, dir, st.Ent, log)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	tx, err := st.Ent.Tx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ops := []Op{
		Write(SystemObject, "admin", "user:alice"),
		Write(SystemObject, "member", "user:bob"),
		Write("space:s1", "system", SystemObject),
		Write("channel:c1", "space", "space:s1"),
	}
	if err := Stage(ctx, tx, ops...); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := a.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		user, rel, obj string
		want           bool
	}{
		{"user:alice", "users_admin", SystemObject, true},
		{"user:bob", "users_admin", SystemObject, false},
		{"user:bob", "timeline_read", SystemObject, true},
		{"user:bob", "catalog_read", SystemObject, true},
		{"user:bob", "catalog_edit", SystemObject, false},
		{"user:alice", "catalog_admin", SystemObject, true},
		{"user:alice", "writer", "channel:c1", true},
		{"user:bob", "reader", "channel:c1", false},
		{"user:carol", "reader", "channel:c1", false},
	}
	for _, c := range cases {
		got, err := a.Check(ctx, c.user, c.rel, c.obj, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("check %s %s %s = %v, want %v", c.user, c.rel, c.obj, got, c.want)
		}
	}
	if err := a.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, dir, st.Ent, log)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.modelID != a.modelID {
		t.Fatalf("model rewritten on reopen: %s vs %s", reopened.modelID, a.modelID)
	}
}
