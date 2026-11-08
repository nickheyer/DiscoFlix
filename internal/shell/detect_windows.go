//go:build windows && !headless

package shell

import (
	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// Inspects the service state, session, and WebView2 registry entries without creating windows
func Detect(forceHeadless bool) Detection {
	return decideWindows(forceHeadless, windowsProbe{
		isService: svc.IsWindowsService,
		sessionID: currentSessionID,
		webview2:  installedWebView2,
	})
}

// Returns the terminal services session the process runs in
func currentSessionID() (uint32, error) {
	var id uint32
	err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &id)
	return id, err
}

// Returns the installed WebView2 runtime version or an empty string when none is installed
func installedWebView2() (string, error) {
	return webviewloader.GetAvailableCoreWebView2BrowserVersionString("")
}
