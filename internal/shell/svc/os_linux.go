package svc

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/kardianos/service"
)

// Unit with on-failure restarts whose install target matches the system or user manager
const systemdUnit = `[Unit]
Description={{Description}}
StartLimitIntervalSec=300
StartLimitBurst=10
{{range Dependencies}}{{.}}
{{end}}
[Service]
Type=simple
ExecStart={{Path | cmdEscape}}{{range Arguments}} {{. | cmd}}{{end}}
WorkingDirectory={{WorkingDirectory}}
Restart={{Restart}}
RestartSec=5
TimeoutStopSec=90
KillMode=mixed

[Install]
WantedBy=%s
`

// Builds a systemd backed manager and refuses init systems DiscoFlix does not install into
func newManager(cfg Config) (manager, error) {
	if p := service.Platform(); p != "linux-systemd" {
		return nil, fmt.Errorf("svc: DiscoFlix installs services through systemd but this host uses %q", p)
	}
	target, deps := "multi-user.target", []string{"After=network-online.target", "Wants=network-online.target"}
	if cfg.User {
		target, deps = "default.target", nil
	}
	opts := service.KeyValue{
		"UserService":   cfg.User,
		"Restart":       "on-failure",
		"SystemdScript": fmt.Sprintf(systemdUnit, target),
	}
	return newKardianos(cfg, opts, deps, nil)
}

// Reports whether the process runs inside the discoflix.service cgroup of the system or user manager
func startedByManager() bool {
	f, err := os.Open("/proc/self/cgroup")
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasSuffix(sc.Text(), "/"+Name+".service") {
			return true
		}
	}
	return false
}
