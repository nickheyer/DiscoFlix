//go:build !headless

package shell

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

// Fake Linux session built from environment variables and the endpoints that accept connections
type fakeLinux struct {
	env     map[string]string
	open    []string
	webview error
}

// Wraps the fake session in the function set decideLinux consumes
func (f fakeLinux) probe() linuxProbe {
	return linuxProbe{
		getenv: func(k string) string { return f.env[k] },
		dial: func(network, address string) error {
			if slices.Contains(f.open, network+" "+address) {
				return nil
			}
			return errors.New("connection refused")
		},
		webview: func() (string, error) {
			if f.webview != nil {
				return "", f.webview
			}
			return "GTK 4.18.0 with WebKitGTK 2.50.0", nil
		},
	}
}

var errNoWebKit = errors.New("libwebkitgtk-6.0.so.4 does not load")

func TestDecideLinux(t *testing.T) {
	tests := []struct {
		name   string
		force  bool
		env    fakeLinux
		mode   Mode
		reason string
	}{
		{
			name:   "forced headless wins over a working desktop",
			force:  true,
			env:    fakeLinux{env: map[string]string{"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": "/run/user/1000"}, open: []string{"unix /run/user/1000/wayland-0"}},
			mode:   ModeHeadless,
			reason: "--headless",
		},
		{
			name:   "no display variables",
			env:    fakeLinux{env: map[string]string{}},
			mode:   ModeHeadless,
			reason: "neither WAYLAND_DISPLAY nor DISPLAY is set",
		},
		{
			name:   "wayland socket with webview libraries",
			env:    fakeLinux{env: map[string]string{"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": "/run/user/1000"}, open: []string{"unix /run/user/1000/wayland-0"}},
			mode:   ModeWindow,
			reason: "Wayland display /run/user/1000/wayland-0",
		},
		{
			name:   "absolute wayland socket path",
			env:    fakeLinux{env: map[string]string{"WAYLAND_DISPLAY": "/tmp/wl.sock"}, open: []string{"unix /tmp/wl.sock"}},
			mode:   ModeWindow,
			reason: "Wayland display /tmp/wl.sock",
		},
		{
			name:   "relative wayland name without runtime dir",
			env:    fakeLinux{env: map[string]string{"WAYLAND_DISPLAY": "wayland-0"}},
			mode:   ModeHeadless,
			reason: "XDG_RUNTIME_DIR is unset",
		},
		{
			name:   "stale wayland socket falls through to local X11",
			env:    fakeLinux{env: map[string]string{"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": "/run/user/1000", "DISPLAY": ":0"}, open: []string{"unix /tmp/.X11-unix/X0"}},
			mode:   ModeWindow,
			reason: "X11 display :0",
		},
		{
			name:   "X11 abstract socket only",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":1.0"}, open: []string{"unix @/tmp/.X11-unix/X1"}},
			mode:   ModeWindow,
			reason: "X11 display :1.0",
		},
		{
			name:   "X11 socket missing",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0"}},
			mode:   ModeHeadless,
			reason: "/tmp/.X11-unix/X0",
		},
		{
			name:   "SSH forwarded display",
			env:    fakeLinux{env: map[string]string{"DISPLAY": "localhost:10.0", "SSH_CONNECTION": "10.0.0.2 51234 10.0.0.5 22"}, open: []string{"tcp localhost:6010"}},
			mode:   ModeHeadless,
			reason: "forwarded over SSH",
		},
		{
			name:   "SSH client variable alone marks forwarding",
			env:    fakeLinux{env: map[string]string{"DISPLAY": "localhost:11", "SSH_CLIENT": "10.0.0.2 51234 22"}, open: []string{"tcp localhost:6011"}},
			mode:   ModeHeadless,
			reason: "forwarded over SSH",
		},
		{
			name:   "local display inside an SSH session",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0", "SSH_CONNECTION": "10.0.0.2 51234 10.0.0.5 22"}, open: []string{"unix /tmp/.X11-unix/X0"}},
			mode:   ModeWindow,
			reason: "X11 display :0",
		},
		{
			name:   "remote X server over TCP without SSH",
			env:    fakeLinux{env: map[string]string{"DISPLAY": "192.168.1.5:0"}, open: []string{"tcp 192.168.1.5:6000"}},
			mode:   ModeWindow,
			reason: "X11 display 192.168.1.5:0",
		},
		{
			name:   "malformed DISPLAY",
			env:    fakeLinux{env: map[string]string{"DISPLAY": "garbage"}},
			mode:   ModeHeadless,
			reason: "no display number",
		},
		{
			name:   "webview missing with runtime dir bus",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0", "XDG_RUNTIME_DIR": "/run/user/1000"}, open: []string{"unix /tmp/.X11-unix/X0", "unix /run/user/1000/bus"}, webview: errNoWebKit},
			mode:   ModeTray,
			reason: "/run/user/1000/bus",
		},
		{
			name:   "webview missing with explicit bus path",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus,guid=abc"}, open: []string{"unix /tmp/.X11-unix/X0", "unix /run/user/1000/bus"}, webview: errNoWebKit},
			mode:   ModeTray,
			reason: "webview cannot load",
		},
		{
			name:   "webview missing with abstract bus",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0", "DBUS_SESSION_BUS_ADDRESS": "unix:abstract=/tmp/dbus-XYZ,guid=1"}, open: []string{"unix /tmp/.X11-unix/X0", "unix @/tmp/dbus-XYZ"}, webview: errNoWebKit},
			mode:   ModeTray,
			reason: "@/tmp/dbus-XYZ",
		},
		{
			name:   "explicit bus address dead while runtime dir bus lives",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0", "XDG_RUNTIME_DIR": "/run/user/1000", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/tmp/dead"}, open: []string{"unix /tmp/.X11-unix/X0", "unix /run/user/1000/bus"}, webview: errNoWebKit},
			mode:   ModeHeadless,
			reason: "no endpoint in DBUS_SESSION_BUS_ADDRESS",
		},
		{
			name:   "autolaunch address resolves through the runtime dir",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0", "XDG_RUNTIME_DIR": "/run/user/1000", "DBUS_SESSION_BUS_ADDRESS": "autolaunch:"}, open: []string{"unix /tmp/.X11-unix/X0", "unix /run/user/1000/bus"}, webview: errNoWebKit},
			mode:   ModeTray,
			reason: "/run/user/1000/bus",
		},
		{
			name:   "webview missing and no bus",
			env:    fakeLinux{env: map[string]string{"DISPLAY": ":0"}, open: []string{"unix /tmp/.X11-unix/X0"}, webview: errNoWebKit},
			mode:   ModeHeadless,
			reason: "DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are both unset",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideLinux(tc.force, tc.env.probe())
			if got.Mode != tc.mode {
				t.Fatalf("mode %v, want %v (reason %q)", got.Mode, tc.mode, got.Reason)
			}
			if !strings.Contains(got.Reason, tc.reason) {
				t.Fatalf("reason %q does not mention %q", got.Reason, tc.reason)
			}
		})
	}
}

