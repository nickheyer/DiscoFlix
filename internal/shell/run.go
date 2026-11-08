//go:build !headless

package shell

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
)

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// Runs the UI for the detected mode on the calling goroutine until the user quits or ctx ends
func Run(ctx context.Context, d Detection, o Options) error {
	switch d.Mode {
	case ModeHeadless:
		return nil
	case ModeTray, ModeWindow:
	default:
		return fmt.Errorf("shell: unknown mode %d", d.Mode)
	}
	if err := o.validate(d.Mode); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil //nolint:nilerr // a cancelled context before start is a clean no-op, not a failure
	}
	if d.Mode == ModeTray {
		return runTray(ctx, o)
	}
	if err := windowPreflight(); err != nil {
		return fmt.Errorf("shell: window mode cannot start because %w", err)
	}
	return runWails(ctx, o, true)
}

// Rejects options the chosen mode would otherwise trip over at runtime
func (o Options) validate(m Mode) error {
	switch {
	case o.AppName == "":
		return errors.New("shell: Options.AppName is empty")
	case o.Logger == nil:
		return errors.New("shell: Options.Logger is nil")
	case o.OnOpenWeb == nil || o.OnCheckUpdate == nil || o.OnQuit == nil:
		return errors.New("shell: Options.OnOpenWeb, OnCheckUpdate, and OnQuit are all required")
	case len(o.IconPNG) < 24 || !bytes.HasPrefix(o.IconPNG, pngSignature):
		return errors.New("shell: Options.IconPNG is not a PNG image")
	}
	if m != ModeWindow {
		return nil
	}
	u, err := url.Parse(o.URL)
	if err != nil {
		return fmt.Errorf("shell: Options.URL is invalid: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("shell: Options.URL scheme %q is not http or https", u.Scheme)
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("shell: Options.URL host %q is not a loopback address", host)
	}
	return nil
}

// Tray hover text naming the app and its version
func tooltip(o Options) string {
	if o.Version == "" {
		return o.AppName
	}
	return o.AppName + " " + o.Version
}
