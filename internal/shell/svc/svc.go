// Installs, controls, and runs DiscoFlix under systemd, launchd, the Windows SCM, or a per-user Windows task
package svc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"

	"github.com/kardianos/service"
)

const (
	Name        = "discoflix"
	DisplayName = "DiscoFlix"
	Description = "DiscoFlix media server that searches, downloads, catalogs, transcodes, and takes requests"
)

// Raised by Stop, Start, and Uninstall when no service of this scope exists
var ErrNotInstalled = errors.New("svc: the DiscoFlix service is not installed")

// Error text kardianos returns from Status when systemctl is-active reports failed
const systemdFailedState = "service in failed state"

// Install scope and paths for the service
type Config struct {
	DataDir    string // passed to serve as --data-dir and used as the working directory
	User       bool   // per-user service instead of a system-wide one
	Executable string // binary the service runs, empty for the running executable
}

// Observed service state
type State int

const (
	StateNotInstalled State = iota
	StateStopped
	StateRunning
)

// Names the state for CLI output
func (s State) String() string {
	switch s {
	case StateStopped:
		return "stopped"
	case StateRunning:
		return "running"
	}
	return "not installed"
}

// Operations every backend implements
type manager interface {
	install() error
	uninstall() error
	start() error
	stop() error
	status() (State, error)
}

// Registers the service with the platform manager so it starts at boot or login and restarts on failure
func Install(cfg Config) error {
	m, err := newManager(cfg)
	if err != nil {
		return err
	}
	st, err := m.status()
	if err != nil && !errors.Is(err, ErrNotInstalled) {
		return err
	}
	if st != StateNotInstalled {
		return fmt.Errorf("svc: the DiscoFlix service is already installed and %s", st)
	}
	return m.install()
}

// Stops the service when it runs and removes its registration
func Uninstall(cfg Config) error {
	m, err := newManager(cfg)
	if err != nil {
		return err
	}
	st, err := m.status()
	if err != nil {
		return err
	}
	if st == StateRunning {
		if err := m.stop(); err != nil {
			return err
		}
	}
	return m.uninstall()
}

// Starts the installed service
func Start(cfg Config) error {
	m, err := newManager(cfg)
	if err != nil {
		return err
	}
	st, err := m.status()
	if err != nil {
		return err
	}
	if st == StateRunning {
		return nil
	}
	return m.start()
}

// Stops the installed service and waits for it to exit
func Stop(cfg Config) error {
	m, err := newManager(cfg)
	if err != nil {
		return err
	}
	st, err := m.status()
	if err != nil {
		return err
	}
	if st != StateRunning {
		return nil
	}
	return m.stop()
}

// Reports whether the service is installed and running
func Status(cfg Config) (State, error) {
	m, err := newManager(cfg)
	if err != nil {
		return StateNotInstalled, err
	}
	st, err := m.status()
	if errors.Is(err, ErrNotInstalled) {
		return StateNotInstalled, nil
	}
	return st, err
}

// Runs the callback with a context cancelled by SIGINT or SIGTERM
func runDirect(run func(ctx context.Context) error) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return run(ctx)
}

// Absolute data directory and executable for a config
func resolve(cfg Config) (string, string, error) {
	if cfg.DataDir == "" {
		return "", "", errors.New("svc: Config.DataDir is empty")
	}
	data, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return "", "", err
	}
	exe := cfg.Executable
	if exe == "" {
		if exe, err = os.Executable(); err != nil {
			return "", "", err
		}
	}
	if exe, err = filepath.Abs(exe); err != nil {
		return "", "", err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return "", "", err
	}
	return data, exe, nil
}

// Arguments the installed service passes to the binary
func serveArgs(data string) []string {
	return []string{"serve", "--headless", "--data-dir", data}
}

// Wraps a kardianos service as a manager
type kardianosManager struct {
	s    service.Service
	data string
	prep func() error
}

// Builds a kardianos service with the shared name and arguments, platform options, and an optional install step
func newKardianos(cfg Config, opts service.KeyValue, deps []string, prep func() error) (*kardianosManager, error) {
	data, exe, err := resolve(cfg)
	if err != nil {
		return nil, err
	}
	s, err := service.New(nopProgram{}, &service.Config{
		Name:             Name,
		DisplayName:      DisplayName,
		Description:      Description,
		Executable:       exe,
		Arguments:        serveArgs(data),
		WorkingDirectory: data,
		Dependencies:     deps,
		Option:           opts,
	})
	if err != nil {
		return nil, err
	}
	return &kardianosManager{s: s, data: data, prep: prep}, nil
}

// Creates the data directory and any platform paths, then writes and enables the service definition
func (k *kardianosManager) install() error {
	if err := os.MkdirAll(k.data, 0o750); err != nil {
		return err
	}
	if k.prep != nil {
		if err := k.prep(); err != nil {
			return err
		}
	}
	return k.s.Install()
}

// Removes the service definition
func (k *kardianosManager) uninstall() error {
	return k.s.Uninstall()
}

// Asks the platform manager to launch the service now
func (k *kardianosManager) start() error {
	return k.s.Start()
}

// Asks the platform manager to halt the service
func (k *kardianosManager) stop() error {
	return k.s.Stop()
}

// Maps the kardianos state onto State, counting a systemd failed unit as stopped
func (k *kardianosManager) status() (State, error) {
	st, err := k.s.Status()
	if errors.Is(err, service.ErrNotInstalled) {
		return StateNotInstalled, ErrNotInstalled
	}
	if err != nil && err.Error() == systemdFailedState {
		return StateStopped, nil
	}
	if err != nil {
		return StateNotInstalled, err
	}
	if st == service.StatusRunning {
		return StateRunning, nil
	}
	return StateStopped, nil
}

// Program used only for install and control calls, which never start it
type nopProgram struct{}

// Never called because control operations do not run the program
func (nopProgram) Start(service.Service) error { return nil }

// Never called because control operations do not run the program
func (nopProgram) Stop(service.Service) error { return nil }

// Runs the callback in the service lifecycle and records how it ended
type program struct {
	run      func(ctx context.Context) error
	cancel   context.CancelFunc
	finished chan struct{}
	err      error
	stopped  atomic.Bool
}

// Launches the callback without blocking the service manager handshake
func (p *program) Start(s service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.finished = make(chan struct{})
	go func() {
		p.err = p.run(ctx)
		close(p.finished)
		p.onFinish(s)
	}()
	return nil
}

// Cancels the callback context and waits for the callback to return
func (p *program) Stop(service.Service) error {
	p.stopped.Store(true)
	p.cancel()
	<-p.finished
	return nil
}

// Waits for SIGTERM, SIGINT, or the callback finishing on its own
func (p *program) wait() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)
	select {
	case <-sig:
	case <-p.finished:
	}
}

// Runs the callback through kardianos so the manager sees a proper start and stop
func runManaged(run func(ctx context.Context) error) error {
	p := &program{run: run}
	s, err := service.New(p, &service.Config{Name: Name, Option: service.KeyValue{"RunWait": p.wait}})
	if err != nil {
		return err
	}
	if err := s.Run(); err != nil {
		return err
	}
	return p.err
}
