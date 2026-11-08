package svc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const trayAgentLabel = "com.discoflix.tray"

func trayAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("svc: home dir: %w", err)
	}
	return filepath.Join(home, "Library", "LaunchAgents", trayAgentLabel+".plist"), nil
}

func plistString(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

// InstallTrayAutostart writes and loads a LaunchAgent that opens the tray at login
func InstallTrayAutostart(cfg TrayConfig) error {
	if err := validateTray(cfg); err != nil {
		return err
	}
	exe, err := trayExecutable(cfg)
	if err != nil {
		return err
	}
	path, err := trayAgentPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("svc: LaunchAgents dir: %w", err)
	}
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n")
	b.WriteString("\t<key>Label</key>\n\t<string>" + trayAgentLabel + "</string>\n")
	b.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>" + plistString(exe) + "</string>\n")
	for _, a := range trayArgs(cfg) {
		b.WriteString("\t\t<string>" + plistString(a) + "</string>\n")
	}
	b.WriteString("\t</array>\n\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>ProcessType</key>\n\t<string>Interactive</string>\n</dict>\n</plist>\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return fmt.Errorf("svc: write LaunchAgent: %w", err)
	}
	if out, err := exec.CommandContext(context.Background(), "launchctl", "load", "-w", path).CombinedOutput(); err != nil {
		return fmt.Errorf("svc: launchctl load: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// UninstallTrayAutostart unloads and removes the LaunchAgent
func UninstallTrayAutostart() error {
	path, err := trayAgentPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if out, err := exec.CommandContext(context.Background(), "launchctl", "unload", "-w", path).CombinedOutput(); err != nil {
		return fmt.Errorf("svc: launchctl unload: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("svc: remove LaunchAgent: %w", err)
	}
	return nil
}

// TrayAutostartInstalled reports whether the LaunchAgent plist exists
func TrayAutostartInstalled() (bool, error) {
	path, err := trayAgentPath()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
