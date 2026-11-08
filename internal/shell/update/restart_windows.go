package update

import (
	"os"
	"os/exec"

	"github.com/nickheyer/DiscoFlix/internal/shell/svc"
)

// Starts the new binary with the same arguments and exits, or defers to the service manager
func RestartAfterApply() error {
	if svc.Managed() {
		return ErrServiceRestart
	}
	if startPathErr != nil {
		return startPathErr
	}
	cmd := exec.Command(startPath, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		return err
	}
	os.Exit(0)
	return nil
}
