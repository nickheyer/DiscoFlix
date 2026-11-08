package svc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTrayAutostartLifecycle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	cfg := TrayConfig{Executable: "/opt/discoflix/discoflix", URL: "http://127.0.0.1:5001/", DataDir: "/var/lib/discoflix"}
	if err := InstallTrayAutostart(TrayConfig{Executable: "x", URL: "ftp://nope", DataDir: "d"}); err == nil {
		t.Fatal("bad url accepted")
	}
	if err := InstallTrayAutostart(cfg); err != nil {
		t.Fatal(err)
	}
	ok, err := TrayAutostartInstalled()
	if err != nil || !ok {
		t.Fatalf("installed = %v, %v", ok, err)
	}
	data, err := os.ReadFile(filepath.Join(home, ".config", "autostart", trayDesktopFile))
	if err != nil {
		t.Fatal(err)
	}
	want := `Exec="/opt/discoflix/discoflix" "tray" "--hidden" "--url" "http://127.0.0.1:5001/" "--data-dir" "/var/lib/discoflix"`
	if !strings.Contains(string(data), want) {
		t.Fatalf("desktop entry = %s", data)
	}
	if err := UninstallTrayAutostart(); err != nil {
		t.Fatal(err)
	}
	if ok, _ := TrayAutostartInstalled(); ok {
		t.Fatal("still installed")
	}
	if err := UninstallTrayAutostart(); err != nil {
		t.Fatal("second uninstall failed", err)
	}
}