func TestParseBusAddress(t *testing.T) {
	got := parseBusAddress("unix:path=/run/user/1000/bus,guid=1;tcp:host=127.0.0.1,port=5555;unix:abstract=/tmp/dbus%2dX;unixexec:path=/bin/true;nonce-tcp:host=::1,port=7")
	want := []busEndpoint{
		{"unix", "/run/user/1000/bus"},
		{"tcp", "127.0.0.1:5555"},
		{"unix", "@/tmp/dbus-X"},
		{"tcp", "[::1]:7"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestDecideWindows(t *testing.T) {
	errLookup := errors.New("access denied")
	tests := []struct {
		name    string
		force   bool
		service bool
		svcErr  error
		session uint32
		sessErr error
		webview string
		webErr  error
		mode    Mode
		reason  string
	}{
		{name: "forced", force: true, session: 1, webview: "131.0", mode: ModeHeadless, reason: "--headless"},
		{name: "service", service: true, session: 0, mode: ModeHeadless, reason: "service control manager"},
		{name: "service check fails", svcErr: errLookup, mode: ModeHeadless, reason: "access denied"},
		{name: "session zero", session: 0, webview: "131.0", mode: ModeHeadless, reason: "session 0"},
		{name: "session lookup fails", sessErr: errLookup, mode: ModeHeadless, reason: "session lookup failed"},
		{name: "webview2 present", session: 2, webview: "131.0.2903.70", mode: ModeWindow, reason: "131.0.2903.70"},
		{name: "webview2 missing", session: 2, mode: ModeTray, reason: "not installed"},
		{name: "webview2 lookup fails", session: 2, webErr: errLookup, mode: ModeTray, reason: "lookup failed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideWindows(tc.force, windowsProbe{
				isService: func() (bool, error) { return tc.service, tc.svcErr },
				sessionID: func() (uint32, error) { return tc.session, tc.sessErr },
				webview2:  func() (string, error) { return tc.webview, tc.webErr },
			})
			if got.Mode != tc.mode {
				t.Fatalf("mode %v, want %v (reason %q)", got.Mode, tc.mode, got.Reason)
			}
			if !strings.Contains(got.Reason, tc.reason) {
				t.Fatalf("reason %q does not mention %q", got.Reason, tc.reason)
			}
		})
	}
}

