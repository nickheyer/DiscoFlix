// Package telemetry configures logging and runtime diagnostics
package telemetry

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/lmittmann/tint"
	"golang.org/x/term"
)

// NewLogger returns a colour handler on terminals and JSON everywhere else
func NewLogger(level, format string, w io.Writer) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	if format == "" {
		format = "json"
		if f, ok := w.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
			format = "text"
		}
	}
	var h slog.Handler
	if format == "text" {
		h = tint.NewTextHandler(w, &tint.Options{Level: lvl, TimeFormat: time.Kitchen})
	} else {
		h = slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl})
	}
	return slog.New(h)
}
