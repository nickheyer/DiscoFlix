package svc

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// TrayConfig describes the per-user tray entry started at login
type TrayConfig struct {
	Executable string // binary to run, empty for the running executable
	URL        string // server address the tray opens
	DataDir    string // data directory passed through for the update trust cache
}

// trayArgs are the arguments the login entry starts the tray with
func trayArgs(cfg TrayConfig) []string {
	return []string{"tray", "--hidden", "--url", cfg.URL, "--data-dir", cfg.DataDir}
}

func trayExecutable(cfg TrayConfig) (string, error) {
	if cfg.Executable != "" {
		return cfg.Executable, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("svc: locate executable: %w", err)
	}
	return exe, nil
}

func validateTray(cfg TrayConfig) error {
	switch {
	case !strings.HasPrefix(cfg.URL, "http://") && !strings.HasPrefix(cfg.URL, "https://"):
		return errors.New("svc: tray URL must start with http:// or https://")
	case cfg.DataDir == "":
		return errors.New("svc: tray data directory is empty")
	}
	return nil
}

// quoteArg wraps an argument in double quotes for desktop entries and registry commands
func quoteArg(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}