func TestDecideDarwin(t *testing.T) {
	tests := []struct {
		name  string
		force bool
		attrs uint32
		err   error
		mode  Mode
	}{
		{name: "forced", force: true, attrs: 0x30, mode: ModeHeadless},
		{name: "launch daemon", attrs: 0x0001, mode: ModeHeadless},
		{name: "gui login", attrs: 0x8030, mode: ModeWindow},
		{name: "lookup fails", err: errors.New("errSessionInvalidId"), mode: ModeHeadless},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideDarwin(tc.force, darwinProbe{sessionAttributes: func() (uint32, error) { return tc.attrs, tc.err }})
			if got.Mode != tc.mode {
				t.Fatalf("mode %v, want %v (reason %q)", got.Mode, tc.mode, got.Reason)
			}
		})
	}
}

func TestValidate(t *testing.T) {
	ok := Options{
		AppName:       "DiscoFlix",
		URL:           "http://127.0.0.1:5001/?token=abc",
		IconPNG:       append(append([]byte{}, pngSignature...), make([]byte, 32)...),
		OnOpenWeb:     func() {},
		OnCheckUpdate: func() {},
		OnQuit:        func() {},
		Logger:        testLogger(t),
	}
	if err := ok.validate(ModeWindow); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
	remote := ok
	remote.URL = "http://192.168.1.2:5001/"
	if remote.validate(ModeWindow) == nil {
		t.Fatal("non loopback URL accepted for the window")
	}
	if remote.validate(ModeTray) != nil {
		t.Fatal("tray mode should not read the URL")
	}
	noQuit := ok
	noQuit.OnQuit = nil
	if noQuit.validate(ModeTray) == nil {
		t.Fatal("missing OnQuit accepted")
	}
	badIcon := ok
	badIcon.IconPNG = []byte("GIF89a")
	if badIcon.validate(ModeTray) == nil {
		t.Fatal("non PNG icon accepted")
	}
}

func TestApplicationID(t *testing.T) {
	for in, want := range map[string]string{"DiscoFlix": "io.github.nickheyer.DiscoFlix", "Disco Flix!": "io.github.nickheyer.DiscoFlix", "4K": "io.github.nickheyer._4K", "": "io.github.nickheyer._"} {
		if got := applicationID(in); got != want {
			t.Errorf("applicationID(%q) = %q, want %q", in, got, want)
		}
	}
}
