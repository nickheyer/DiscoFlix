//go:build !windows

package update

import (
	"os"
	"syscall"

	"github.com/nickheyer/DiscoFlix/internal/shell/svc"
)

// Replaces the process image with the new binary and the same arguments, or defers to the service manager
func RestartAfterApply() error {
	if svc.Managed() {
		return ErrServiceRestart
	}
	if startPathErr != nil {
		return startPathErr
	}
	return syscall.Exec(startPath, os.Args, os.Environ()) //nolint:gosec // re-executes the binary that was just verified and installed, with this process's own arguments
}
