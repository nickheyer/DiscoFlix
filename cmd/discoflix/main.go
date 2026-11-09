// Command discoflix runs the server, the desktop window, service management, and self-update
package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/pflag"

	"github.com/nickheyer/DiscoFlix/internal/app"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/display"
	"github.com/nickheyer/DiscoFlix/internal/shell/svc"
	"github.com/nickheyer/DiscoFlix/internal/shell/update"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/telemetry"
	"github.com/nickheyer/DiscoFlix/web"
)

var (
	version = "dev"
	commit  = "none"
)

//go:embed assets/icon.png
var iconPNG []byte

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		return serve(args)
	case "display":
		return displayCmd(args)
	case "service":
		return service(args)
	case "update":
		return updateCmd(args)
	case "version":
		fmt.Printf("discoflix %s (%s) %s %s/%s\n", version, commit, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return 0
	case "help", "-h", "--help":
		usage()
		return 0
	}
	fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
	usage()
	return 2
}

func usage() {
	fmt.Print(`discoflix [command] [flags]

  serve      run the server and the desktop window as --display says (default)
  display    show or save the mode that --display auto starts with: all, desktop, or web
  service    install, uninstall, start, stop, or status of the system service
  update     check for and apply a signed release (--check to only check)
  version    print the version

Flags for serve and service install:
  --data-dir, --addr, --public-url, --log-level, --log-format, --display
  --display auto     the mode saved in the app, else all, falling back to desktop or web on error (default)
  --display all      server on --addr plus the desktop window
  --display desktop  server on loopback only plus the desktop window
  --display web      server on --addr, no window
Environment: DISCOFLIX_DATA_DIR, DISCOFLIX_SERVER_ADDR, DISCOFLIX_SERVER_PUBLIC_URL, DISCOFLIX_LOG_LEVEL, DISCOFLIX_LOG_FORMAT, DISCOFLIX_DISPLAY
            DISCOFLIX_DISCORD_BOT_TOKEN and DISCOFLIX_DISCORD_CLIENT_SECRET fill the encrypted secrets store at boot when it holds none
`)
}

