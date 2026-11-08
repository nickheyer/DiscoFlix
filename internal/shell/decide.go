//go:build !headless

package shell

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"path"
	"strconv"
	"strings"
)

const forcedReason = "the --headless flag was given"

// Environment and native probes the Linux decision reads
type linuxProbe struct {
	getenv  func(string) string
	dial    func(network, address string) error
	webview func() (string, error)
}

// Picks headless, tray, or window from the Linux display, webview libraries, and session bus
func decideLinux(force bool, p linuxProbe) Detection {
	if force {
		return Detection{Mode: ModeHeadless, Reason: forcedReason}
	}
	display, err := linuxDisplay(p)
	if err != nil {
		return Detection{Mode: ModeHeadless, Reason: err.Error()}
	}
	libs, webErr := p.webview()
	if webErr == nil {
		return Detection{Mode: ModeWindow, Reason: fmt.Sprintf("%s is reachable and %s loaded", display, libs)}
	}
	bus, busErr := sessionBus(p)
	if busErr == nil {
		return Detection{Mode: ModeTray, Reason: fmt.Sprintf("%s and the session bus at %s are reachable but the webview cannot load because %v", display, bus, webErr)}
	}
	return Detection{Mode: ModeHeadless, Reason: fmt.Sprintf("%s is reachable but the webview cannot load because %v and %v", display, webErr, busErr)}
}

// Returns a description of the first reachable Wayland or X11 display
func linuxDisplay(p linuxProbe) (string, error) {
	var problems []string
	if name := p.getenv("WAYLAND_DISPLAY"); name != "" {
		sock := name
		if !path.IsAbs(sock) {
			sock = ""
			if dir := p.getenv("XDG_RUNTIME_DIR"); dir != "" {
				sock = path.Join(dir, name)
			} else {
				problems = append(problems, fmt.Sprintf("WAYLAND_DISPLAY %s is relative while XDG_RUNTIME_DIR is unset", name))
			}
		}
		if sock != "" {
			if p.dial("unix", sock) == nil {
				return "Wayland display " + sock, nil
			}
			problems = append(problems, fmt.Sprintf("Wayland socket %s refuses connections", sock))
		}
	}
	if d := p.getenv("DISPLAY"); d != "" {
		desc, err := x11Display(p, d)
		if err == nil {
			return desc, nil
		}
		problems = append(problems, err.Error())
	}
	if len(problems) == 0 {
		return "", errors.New("neither WAYLAND_DISPLAY nor DISPLAY is set")
	}
	return "", errors.New(strings.Join(problems, " and "))
}

// Reaches the X server named by DISPLAY and rejects displays tunnelled through SSH
func x11Display(p linuxProbe, d string) (string, error) {
	host, num, err := parseDisplay(d)
	if err != nil {
		return "", err
	}
	switch {
	case host == "" || host == "unix":
		sock := "/tmp/.X11-unix/X" + strconv.Itoa(num)
		if p.dial("unix", sock) == nil || p.dial("unix", "@"+sock) == nil {
			return "X11 display " + d, nil
		}
		return "", fmt.Errorf("X11 socket %s for DISPLAY %s refuses connections", sock, d)
	case strings.HasPrefix(host, "/"):
		sock := host + ":" + strconv.Itoa(num)
		if p.dial("unix", sock) == nil {
			return "X11 display " + d, nil
		}
		return "", fmt.Errorf("X11 socket %s refuses connections", sock)
	}
	if p.getenv("SSH_CONNECTION") != "" || p.getenv("SSH_CLIENT") != "" {
		return "", fmt.Errorf("DISPLAY %s is forwarded over SSH", d)
	}
	addr := net.JoinHostPort(strings.TrimPrefix(host, "tcp/"), strconv.Itoa(6000+num))
	if p.dial("tcp", addr) == nil {
		return "X11 display " + d, nil
	}
	return "", fmt.Errorf("X11 server %s for DISPLAY %s refuses connections", addr, d)
}

// Splits DISPLAY into host and display number, dropping the screen suffix
func parseDisplay(d string) (string, int, error) {
	host, num, ok := strings.CutLast(d, ":")
	if !ok {
		return "", 0, fmt.Errorf("DISPLAY %s has no display number", d)
	}
	if dot := strings.IndexByte(num, '.'); dot >= 0 {
		num = num[:dot]
	}
	n, err := strconv.Atoi(num)
	if err != nil || n < 0 {
		return "", 0, fmt.Errorf("DISPLAY %s has an invalid display number", d)
	}
	return host, n, nil
}

