//go:build linux && !headless

package shell

import (
	"context"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/ebitengine/purego"
)

// Oldest library versions the Wails purego backend accepts per its linux_purego_lib.go report
const (
	minGTKMinor    = 8
	minWebKitMajor = 2
	minWebKitMinor = 40
)

// Inspects sockets, environment, and dlopen results without initializing GTK, WebKit, or Wails
func Detect(forceHeadless bool) Detection {
	return decideLinux(forceHeadless, linuxProbe{getenv: os.Getenv, dial: dialProbe, webview: loadWebview})
}

// Connects and closes at once to prove the endpoint accepts connections
func dialProbe(network, address string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	c, err := (&net.Dialer{}).DialContext(ctx, network, address)
	if err != nil {
		return err
	}
	return c.Close()
}

// Opens GTK 4 and WebKitGTK 6.0, checks their versions against the Wails floor, then closes both
func loadWebview() (string, error) {
	gtk, err := purego.Dlopen("libgtk-4.so.1", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return "", fmt.Errorf("libgtk-4.so.1 does not load (%w)", err)
	}
	defer func() { _ = purego.Dlclose(gtk) }()
	webkit, err := purego.Dlopen("libwebkitgtk-6.0.so.4", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return "", fmt.Errorf("libwebkitgtk-6.0.so.4 does not load (%w)", err)
	}
	defer func() { _ = purego.Dlclose(webkit) }()
	g, err := libVersion(gtk, "gtk_get_major_version", "gtk_get_minor_version", "gtk_get_micro_version")
	if err != nil {
		return "", err
	}
	w, err := libVersion(webkit, "webkit_get_major_version", "webkit_get_minor_version", "webkit_get_micro_version")
	if err != nil {
		return "", err
	}
	if g[0] != 4 || g[1] < minGTKMinor {
		return "", fmt.Errorf("GTK %d.%d.%d is older than 4.%d", g[0], g[1], g[2], minGTKMinor)
	}
	if w[0] < minWebKitMajor || (w[0] == minWebKitMajor && w[1] < minWebKitMinor) {
		return "", fmt.Errorf("WebKitGTK %d.%d.%d is older than %d.%d", w[0], w[1], w[2], minWebKitMajor, minWebKitMinor)
	}
	return fmt.Sprintf("GTK %d.%d.%d with WebKitGTK %d.%d.%d", g[0], g[1], g[2], w[0], w[1], w[2]), nil
}

// Calls the three guint version getters of a loaded library
func libVersion(lib uintptr, names ...string) ([3]uint32, error) {
	var v [3]uint32
	for i, name := range names {
		sym, err := purego.Dlsym(lib, name)
		if err != nil {
			return v, fmt.Errorf("symbol %s is missing (%w)", name, err)
		}
		var get func() uint32
		purego.RegisterFunc(&get, sym)
		v[i] = get()
	}
	return v, nil
}
