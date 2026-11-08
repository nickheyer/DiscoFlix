package svc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const trayDesktopFile = "discoflix-tray.desktop"

func trayDesktopPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("svc: config dir: %w", err)
	}
	return filepath.Join(dir, "autostart", trayDesktopFile), nil
}

// InstallTrayAutostart writes an XDG autostart entry that opens the tray at login
func InstallTrayAutostart(cfg TrayConfig) error {
	if err := validateTray(cfg); err != nil {
		return err
	}
	exe, err := trayExecutable(cfg)
	if err != nil {
		return err
	}
	path, err := trayDesktopPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("svc: autostart dir: %w", err)
	}
	parts := []string{quoteArg(exe)}
	for _, a := range trayArgs(cfg) {
		parts = append(parts, quoteArg(a))
	}
	entry := "[Desktop Entry]\nType=Application\nName=DiscoFlix\nComment=DiscoFlix tray\nExec=" + strings.Join(parts, " ") +
		"\nIcon=discoflix\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
	if err := os.WriteFile(path, []byte(entry), 0o600); err != nil {
		return fmt.Errorf("svc: write autostart entry: %w", err)
	}
	return nil
}

// UninstallTrayAutostart removes the XDG autostart entry
func UninstallTrayAutostart() error {
	path, err := trayDesktopPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("svc: remove autostart entry: %w", err)
	}
	return nil
}

// TrayAutostartInstalled reports whether the XDG autostart entry exists
func TrayAutostartInstalled() (bool, error) {
	path, err := trayDesktopPath()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
