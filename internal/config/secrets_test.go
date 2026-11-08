package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSecretsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenSecrets(dir)
	if err != nil {
		t.Fatal(err)
	}
	v, err := s.GetOrCreate("pepper", func() (string, error) { return "p1", nil })
	if err != nil || v != "p1" {
		t.Fatal(err, v)
	}
	if err := s.Set("token", "t1"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, secretsFile))
	if len(raw) == 0 || string(raw[:len("age-encryption")]) != "age-encryption" {
		t.Fatalf("secrets file not encrypted: %q", raw)
	}
	again, err := OpenSecrets(dir)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := again.Get("token"); !ok || v != "t1" {
		t.Fatal("secret lost")
	}
	if v, _ := again.GetOrCreate("pepper", func() (string, error) { return "p2", nil }); v != "p1" {
		t.Fatal("pepper regenerated")
	}
	st, _ := os.Stat(filepath.Join(dir, keyFile))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", st.Mode().Perm())
	}
}