func serve(args []string) int {
	fs := pflag.NewFlagSet("serve", pflag.ContinueOnError)
	config.Flags(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg, err := config.Load(fs)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	log := telemetry.NewLogger(cfg.LogLevel, cfg.LogFormat, os.Stderr)
	update.SetDataDir(cfg.DataDir)
	err = svc.RunAsService(func(ctx context.Context) error {
		ctx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return runServe(ctx, cfg, log)
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Error("exited", "error", err)
		_, _ = fmt.Fprintln(os.Stdout, "discoflix:", err)
		appendLog(cfg.DataDir, err)
		return 1
	}
	return 0
}

// runServe boots the app, settles the display mode with its fallbacks, serves, and runs the window
func runServe(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	requested, err := display.Parse(cfg.Display)
	if err != nil {
		return err
	}
	a, err := app.New(ctx, app.Options{Config: cfg, Version: version, Commit: commit, Web: web.Build, Log: log})
	if err != nil {
		return err
	}
	defer a.Close()
	auto := requested == display.Auto
	mode := requested
	if auto {
		mode, err = savedDisplay(ctx, a)
		if err != nil {
			return err
		}
	}
	windowErr := display.Available()
	if auto && mode.Window() && windowErr != nil {
		log.Warn("desktop window unavailable, using web", "error", windowErr)
		mode = display.Web
	}
	log.Info("display", "requested", requested, "mode", mode)
	if _, err := a.Listen(ctx, listenAddr(cfg, mode)); err != nil {
		alt, ok := listenFallback(mode, windowErr)
		if !auto || !ok {
			return errors.Join(err, windowErr)
		}
		log.Warn("listen failed, falling back", "mode", mode, "fallback", alt, "error", err)
		if _, err2 := a.Listen(ctx, listenAddr(cfg, alt)); err2 != nil {
			return errors.Join(err, err2)
		}
		mode = alt
	}
	done := make(chan struct{})
	var runErr error
	go func() {
		runErr = a.Run(ctx, string(mode))
		close(done)
		cancel()
	}()
	select {
	case <-a.Ready():
	case <-done:
		return runErr
	}
	stop := func() {
		cancel()
		<-done
	}
	if !mode.Window() {
		<-done
		return runErr
	}
	werr := display.Run(ctx, display.Options{URL: a.ShellURL(), Title: "DiscoFlix", Icon: iconPNG, Logger: log, OnQuit: stop})
	if werr == nil {
		stop()
		return runErr
	}
	if !auto {
		stop()
		return werr
	}
	if mode == display.Desktop {
		if _, lerr := a.Listen(ctx, cfg.Addr); lerr != nil {
			stop()
			return errors.Join(werr, lerr)
		}
	}
	log.Warn("desktop window failed, serving web", "error", werr)
	<-done
	return runErr
}

// savedDisplay returns the mode saved in the app, or all when none is saved
func savedDisplay(ctx context.Context, a *app.App) (display.Mode, error) {
	var saved string
	ok, err := a.Setting(ctx, display.SettingKey, &saved)
	if err != nil || !ok {
		return display.All, err
	}
	mode, err := display.Parse(saved)
	if err != nil {
		return "", fmt.Errorf("saved setting %s: %w", display.SettingKey, err)
	}
	if mode == display.Auto {
		return display.All, nil
	}
	return mode, nil
}

// listenAddr keeps desktop mode on an ephemeral loopback port and every other mode on the configured address
func listenAddr(cfg config.Config, mode display.Mode) string {
	if mode.Loopback() {
		return "127.0.0.1:0"
	}
	return cfg.Addr
}

// listenFallback names the mode to try when the address for mode cannot be bound
func listenFallback(mode display.Mode, windowErr error) (display.Mode, bool) {
	if mode.Loopback() {
		return display.Web, true
	}
	return display.Desktop, windowErr == nil
}

// displayCmd shows or saves the display mode that auto starts with
func displayCmd(args []string) int {
	fs := pflag.NewFlagSet("display", pflag.ContinueOnError)
	dataDir := fs.String("data-dir", config.DefaultDataDir(), "directory holding the settings database")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	var mode display.Mode
	if rest := fs.Args(); len(rest) > 0 {
		m, err := display.Parse(rest[0])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		mode = m
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	st, err := store.Open(ctx, *dataDir, telemetry.NewLogger("warn", "", os.Stderr))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() { _ = st.Close() }()
	if _, err := st.Migrate(ctx, version); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	settings := store.NewSettings(st.Ent)
	if mode == "" {
		saved, err := settings.GetString(ctx, display.SettingKey, string(display.Auto))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		mode = display.Mode(saved)
	} else if err := settings.Set(ctx, display.SettingKey, string(mode)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if mode == display.Auto {
		fmt.Println("auto starts in all mode, nothing saved")
		return 0
	}
	fmt.Println("auto starts in", mode, "mode")
	return 0
}

// appendLog records a fatal exit in discoflix.log beside the databases
func appendLog(dataDir string, err error) {
	path := filepath.Join(dataDir, "discoflix.log")
	f, ferr := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) //nolint:gosec // the path is inside the data directory
	if ferr != nil {
		fmt.Fprintln(os.Stderr, "discoflix: cannot write", path+":", ferr)
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = fmt.Fprintf(f, "%s discoflix %s exited: %v\n", time.Now().Format(time.RFC3339), version, err)
}

func service(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "service needs one of install, uninstall, start, stop, status")
		return 2
	}
	action, rest := args[0], args[1:]
	fs := pflag.NewFlagSet("service", pflag.ContinueOnError)
	config.Flags(fs)
	user := fs.Bool("user", false, "install for the current user instead of the system")
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	cfg, err := config.Load(fs)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	sc := svc.Config{DataDir: cfg.DataDir, User: *user}
	switch action {
	case "install":
		err = svc.Install(sc)
	case "uninstall":
		err = svc.Uninstall(sc)
	case "start":
		err = svc.Start(sc)
	case "stop":
		err = svc.Stop(sc)
	case "status":
		var state svc.State
		state, err = svc.Status(sc)
		if err == nil {
			fmt.Println(stateName(state))
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown service action %q\n", action)
		return 2
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func stateName(s svc.State) string {
	switch s {
	case svc.StateRunning:
		return "running"
	case svc.StateStopped:
		return "stopped"
	}
	return "not installed"
}

func updateCmd(args []string) int {
	fs := pflag.NewFlagSet("update", pflag.ContinueOnError)
	check := fs.Bool("check", false, "only report whether a newer release exists")
	dataDir := fs.String("data-dir", config.DefaultDataDir(), "directory used for the update trust cache")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	log := telemetry.NewLogger("info", "", os.Stderr)
	update.SetDataDir(*dataDir)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if !checkAndApply(ctx, *dataDir, log, !*check) {
		return 1
	}
	return 0
}

// checkAndApply reports the newest release and applies it when asked, restarting outside a service manager
func checkAndApply(ctx context.Context, dataDir string, log *slog.Logger, apply bool) bool {
	update.SetDataDir(dataDir)
	rel, err := update.Check(ctx, version)
	if err != nil {
		log.Error("update check failed", "error", err)
		return false
	}
	if rel == nil {
		log.Info("already on the newest release", "version", version)
		return true
	}
	log.Info("newer release available", "current", version, "available", rel.Version, "published", rel.PublishedAt.Format(time.RFC3339))
	if !apply {
		return true
	}
	if err := update.Apply(ctx, rel); err != nil {
		log.Error("update failed", "error", err)
		return false
	}
	log.Info("update applied, restarting", "version", rel.Version)
	err = update.RestartAfterApply()
	if errors.Is(err, update.ErrServiceRestart) {
		log.Info("exiting so the service manager starts the new binary")
		os.Exit(3)
	}
	if err != nil {
		log.Error("restart failed", "error", err)
		return false
	}
	return true
}
