//go:build darwin && !headless

package shell

import (
	"context"

	"github.com/ebitengine/purego/objc"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// NSEventTypeApplicationDefined from AppKit NSEvent.h
const nsEventTypeApplicationDefined = 15

// NSPoint passed by value to otherEventWithType
type cgPoint struct {
	X, Y float64
}

// Shows the window when the Dock icon is clicked while it is hidden
func (s *wailsShell) platformSetup() {
	if s.win == nil {
		return
	}
	s.app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
		s.showWindow()
	})
}

// Hides the UI and stops NSApp run so Run returns instead of AppKit calling exit
func (s *wailsShell) platformStop() {
	if s.win != nil {
		s.win.Hide()
	}
	s.tray.Destroy()
	application.InvokeSync(stopEventLoop)
}

// Requests NSApp stop and posts an empty event so the run loop wakes and returns
func stopEventLoop() {
	app := objc.ID(objc.GetClass("NSApplication")).Send(objc.RegisterName("sharedApplication"))
	app.Send(objc.RegisterName("stop:"), objc.ID(0))
	evt := objc.ID(objc.GetClass("NSEvent")).Send(
		objc.RegisterName("otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:"),
		uint(nsEventTypeApplicationDefined), cgPoint{}, uint(0), float64(0), int(0), objc.ID(0), int16(0), int(0), int(0),
	)
	app.Send(objc.RegisterName("postEvent:atStart:"), evt, true)
}

// WebKit ships with every macOS release so the window always has a webview
func windowPreflight() error {
	return nil
}

// The macOS menu bar always hosts status items
func (s *wailsShell) trayHostPresent() bool {
	return true
}

// Runs a menu bar icon through Wails because fyne systray needs cgo on macOS
func runTray(ctx context.Context, o Options) error {
	return runWails(ctx, o, false)
}
