package svc

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	runKeyPath   = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValueName = "DiscoFlix"
)

// InstallTrayAutostart registers the tray under the current user's Run key
func InstallTrayAutostart(cfg TrayConfig) error {
	if err := validateTray(cfg); err != nil {
		return err
	}
	exe, err := trayExecutable(cfg)
	if err != nil {
		return err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("svc: open Run key: %w", err)
	}
	defer func() { _ = key.Close() }()
	parts := []string{quoteArg(exe)}
	for _, a := range trayArgs(cfg) {
		parts = append(parts, quoteArg(a))
	}
	if err := key.SetStringValue(runValueName, strings.Join(parts, " ")); err != nil {
		return fmt.Errorf("svc: write Run value: %w", err)
	}
	return nil
}

// UninstallTrayAutostart removes the Run key value
func UninstallTrayAutostart() error {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("svc: open Run key: %w", err)
	}
	defer func() { _ = key.Close() }()
	if err := key.DeleteValue(runValueName); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return fmt.Errorf("svc: delete Run value: %w", err)
	}
	return nil
}

// TrayAutostartInstalled reports whether the Run key value exists
func TrayAutostartInstalled() (bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("svc: open Run key: %w", err)
	}
	defer func() { _ = key.Close() }()
	_, _, err = key.GetStringValue(runValueName)
	if errors.Is(err, registry.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
