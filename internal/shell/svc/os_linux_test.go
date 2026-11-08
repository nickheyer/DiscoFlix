package svc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kardianos/service"
)

// Systemd backend forced on so the test runs on any Linux host
type forcedSystemd struct{ service.System }

// Always selects the wrapped systemd backend
func (forcedSystemd) Detect() bool { return true }

// Fake systemctl that logs every call and reports state from files beside it
const fakeSystemctl = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case "$1" in
--version) echo "systemd 257" ;;
is-active) state=$(cat "$dir/state" 2>/dev/null || echo inactive); echo "$state"; [ "$state" = active ] || exit 3 ;;
list-unit-files) [ -f "$HOME/.config/systemd/user/discoflix.service" ] && echo "discoflix.service enabled enabled" ;;
esac
exit 0
`

func TestUserSystemdLifecycle(t *testing.T) {
	var systemd service.System
	for _, s := range service.AvailableSystems() {
		if s.String() == "linux-systemd" {
			systemd = s
		}
	}
	if systemd == nil {
		t.Fatal("kardianos registered no linux-systemd backend")
	}
	registry := service.AvailableSystems()
	service.ChooseSystem(forcedSystemd{systemd})
	t.Cleanup(func() { service.ChooseSystem(registry...) })

	tmp := t.TempDir()
	bin, home := filepath.Join(tmp, "bin"), filepath.Join(tmp, "home")
	for _, d := range []string{bin, home} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(fakeSystemctl), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	data := filepath.Join(tmp, "data dir")
	cfg := Config{DataDir: data, User: true, Executable: exe}

	if st, err := Status(cfg); err != nil || st != StateNotInstalled {
		t.Fatalf("fresh status %v, %v", st, err)
	}
	if err := Install(cfg); err != nil {
		t.Fatalf("install: %v", err)
	}
	unit, err := os.ReadFile(filepath.Join(home, ".config/systemd/user/discoflix.service"))
	if err != nil {
		t.Fatalf("unit file: %v", err)
	}
	for _, want := range []string{
		"ExecStart=" + exe + ` "serve" "--headless" "--data-dir" "` + data + `"`,
		"WorkingDirectory=" + data + "\n",
		"Restart=on-failure",
		"WantedBy=default.target",
		"Description=" + Description,
	} {
		if !strings.Contains(string(unit), want) {
			t.Errorf("unit lacks %q\n%s", want, unit)
		}
	}
	if strings.Contains(string(unit), "network-online") {
		t.Errorf("user unit depends on a system target\n%s", unit)
	}
	if fi, err := os.Stat(data); err != nil || !fi.IsDir() {
		t.Fatalf("data dir not created: %v", err)
	}
	if st, err := Status(cfg); err != nil || st != StateStopped {
		t.Fatalf("installed status %v, %v", st, err)
	}
	if err := Install(cfg); err == nil {
		t.Fatal("second install succeeded")
	}
	if err := os.WriteFile(filepath.Join(bin, "state"), []byte("active"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st, err := Status(cfg); err != nil || st != StateRunning {
		t.Fatalf("running status %v, %v", st, err)
	}
	if err := os.WriteFile(filepath.Join(bin, "state"), []byte("failed"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st, err := Status(cfg); err != nil || st != StateStopped {
		t.Fatalf("failed unit status %v, %v", st, err)
	}
	if err := os.WriteFile(filepath.Join(bin, "state"), []byte("active"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(cfg); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".config/systemd/user/discoflix.service")); !os.IsNotExist(err) {
		t.Fatalf("unit file survived uninstall: %v", err)
	}
	calls, _ := os.ReadFile(filepath.Join(bin, "calls"))
	for _, want := range []string{"enable --user discoflix.service", "daemon-reload --user", "stop --user discoflix.service", "disable --user discoflix.service"} {
		if !strings.Contains(string(calls), want) {
			t.Errorf("systemctl never ran %q\n%s", want, calls)
		}
	}
}

func TestStartedByManagerReadsCgroup(t *testing.T) {
	if startedByManager() {
		t.Fatal("test binary claims to run inside discoflix.service")
	}
}
