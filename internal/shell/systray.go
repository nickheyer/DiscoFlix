//go:build (linux || windows) && !headless

package shell

import (
	"context"
	"fmt"
	"runtime"
	"time"

	"fyne.io/systray"
)

// Longest wait for the tray to register before the native loop is ended directly
const trayReadyTimeout = 5 * time.Second

// Runs a fyne systray icon whose click opens the browser until Quit is picked or ctx ends
func runTray(ctx context.Context, o Options) error {
	if err := trayPreflight(); err != nil {
		return fmt.Errorf("shell: tray mode cannot start because %w", err)
	}
	icon, err := trayIcon(o.IconPNG)
	if err != nil {
		return fmt.Errorf("shell: tray icon %w", err)
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	loop := loopThread()
	ready := make(chan struct{})
	done := make(chan struct{})
	onReady := func() {
		systray.SetIcon(icon)
		systray.SetTitle(o.AppName)
		systray.SetTooltip(tooltip(o))
		systray.SetOnTapped(o.OnOpenWeb)
		openWeb := systray.AddMenuItem("Open in browser", "Open "+o.AppName+" in the default browser")
		check := systray.AddMenuItem("Check for updates", "Look for a newer "+o.AppName+" release")
		systray.AddSeparator()
		quit := systray.AddMenuItem("Quit", "Stop "+o.AppName)
		close(ready)
		go func() {
			for {
				select {
				case <-openWeb.ClickedCh:
					o.OnOpenWeb()
				case <-check.ClickedCh:
					o.OnCheckUpdate()
				case <-quit.ClickedCh:
					o.OnQuit()
					systray.Quit()
					return
				case <-done:
					return
				}
			}
		}()
	}
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
			return
		}
		select {
		case <-ready:
			systray.Quit()
		case <-done:
		case <-time.After(trayReadyTimeout):
			endTrayLoop(loop)
		}
	}()
	systray.Run(onReady, nil)
	close(done)
	return nil
}
