//go:build linux && !headless

package shell

import "github.com/godbus/dbus/v5"

// Linux needs no extra application hooks
func (s *wailsShell) platformSetup() {}

// Quits through Wails so GApplication tears down windows and the tray before Run returns
func (s *wailsShell) platformStop() {
	s.app.Quit()
}

// Fails when GTK 4 or WebKitGTK 6.0 cannot load, which would make Wails exit the process
func windowPreflight() error {
	_, err := loadWebview()
	return err
}

// Reports whether a StatusNotifierWatcher currently owns its bus name
func (s *wailsShell) trayHostPresent() bool {
	conn, err := privateSessionBus()
	if err != nil {
		return false
	}
	defer func() { _ = conn.Close() }()
	var owned bool
	call := conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher")
	return call.Store(&owned) == nil && owned
}

// Opens an authenticated private session bus connection without launching a bus daemon
func privateSessionBus() (*dbus.Conn, error) {
	conn, err := dbus.SessionBusPrivateNoAutoStartup()
	if err != nil {
		return nil, err
	}
	if err := conn.Auth(nil); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := conn.Hello(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}
