// Picks and runs the desktop surface for the DiscoFlix process
package shell

import "log/slog"

// User interface surface the process runs
type Mode int

const (
	ModeHeadless Mode = iota // no UI at all
	ModeTray                 // tray icon whose menu opens the web UI in the default browser
	ModeWindow               // tray icon plus a native window hosting the web UI
)

// Names the mode for logs and errors
func (m Mode) String() string {
	switch m {
	case ModeHeadless:
		return "headless"
	case ModeTray:
		return "tray"
	case ModeWindow:
		return "window"
	}
	return "unknown"
}

// Chosen mode with the one sentence that explains the choice
type Detection struct {
	Mode   Mode
	Reason string
}

// Tray and window settings supplied by the main program
type Options struct {
	AppName       string
	URL           string // loopback URL with a one-time token the window loads
	IconPNG       []byte
	Version       string
	OnOpenWeb     func() // tray Open in browser item
	OnCheckUpdate func() // tray Check for updates item
	OnQuit        func() // user picked Quit, returns once the server has stopped
	Logger        *slog.Logger
	StartHidden   bool // window mode starts in the tray without showing the window
}
