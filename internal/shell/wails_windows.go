//go:build windows && !headless

package shell

import "errors"

// Windows needs no extra application hooks
func (s *wailsShell) platformSetup() {}

// Quits through Wails so the message loop ends and Run returns
func (s *wailsShell) platformStop() {
	s.app.Quit()
}

// Fails when no WebView2 runtime is installed, which Wails would report as a fatal dialog
func windowPreflight() error {
	version, err := installedWebView2()
	if err != nil {
		return err
	}
	if version == "" {
		return errors.New("the WebView2 runtime is not installed")
	}
	return nil
}

// The Windows notification area always hosts tray icons
func (s *wailsShell) trayHostPresent() bool {
	return true
}
