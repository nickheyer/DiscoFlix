//go:build !headless

package shell

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Wails application, its optional window, and the tray that controls them
type wailsShell struct {
	o         Options
	app       *application.App
	win       *application.WebviewWindow
	tray      *application.SystemTray
	stopping  atomic.Bool
	quitOnce  sync.Once
	startOnce sync.Once
	started   chan struct{}
}

// Runs a Wails tray, plus a webview window on o.URL when window is true, until quit or ctx ends
func runWails(ctx context.Context, o Options, window bool) error {
	s := &wailsShell{o: o, started: make(chan struct{})}
	s.app = application.New(application.Options{
		Name:                        o.AppName,
		Description:                 o.AppName + " " + o.Version,
		Icon:                        o.IconPNG,
		Logger:                      o.Logger,
		DisableDefaultSignalHandler: true,
		ShouldQuit:                  s.terminateRequested,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
			ActivationPolicy: activationPolicy(window),
		},
		Windows: application.WindowsOptions{DisableQuitOnLastWindowClosed: true},
		Linux:   application.LinuxOptions{DisableQuitOnLastWindowClosed: true, ApplicationID: applicationID(o.AppName)},
	})
	menu := application.NewMenu()
	if window {
		s.win = s.app.Window.NewWithOptions(application.WebviewWindowOptions{
			Name:      "main",
			Title:     o.AppName,
			Width:     1280,
			Height:    800,
			MinWidth:  360,
			MinHeight: 480,
			URL:       o.URL,
			Hidden:    o.StartHidden,
		})
		s.win.RegisterHook(events.Common.WindowClosing, s.closeToTray)
		menu.Add("Open " + o.AppName).OnClick(func(*application.Context) { s.showWindow() })
	}
	menu.Add("Open in browser").OnClick(func(*application.Context) { o.OnOpenWeb() })
	menu.Add("Check for updates").OnClick(func(*application.Context) { o.OnCheckUpdate() })
	menu.AddSeparator()
	menu.Add("Quit").OnClick(func(*application.Context) { s.userQuit() })
	s.tray = s.app.SystemTray.New()
	s.tray.SetIcon(o.IconPNG)
	s.tray.SetTooltip(tooltip(o))
	s.tray.SetMenu(menu)
	if window {
		s.tray.AttachWindow(s.win)
	}
	s.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		s.startOnce.Do(func() { close(s.started) })
	})
	s.platformSetup()
	done := make(chan struct{})
	go s.watch(ctx, done)
	err := s.app.Run()
	close(done)
	return err
}

// Stops the UI once ctx ends, waiting for the native loop to be live first
func (s *wailsShell) watch(ctx context.Context, done <-chan struct{}) {
	select {
	case <-ctx.Done():
	case <-done:
		return
	}
	select {
	case <-s.started:
	case <-done:
		return
	}
	s.stop()
}

// Calls OnQuit once and then stops the UI
func (s *wailsShell) userQuit() {
	s.quitOnce.Do(s.o.OnQuit)
	s.stop()
}

// Marks the shell as stopping and ends the native loop exactly once
func (s *wailsShell) stop() {
	if s.stopping.Swap(true) {
		return
	}
	s.platformStop()
}

// Treats an OS quit request such as logoff or Cmd+Q as the user picking Quit
func (s *wailsShell) terminateRequested() bool {
	if !s.stopping.Swap(true) {
		s.quitOnce.Do(s.o.OnQuit)
	}
	return true
}

// Turns the window close button into hide to tray, or minimise when no tray host exists
func (s *wailsShell) closeToTray(e *application.WindowEvent) {
	if s.stopping.Load() {
		return
	}
	e.Cancel()
	if s.trayHostPresent() {
		s.win.Hide()
		return
	}
	s.win.Minimise()
}

// Restores, shows, and focuses the window
func (s *wailsShell) showWindow() {
	if s.win.IsMinimised() {
		s.win.UnMinimise()
	}
	s.win.Show()
	s.win.Focus()
}

// Dock icon and app switcher entry only when a window exists
func activationPolicy(window bool) application.ActivationPolicy {
	if window {
		return application.ActivationPolicyRegular
	}
	return application.ActivationPolicyAccessory
}

// GTK application id built from the app name so Wayland matches the desktop entry
func applicationID(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r == '_' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	elem := b.String()
	if elem == "" || (elem[0] >= '0' && elem[0] <= '9') {
		elem = "_" + elem
	}
	return "io.github.nickheyer." + elem
}
