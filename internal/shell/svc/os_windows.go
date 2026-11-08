package svc

import (
	"context"
	"os"
	"strings"
	"unsafe"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
	winsvc "golang.org/x/sys/windows/svc"
)

// Marks a worker process started by the per-user supervisor
const childEnv = "DISCOFLIX_SVC_CHILD"

// How the process was launched
type launchRole int

const (
	roleDirect     launchRole = iota // started by a user or a script
	roleManaged                      // started by the service control manager
	roleSupervisor                   // started by the per-user task to supervise a worker
	roleSupervised                   // worker started by the per-user supervisor
)

// Builds the SCM backend for system installs or the Task Scheduler backend for per-user installs
func newManager(cfg Config) (manager, error) {
	if cfg.User {
		return newTaskManager(cfg)
	}
	opts := service.KeyValue{
		"StartType":              service.ServiceStartAutomatic,
		"OnFailure":              service.OnFailureRestart,
		"OnFailureDelayDuration": "5s",
		"OnFailureResetPeriod":   86400,
	}
	return newKardianos(cfg, opts, nil, nil)
}

// Runs under the SCM lifecycle, as the per-user supervisor, as its worker, or directly
func RunAsService(run func(ctx context.Context) error) error {
	switch role() {
	case roleManaged:
		return runManaged(run)
	case roleSupervisor:
		return supervise()
	case roleSupervised:
		return runSupervised(run)
	}
	return runDirect(run)
}

// Reports whether the SCM or the per-user supervisor restarts this process after a failing exit
func Managed() bool {
	r := role()
	return r == roleManaged || r == roleSupervised
}

// Classifies the launcher from the SCM handshake, the worker marker, and the parent process
func role() launchRole {
	if is, err := winsvc.IsWindowsService(); err == nil && is {
		return roleManaged
	}
	if os.Getenv(childEnv) == "1" {
		return roleSupervised
	}
	if launchedByTaskScheduler() && taskInstalled() {
		return roleSupervisor
	}
	return roleDirect
}

// Exits hard after a failure so SCM recovery restarts the service, and stops through the SCM after a clean finish
func (p *program) onFinish(s service.Service) {
	if p.stopped.Load() {
		return
	}
	logger, logErr := s.SystemLogger(nil)
	if p.err != nil {
		if logErr == nil {
			logger.Error(p.err)
		}
		os.Exit(1)
	}
	if err := s.Stop(); err != nil {
		if logErr == nil {
			logger.Error(err)
		}
		os.Exit(1)
	}
}

// Reports whether the parent process is the Task Scheduler service host
func launchedByTaskScheduler() bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	ppid := uint32(os.Getppid())
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if e.ProcessID == ppid {
			name := strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
			return name == "svchost.exe" || name == "taskeng.exe"
		}
	}
	return false
}
