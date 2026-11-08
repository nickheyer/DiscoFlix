//go:build !headless

package shell

import (
	"log/slog"
	"testing"
)

// Logger that writes through the test log
func testLogger(t *testing.T) *slog.Logger {
	return slog.New(slog.NewTextHandler(t.Output(), nil))
}
