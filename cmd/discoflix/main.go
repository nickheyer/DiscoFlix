// Command discoflix runs the server, the desktop shell, service management, and self-update
package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/pflag"

	"github.com/nickheyer/DiscoFlix/internal/app"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/shell"
	"github.com/nickheyer/DiscoFlix/internal/shell/svc"
	"github.com/nickheyer/DiscoFlix/internal/shell/update"
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
	case "tray":
		return tray(args)
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

  serve      run the server, with the desktop shell when a display is present (default)
  tray       open the desktop shell against a running server (--url, --hidden), or tray install|uninstall for a login entry
  service    install, uninstall, start, stop, or status of the system service
  update     check for and apply a signed release (--check to only check)
  version    print the version

Flags for serve and service install:
  --data-dir, --addr, --public-url, --log-level, --log-format, --headless
Environment: DISCOFLIX_DATA_DIR, DISCOFLIX_SERVER_ADDR, DISCOFLIX_SERVER_PUBLIC_URL, DISCOFLIX_LOG_LEVEL, DISCOFLIX_LOG_FORMAT, DISCOFLIX_HEADLESS
            DISCOFLIX_DISCORD_BOT_TOKEN and DISCOFLIX_DISCORD_CLIENT_SECRET fill the encrypted secrets store at boot when it holds none
`)
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
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
		ctx, cancel := signalContextFrom(ctx)
		defer cancel()
		det := shell.Detect(cfg.Headless)
		log.Info("starting", "version", version, "mode", modeName(det.Mode), "reason", det.Reason, "data_dir", cfg.DataDir)
		a, err := app.New(ctx, app.Options{Config: cfg, Version: version, Commit: commit, Mode: modeName(det.Mode), Web: web.Build, Log: log})
		if err != nil {
			return err
		}
		defer a.Close()
		if det.Mode == shell.ModeHeadless {
			return a.Run(ctx)
		}
		done := make(chan struct{})
		var runErr error
		go func() {
			runErr = a.Run(ctx)
			close(done)
		}()
		select {
		case <-a.Ready():
		case <-done:
			return runErr
		case <-ctx.Done():
			<-done
			return runErr
		}
		shellErr := shell.Run(ctx, det, shell.Options{
			AppName:       "DiscoFlix",
			URL:           a.ShellURL(),
			IconPNG:       iconPNG,
			Version:       version,
			OnOpenWeb:     func() { openBrowser(a.ShellURL(), log) },
			OnCheckUpdate: func() { checkAndApply(ctx, cfg.DataDir, log, true) },
			OnQuit: func() {
				cancel()
				<-done
			},
			Logger: log,
		})
		if shellErr != nil {
			log.Error("desktop shell stopped, serving headless", "error", shellErr)
			<-ctx.Done()
		}
		cancel()
		<-done
		return runErr
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Error("exited", "error", err)
		return 1
	}
	return 0
}

// signalContextFrom cancels ctx on interrupt or termination signals
func signalContextFrom(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
}

func modeName(m shell.Mode) string {
	switch m {
	case shell.ModeWindow:
		return "window"
	case shell.ModeTray:
		return "tray"
	}
	return "headless"
}

func tray(args []string) int {
	action := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	fs := pflag.NewFlagSet("tray", pflag.ContinueOnError)
	url := fs.String("url", "http://127.0.0.1:5001/", "address of the running server")
	dataDir := fs.String("data-dir", config.DefaultDataDir(), "directory used for the update trust cache")
	hidden := fs.Bool("hidden", false, "start with the window hidden in the tray")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	switch action {
	case "install":
		if err := svc.InstallTrayAutostart(svc.TrayConfig{URL: *url, DataDir: *dataDir}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println("tray will start at login")
		return 0
	case "uninstall":
		if err := svc.UninstallTrayAutostart(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println("tray login entry removed")
		return 0
	case "status":
		ok, err := svc.TrayAutostartInstalled()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if ok {
			fmt.Println("installed")
		} else {
			fmt.Println("not installed")
		}
		return 0
	case "":
	default:
		fmt.Fprintf(os.Stderr, "unknown tray action %q\n", action)
		return 2
	}
	log := telemetry.NewLogger("info", "", os.Stderr)
	update.SetDataDir(*dataDir)
	ctx, cancel := signalContext()
	defer cancel()
	det := shell.Detect(false)
	if det.Mode == shell.ModeHeadless {
		fmt.Fprintln(os.Stderr, "no display available:", det.Reason)
		return 1
	}
	err := shell.Run(ctx, det, shell.Options{
		AppName:       "DiscoFlix",
		URL:           *url,
		IconPNG:       iconPNG,
		Version:       version,
		OnOpenWeb:     func() { openBrowser(*url, log) },
		OnCheckUpdate: func() { checkAndApply(ctx, *dataDir, log, true) },
		OnQuit:        cancel,
		Logger:        log,
		StartHidden:   *hidden,
	})
	if err != nil {
		log.Error("shell exited", "error", err)
		return 1
	}
	return 0
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
func checkAndApply(ctx context.Context, dataDir string, log interface {
	Info(string, ...any)
	Error(string, ...any)
}, apply bool,
) bool {
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

// openBrowser hands a loopback or operator-supplied URL to the platform opener
func openBrowser(url string, log interface{ Error(string, ...any) }) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.CommandContext(context.Background(), "rundll32", "url.dll,FileProtocolHandler", url) //nolint:gosec // fixed opener, url is ours or a flag
	case "darwin":
		cmd = exec.CommandContext(context.Background(), "open", url) //nolint:gosec // fixed opener, url is ours or a flag
	default:
		cmd = exec.CommandContext(context.Background(), "xdg-open", url) //nolint:gosec // fixed opener, url is ours or a flag
	}
	if err := cmd.Start(); err != nil {
		log.Error("open browser failed", "error", err)
	}
}