// Finds a session bus endpoint that accepts connections, resolved the way godbus resolves it
func sessionBus(p linuxProbe) (string, error) {
	if addr := p.getenv("DBUS_SESSION_BUS_ADDRESS"); addr != "" && addr != "autolaunch:" {
		eps := parseBusAddress(addr)
		for _, ep := range eps {
			if p.dial(ep.network, ep.address) == nil {
				return ep.address, nil
			}
		}
		return "", fmt.Errorf("no endpoint in DBUS_SESSION_BUS_ADDRESS %s accepts connections", addr)
	}
	dir := p.getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		return "", errors.New("DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are both unset")
	}
	sock := path.Join(dir, "bus")
	if p.dial("unix", sock) == nil {
		return sock, nil
	}
	return "", fmt.Errorf("session bus socket %s refuses connections", sock)
}

// Dialable network and address for one D-Bus server address entry
type busEndpoint struct {
	network string
	address string
}

// Parses the unix and tcp entries of a D-Bus address list into dialable endpoints
func parseBusAddress(list string) []busEndpoint {
	var out []busEndpoint
	for entry := range strings.SplitSeq(list, ";") {
		transport, params, ok := strings.Cut(entry, ":")
		if !ok {
			continue
		}
		kv := map[string]string{}
		for pair := range strings.SplitSeq(params, ",") {
			k, v, ok := strings.Cut(pair, "=")
			if !ok {
				continue
			}
			if dec, err := url.PathUnescape(v); err == nil {
				kv[k] = dec
			}
		}
		switch transport {
		case "unix":
			if sock := kv["path"]; sock != "" {
				out = append(out, busEndpoint{"unix", sock})
			} else if name := kv["abstract"]; name != "" {
				out = append(out, busEndpoint{"unix", "@" + name})
			}
		case "tcp", "nonce-tcp":
			if kv["host"] != "" && kv["port"] != "" {
				out = append(out, busEndpoint{"tcp", net.JoinHostPort(kv["host"], kv["port"])})
			}
		}
	}
	return out
}

// Native probes the Windows decision reads
type windowsProbe struct {
	isService func() (bool, error)
	sessionID func() (uint32, error)
	webview2  func() (string, error)
}

// Picks headless for services and session 0, window when WebView2 is installed, tray otherwise
func decideWindows(force bool, p windowsProbe) Detection {
	if force {
		return Detection{Mode: ModeHeadless, Reason: forcedReason}
	}
	service, err := p.isService()
	if err != nil {
		return Detection{Mode: ModeHeadless, Reason: fmt.Sprintf("the service control manager check failed with %v so no desktop is assumed", err)}
	}
	if service {
		return Detection{Mode: ModeHeadless, Reason: "the process was started by the Windows service control manager"}
	}
	id, err := p.sessionID()
	if err != nil {
		return Detection{Mode: ModeHeadless, Reason: fmt.Sprintf("the session lookup failed with %v so no desktop is assumed", err)}
	}
	if id == 0 {
		return Detection{Mode: ModeHeadless, Reason: "the process runs in session 0, which has no interactive desktop"}
	}
	version, err := p.webview2()
	if err != nil {
		return Detection{Mode: ModeTray, Reason: fmt.Sprintf("the WebView2 runtime lookup failed with %v", err)}
	}
	if version == "" {
		return Detection{Mode: ModeTray, Reason: "the WebView2 runtime is not installed"}
	}
	return Detection{Mode: ModeWindow, Reason: fmt.Sprintf("the WebView2 runtime %s is installed", version)}
}

// Graphic access bit of SessionAttributeBits from Security.framework AuthSession.h
const sessionHasGraphicAccess = 0x0010

// Native probe the macOS decision reads
type darwinProbe struct {
	sessionAttributes func() (uint32, error)
}

// Picks headless for sessions without graphic access and window for every other session
func decideDarwin(force bool, p darwinProbe) Detection {
	if force {
		return Detection{Mode: ModeHeadless, Reason: forcedReason}
	}
	attrs, err := p.sessionAttributes()
	if err != nil {
		return Detection{Mode: ModeHeadless, Reason: fmt.Sprintf("the security session lookup failed with %v so no desktop is assumed", err)}
	}
	if attrs&sessionHasGraphicAccess == 0 {
		return Detection{Mode: ModeHeadless, Reason: "the security session has no graphic access, as under a LaunchDaemon"}
	}
	return Detection{Mode: ModeWindow, Reason: "the security session has graphic access"}
}
