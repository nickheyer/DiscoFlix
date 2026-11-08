package presence

import (
	"slices"
	"sync"
	"testing"
)

// Keeps every effective status change in arrival order
type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) record(userID string, s Status) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, userID+"="+string(s))
}

// Returns the changes seen since the last call and forgets them
func (r *recorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.events
	r.events = nil
	return out
}

func expect(t *testing.T, rec *recorder, want ...string) {
	t.Helper()
	if got := rec.take(); !slices.Equal(got, want) {
		t.Fatalf("changes = %v, want %v", got, want)
	}
}

func TestWebConnectionsAreCounted(t *testing.T) {
	rec := &recorder{}
	tr := New(rec.record)
	if tr.Status("a") != Offline {
		t.Fatalf("unknown user = %s", tr.Status("a"))
	}
	tr.Connect("a")
	tr.Connect("a")
	if tr.Status("a") != Online {
		t.Fatalf("two tabs = %s", tr.Status("a"))
	}
	expect(t, rec, "a=online")
	tr.Disconnect("a")
	if tr.Status("a") != Online {
		t.Fatalf("one tab left = %s", tr.Status("a"))
	}
	expect(t, rec)
	tr.Disconnect("a")
	if tr.Status("a") != Offline {
		t.Fatalf("no tabs left = %s", tr.Status("a"))
	}
	expect(t, rec, "a=offline")
}

func TestRemoteStatus(t *testing.T) {
	rec := &recorder{}
	tr := New(rec.record)
	tr.SetRemote("b", Idle)
	if tr.Status("b") != Idle {
		t.Fatalf("remote idle = %s", tr.Status("b"))
	}
	tr.SetRemote("b", DND)
	tr.SetRemote("b", DND)
	if tr.Status("b") != DND {
		t.Fatalf("remote dnd = %s", tr.Status("b"))
	}
	tr.SetRemote("b", Offline)
	tr.SetRemote("b", "")
	if tr.Status("b") != Offline {
		t.Fatalf("remote offline = %s", tr.Status("b"))
	}
	expect(t, rec, "b=idle", "b=dnd", "b=offline")
}

func TestWebOnlineBeatsRemote(t *testing.T) {
	rec := &recorder{}
	tr := New(rec.record)
	tr.SetRemote("c", Idle)
	tr.Connect("c")
	if tr.Status("c") != Online {
		t.Fatalf("web over remote idle = %s", tr.Status("c"))
	}
	tr.SetRemote("c", DND)
	if tr.Status("c") != Online {
		t.Fatalf("web over remote dnd = %s", tr.Status("c"))
	}
	expect(t, rec, "c=idle", "c=online")
	tr.Disconnect("c")
	if tr.Status("c") != DND {
		t.Fatalf("remote after web closes = %s", tr.Status("c"))
	}
	tr.SetRemote("c", Offline)
	expect(t, rec, "c=dnd", "c=offline")
}

func TestDisconnectBelowZeroStaysOffline(t *testing.T) {
	rec := &recorder{}
	tr := New(rec.record)
	tr.Disconnect("d")
	tr.Disconnect("d")
	if tr.Status("d") != Offline {
		t.Fatalf("after stray disconnects = %s", tr.Status("d"))
	}
	expect(t, rec)
	tr.Connect("d")
	if tr.Status("d") != Online {
		t.Fatalf("one connect after stray disconnects = %s", tr.Status("d"))
	}
	tr.Disconnect("d")
	if tr.Status("d") != Offline {
		t.Fatalf("balanced disconnect = %s", tr.Status("d"))
	}
	expect(t, rec, "d=online", "d=offline")
	tr.mu.Lock()
	_, kept := tr.web["d"]
	tr.mu.Unlock()
	if kept {
		t.Fatal("zero connection count kept in the map")
	}
}

func TestNilCallbackAndConcurrency(t *testing.T) {
	tr := New(nil)
	var wg sync.WaitGroup
	for range 32 {
		wg.Go(func() {
			tr.Connect("e")
			tr.SetRemote("e", Idle)
			tr.Disconnect("e")
		})
	}
	wg.Wait()
	if tr.Status("e") != Idle {
		t.Fatalf("after balanced connects = %s", tr.Status("e"))
	}
}
