//go:build linux

package display

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ebitengine/purego"
)

// Library the Wails GTK3 backend loads, which brings GTK 3 and GLib with it
const webkitLib = "libwebkit2gtk-4.1.so.0"

// Available needs a reachable Wayland or X11 display and WebKit2GTK 4.1 with GTK 3
func Available() error {
	if err := displayReachable(); err != nil {
		return err
	}
	lib, err := purego.Dlopen(webkitLib, purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return fmt.Errorf("%s does not load (%w), install webkit2gtk-4.1 on Arch, libwebkit2gtk-4.1-0 on Debian and Ubuntu, or webkit2gtk4.1 on Fedora", webkitLib, err)
	}
	_ = purego.Dlclose(lib)
	return nil
}

// displayReachable connects to the Wayland or X11 socket named by the environment so GTK cannot exit the process over a stale one
func displayReachable() error {
	if name := os.Getenv("WAYLAND_DISPLAY"); name != "" {
		sock := name
		if !filepath.IsAbs(sock) {
			sock = filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), name)
		}
		if dial(sock) == nil {
			return nil
		}
	}
	if d := os.Getenv("DISPLAY"); d != "" {
		_, num, _ := strings.Cut(d, ":")
		num, _, _ = strings.Cut(num, ".")
		if n, err := strconv.Atoi(num); err == nil && (dial("/tmp/.X11-unix/X"+num) == nil || dial("@/tmp/.X11-unix/X"+strconv.Itoa(n)) == nil) {
			return nil
		}
		return fmt.Errorf("DISPLAY %s has no reachable X11 socket", d)
	}
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		return fmt.Errorf("WAYLAND_DISPLAY %s has no reachable socket", os.Getenv("WAYLAND_DISPLAY"))
	}
	return errors.New("neither WAYLAND_DISPLAY nor DISPLAY is set")
}

// dial connects to a unix socket and closes it at once
func dial(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	c, err := (&net.Dialer{}).DialContext(ctx, "unix", path) //nolint:gosec // the socket is named by the login session environment
	if err != nil {
		return err
	}
	return c.Close()
}
