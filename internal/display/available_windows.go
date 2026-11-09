//go:build windows

package display

import (
	"errors"
	"fmt"

	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// Available needs an interactive session and the WebView2 runtime
func Available() error {
	service, err := svc.IsWindowsService()
	if err != nil {
		return fmt.Errorf("service check failed: %w", err)
	}
	if service {
		return errors.New("the process runs as a Windows service")
	}
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		return fmt.Errorf("session lookup failed: %w", err)
	}
	if session == 0 {
		return errors.New("session 0 has no interactive desktop")
	}
	version, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString("")
	if err != nil {
		return fmt.Errorf("WebView2 runtime lookup failed: %w", err)
	}
	if version == "" {
		return errors.New("the WebView2 runtime is not installed, get it from https://developer.microsoft.com/microsoft-edge/webview2/")
	}
	return nil
}
