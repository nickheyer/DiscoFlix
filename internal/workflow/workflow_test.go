package workflow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
)

var stepCalls atomic.Int32

func addWorkflow(ctx dbos.Context, in int) (int, error) {
	a, err := Step(ctx, "double", 1, func(context.Context) (int, error) {
		stepCalls.Add(1)
		return in * 2, nil
	})
	if err != nil {
		return 0, err
	}
	return Step(ctx, "increment", 1, func(context.Context) (int, error) {
		stepCalls.Add(1)
		return a + 1, nil
	})
}

func TestRunAndIdempotentID(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	s, err := Open(context.Background(), dir, log)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	Register(s, "test.add", addWorkflow)
	if _, err := Run[int, int](s, addWorkflow, "wf-1", 20); err == nil || !isNotLaunched(err) {
		t.Fatalf("run before launch = %v", err)
	}
	if err := s.Launch(); err != nil {
		t.Fatal(err)
	}
	h, err := Run[int, int](s, addWorkflow, "wf-1", 20)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := h.GetResult(); err != nil || out != 41 {
		t.Fatalf("result = %d, %v", out, err)
	}
	again, err := Run[int, int](s, addWorkflow, "wf-1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := again.GetResult(); err != nil || out != 41 {
		t.Fatalf("replayed result = %d, %v", out, err)
	}
	if n := stepCalls.Load(); n != 2 {
		t.Fatalf("steps ran %d times, want 2", n)
	}
	st, err := s.Status("wf-1")
	if err != nil || st.Status != dbos.WorkflowStatusSuccess {
		t.Fatalf("status = %+v, %v", st, err)
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
		t.Fatal(err)
	}
}

func isNotLaunched(err error) bool { return errors.Is(err, ErrNotLaunched) }

var cancelCalls, flakyCalls atomic.Int32

func cancelledWorkflow(ctx dbos.Context, _ int) (int, error) {
	return Step(ctx, "cancelled", 3, func(context.Context) (int, error) {
		cancelCalls.Add(1)
		return 0, fmt.Errorf("copy staged rows: %w", context.Canceled)
	})
}

func flakyWorkflow(ctx dbos.Context, _ int) (int, error) {
	return Step(ctx, "flaky", 1, func(context.Context) (int, error) {
		flakyCalls.Add(1)
		return 0, errors.New("boom")
	})
}

func TestStepRetriesFailuresButNeverCancellation(t *testing.T) {
	s, err := Open(context.Background(), t.TempDir(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	Register(s, "test.cancelled", cancelledWorkflow)
	Register(s, "test.flaky", flakyWorkflow)
	if err := s.Launch(); err != nil {
		t.Fatal(err)
	}
	h, err := Run[int, int](s, cancelledWorkflow, "wf-cancelled", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.GetResult(); err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled step error = %v", err)
	}
	if n := cancelCalls.Load(); n != 1 {
		t.Fatalf("cancelled step ran %d times, want 1", n)
	}
	f, err := Run[int, int](s, flakyWorkflow, "wf-flaky", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.GetResult(); err == nil || !errors.Is(err, dbos.ErrMaxStepRetriesExceeded) {
		t.Fatalf("flaky step error = %v", err)
	}
	if n := flakyCalls.Load(); n != 2 {
		t.Fatalf("flaky step ran %d times, want 2", n)
	}
}
