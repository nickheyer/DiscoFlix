//go:build !windows

package svc

import (
	"context"

	"github.com/kardianos/service"
)

// Runs under the service lifecycle when this service unit or job started the process, directly otherwise
func RunAsService(run func(ctx context.Context) error) error {
	if Managed() {
		return runManaged(run)
	}
	return runDirect(run)
}

// Reports whether this service unit or job started the process
func Managed() bool {
	return startedByManager()
}

// Unix managers see the exit status once wait returns, so nothing extra is needed
func (p *program) onFinish(service.Service) {}
