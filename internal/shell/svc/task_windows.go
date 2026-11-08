package svc

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

const (
	restartDelay = 5 * time.Second  // pause before a failed worker is started again
	stopTimeout  = 90 * time.Second // grace period before a worker or task is terminated
)

// Logon task that runs the supervisor in the user session without elevation or time limits
const taskTemplate = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>%s</Author>
    <Description>%s</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>%s</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>%s</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%s</Command>
      <Arguments>%s</Arguments>
      <WorkingDirectory>%s</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`

// Per-user service backed by a Task Scheduler logon task and a supervising process
type taskManager struct {
	data string
	exe  string
	sid  string
}

// Resolves paths and the current user SID for a per-user install
func newTaskManager(cfg Config) (*taskManager, error) {
	data, exe, err := resolve(cfg)
	if err != nil {
		return nil, err
	}
	sid, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	return &taskManager{data: data, exe: exe, sid: sid}, nil
}

// Registers the logon task from a UTF-16 XML definition
func (t *taskManager) install() error {
	if err := os.MkdirAll(t.data, 0o750); err != nil {
		return err
	}
	f, err := os.CreateTemp("", "discoflix-task-*.xml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, werr := f.Write(utf16LE(taskXML(t.exe, serveArgs(t.data), t.data, t.sid)))
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return werr
	}
	return schtasks("/Create", "/TN", Name, "/XML", f.Name())
}

// Deletes the logon task
func (t *taskManager) uninstall() error {
	return schtasks("/Delete", "/TN", Name, "/F")
}

// Clears a leftover stop request and runs the task now
func (t *taskManager) start() error {
	name, err := objectName("stop", t.sid)
	if err != nil {
		return err
	}
	if ev, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, name); err == nil {
		windows.ResetEvent(ev)
		windows.CloseHandle(ev)
	}
	return schtasks("/Run", "/TN", Name)
}

// Signals the shutdown event, waits for the supervisor to exit, and ends the task after the grace period
func (t *taskManager) stop() error {
	name, err := objectName("stop", t.sid)
	if err != nil {
		return err
	}
	ev, err := windows.CreateEvent(nil, 1, 0, name)
	if ev == 0 {
		return err
	}
	defer windows.CloseHandle(ev)
	if err := windows.SetEvent(ev); err != nil {
		return err
	}
	deadline := time.Now().Add(stopTimeout)
	for time.Now().Before(deadline) {
		if !supervisorAlive(t.sid) {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err := schtasks("/End", "/TN", Name); err != nil {
		return err
	}
	return fmt.Errorf("svc: DiscoFlix ignored the stop request for %s and its task was terminated", stopTimeout)
}

// Reads installation from Task Scheduler and liveness from the supervisor mutex
func (t *taskManager) status() (State, error) {
	if !taskInstalled() {
		return StateNotInstalled, ErrNotInstalled
	}
	if supervisorAlive(t.sid) {
		return StateRunning, nil
	}
	return StateStopped, nil
}

// Restarts the worker after failing exits and forwards stop requests until a clean exit or stop
func supervise() error {
	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	name, err := objectName("supervisor", sid)
	if err != nil {
		return err
	}
	mutex, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(mutex)
		return errors.New("svc: a DiscoFlix supervisor already runs for this user")
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(mutex)
	stopped, err := stopSignal(sid)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	for {
		cmd := exec.Command(exe, os.Args[1:]...)
		cmd.Env = append(os.Environ(), childEnv+"=1")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
		exited := make(chan error, 1)
		if err := cmd.Start(); err != nil {
			exited <- err
		} else {
			go func() { exited <- cmd.Wait() }()
		}
		select {
		case err := <-exited:
			if err == nil {
				return nil
			}
		case <-stopped:
			select {
			case <-exited:
			case <-time.After(stopTimeout):
				cmd.Process.Kill()
				<-exited
			}
			return nil
		}
		select {
		case <-stopped:
			return nil
		case <-time.After(restartDelay):
		}
	}
}

// Runs the worker callback with a context cancelled by the per-user stop event
func runSupervised(run func(ctx context.Context) error) error {
	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	stopped, err := stopSignal(sid)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-stopped:
			cancel()
		case <-ctx.Done():
		}
	}()
	return run(ctx)
}

// Holds the manual reset stop event open for the process lifetime and returns a channel closed once it is signaled
func stopSignal(sid string) (<-chan struct{}, error) {
	name, err := objectName("stop", sid)
	if err != nil {
		return nil, err
	}
	ev, err := windows.CreateEvent(nil, 1, 0, name)
	if ev == 0 {
		return nil, err
	}
	ch := make(chan struct{})
	go func() {
		if res, err := windows.WaitForSingleObject(ev, windows.INFINITE); err == nil && res == windows.WAIT_OBJECT_0 {
			close(ch)
		}
	}()
	return ch, nil
}

// Reports whether a supervisor holds the per-user mutex
func supervisorAlive(sid string) bool {
	name, err := objectName("supervisor", sid)
	if err != nil {
		return false
	}
	h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, name)
	if err != nil {
		return false
	}
	windows.CloseHandle(h)
	return true
}

// Session local kernel object name scoped to the user SID
func objectName(kind, sid string) (*uint16, error) {
	return windows.UTF16PtrFromString(`Local\` + Name + "-" + kind + "-" + sid)
}

// Reports whether the logon task exists
func taskInstalled() bool {
	return schtasks("/Query", "/TN", Name) == nil
}

// Runs the Task Scheduler CLI without a console window and folds its output into the error
func schtasks(args ...string) error {
	cmd := exec.Command("schtasks.exe", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("svc: schtasks %s failed with %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Returns the string SID of the user owning the process token
func currentUserSID() (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

// Fills the task template with XML escaped values and a Windows quoted argument string
func taskXML(exe string, args []string, dir, sid string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = syscall.EscapeArg(a)
	}
	esc := func(s string) string {
		var b bytes.Buffer
		xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	return fmt.Sprintf(taskTemplate, esc(DisplayName), esc(Description), esc(sid), esc(sid), esc(exe), esc(strings.Join(quoted, " ")), esc(dir))
}

// Encodes text as UTF-16 little endian with a byte order mark as schtasks expects
func utf16LE(s string) []byte {
	units := utf16.Encode([]rune(s))
	out := make([]byte, 2+2*len(units))
	out[0], out[1] = 0xFF, 0xFE
	for i, u := range units {
		binary.LittleEndian.PutUint16(out[2+2*i:], u)
	}
	return out
}
