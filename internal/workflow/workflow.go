// Package workflow runs durable workflows on DBOS over a SQLite file in the data directory
package workflow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	_ "github.com/dbos-inc/dbos-transact-golang/dbos/driver/sqlite"
)

// FileName is the workflow database inside the data directory
const FileName = "workflows.db"

// appVersion is fixed so a restart on a new build resumes the work the old build left pending
const appVersion = "discoflix"

// ErrNotLaunched reports a run before Launch
var ErrNotLaunched = errors.New("workflow: runtime not launched")

// Service owns the DBOS context for the process
type Service struct {
	ctx dbos.Context
	log *slog.Logger

	mu       sync.RWMutex
	launched bool
}

// Open creates or migrates workflows.db and prepares the runtime without starting it
func Open(ctx context.Context, dataDir string, log *slog.Logger) (*Service, error) {
	dctx, err := dbos.NewContext(ctx, dbos.Config{
		AppName:                "discoflix",
		DatabaseURL:            "sqlite:" + filepath.Join(dataDir, FileName),
		Logger:                 log.With("component", "dbos"),
		ApplicationVersion:     appVersion,
		SystemDBStartupTimeout: time.Minute,
	})
	if err != nil {
		return nil, fmt.Errorf("workflow: open: %w", err)
	}
	return &Service{ctx: dctx, log: log}, nil
}

// Context exposes the root DBOS context for registration and runs
func (s *Service) Context() dbos.Context { return s.ctx }

// Launch starts recovery, queues, and schedules, after every workflow is registered
func (s *Service) Launch() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.launched {
		return nil
	}
	if err := dbos.Launch(s.ctx); err != nil {
		return fmt.Errorf("workflow: launch: %w", err)
	}
	s.launched = true
	return nil
}

// Launched reports whether workflows can run
func (s *Service) Launched() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.launched
}

// Close stops the runtime, waiting up to ten seconds for in-flight steps
func (s *Service) Close() error {
	return dbos.Shutdown(s.ctx, 10*time.Second)
}

// Register adds a workflow under a stable name with recovery retries
func Register[P, R any](s *Service, name string, fn dbos.Workflow[P, R]) {
	dbos.RegisterWorkflow(s.ctx, fn, dbos.WithWorkflowName(name), dbos.WithMaxRecoveryAttempts(5))
}

// Run starts a workflow under an idempotency id, returning the recorded handle when the id already ran
func Run[P, R any](s *Service, fn dbos.Workflow[P, R], id string, in P, opts ...dbos.WorkflowOption) (dbos.WorkflowHandle[R], error) {
	if !s.Launched() {
		return nil, ErrNotLaunched
	}
	if id != "" {
		opts = append(opts, dbos.WithWorkflowID(id))
	}
	return dbos.RunWorkflow(s.ctx, fn, in, opts...)
}

// Step runs one non-deterministic operation durably with exponential retries
func Step[R any](ctx dbos.Context, name string, retries int, fn func(context.Context) (R, error)) (R, error) {
	return dbos.RunAsStep(ctx, fn,
		dbos.WithStepName(name),
		dbos.WithStepMaxRetries(retries),
		dbos.WithStepBaseInterval(time.Second),
		dbos.WithStepMaxInterval(time.Minute),
	)
}

// Queue registers a named queue with a per-process concurrency limit
func (s *Service) Queue(name string, concurrency int) (dbos.Queue, error) {
	return dbos.RegisterQueue(s.ctx, name, dbos.WithWorkerConcurrency(concurrency))
}

// Schedule upserts cron schedules, six fields with seconds first, in UTC
func (s *Service) Schedule(specs ...dbos.ScheduleSpec) error {
	return dbos.ApplySchedules(s.ctx, specs)
}

// Status returns the stored state of a workflow by id
func (s *Service) Status(id string) (dbos.WorkflowStatus, error) {
	h, err := dbos.RetrieveWorkflow[any](s.ctx, id)
	if err != nil {
		return dbos.WorkflowStatus{}, err
	}
	return h.GetStatus()
}
