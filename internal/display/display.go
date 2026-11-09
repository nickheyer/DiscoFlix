// Package display names the display modes and runs the desktop window
package display

import (
	"fmt"
	"log/slog"
)

// Mode is how the UI is reached
type Mode string

const (
	Auto    Mode = "auto"    // the choice saved in the app, else all, falling back on error
	All     Mode = "all"     // server on the configured address plus the window
	Desktop Mode = "desktop" // server on loopback only plus the window
	Web     Mode = "web"     // server on the configured address, no window
)

// SettingKey holds the choice saved in the app that auto honours
const SettingKey = "display"

// Parse accepts the four mode names
func Parse(s string) (Mode, error) {
	switch m := Mode(s); m {
	case Auto, All, Desktop, Web:
		return m, nil
	}
	return "", fmt.Errorf("display %q is not auto, all, desktop, or web", s)
}

// Window reports whether the mode opens the desktop window
func (m Mode) Window() bool { return m == All || m == Desktop }

// Loopback reports whether the mode keeps the server off the network
func (m Mode) Loopback() bool { return m == Desktop }

// Options describe the window
type Options struct {
	URL    string // page the window opens
	Title  string
	Icon   []byte // PNG
	Logger *slog.Logger
	OnQuit func() // stops the server before the window closes for good
}
