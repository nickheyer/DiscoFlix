//go:build !windows

package update

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReplaceExecutableKeepsModeAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "discoflix")
	if err := os.WriteFile(path, []byte("old"), 0o751); err != nil {
		t.Fatal(err)
	}
	if err := replaceExecutable(path, strings.NewReader("new")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "new" {
		t.Fatalf("content %q, %v", got, err)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o751 {
		t.Fatalf("mode %v, want 0751", fi.Mode().Perm())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("leftover files %v", entries)
	}
}
