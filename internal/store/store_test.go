package store

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateTwiceAndSnapshot(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	s, err := Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	first, err := s.Migrate(ctx, "test")
	if err != nil {
		t.Fatal(err)
	}
	if first.Applied != 1 || first.Snapshot != "" {
		t.Fatalf("first migrate = %+v", first)
	}
	second, err := s.Migrate(ctx, "test")
	if err != nil {
		t.Fatal(err)
	}
	if second.Applied != 0 {
		t.Fatalf("second migrate = %+v", second)
	}
	if _, err := s.Ent.User.Query().Count(ctx); err != nil {
		t.Fatal(err)
	}
	snap := filepath.Join(dir, "snap.db")
	if err := s.Snapshot(ctx, snap); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(snap); err != nil || st.Size() == 0 {
		t.Fatalf("snapshot missing: %v", err)
	}
}
