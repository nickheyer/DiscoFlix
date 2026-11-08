package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/pflag"
)

func TestLoadLayers(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("server:\n  addr: \":7000\"\nlog:\n  level: debug\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DISCOFLIX_DATA_DIR", dir)
	t.Setenv("DISCOFLIX_SERVER_PUBLIC_URL", "https://flix.example")
	fs := pflag.NewFlagSet("test", pflag.ContinueOnError)
	Flags(fs)
	if err := fs.Parse([]string{"--log-level", "warn", "--headless"}); err != nil {
		t.Fatal(err)
	}
	c, err := Load(fs)
	if err != nil {
		t.Fatal(err)
	}
	if c.DataDir != dir || c.Addr != ":7000" || c.PublicURL != "https://flix.example" || c.LogLevel != "warn" || !c.Headless {
		t.Fatalf("config = %+v", c)
	}
}
