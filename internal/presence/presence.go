// Package presence merges web connections and Discord status into one online state per user
package presence

import (
	"sync"
)

// Status is one user's effective presence
type Status string

const (
	Online  Status = "online"
	Idle    Status = "idle"
	DND     Status = "dnd"
	Offline Status = "offline"
)

// Tracker counts live web connections and remembers the last remote status per user
type Tracker struct {
	mu       sync.Mutex
	web      map[string]int
	remote   map[string]Status
	onChange func(userID string, status Status)
}

// New builds a tracker that calls onChange whenever a user's effective status changes
func New(onChange func(userID string, status Status)) *Tracker {
	return &Tracker{web: map[string]int{}, remote: map[string]Status{}, onChange: onChange}
}

// Connect records one more live web connection for the user
func (t *Tracker) Connect(userID string) {
	t.mu.Lock()
	before := t.status(userID)
	t.web[userID]++
	after := t.status(userID)
	t.mu.Unlock()
	t.notify(userID, before, after)
}

// Disconnect records one closed web connection for the user
func (t *Tracker) Disconnect(userID string) {
	t.mu.Lock()
	before := t.status(userID)
	if t.web[userID] <= 1 {
		delete(t.web, userID)
	} else {
		t.web[userID]--
	}
	after := t.status(userID)
	t.mu.Unlock()
	t.notify(userID, before, after)
}

// SetRemote stores the status a remote transport such as Discord reports for the user
func (t *Tracker) SetRemote(userID string, status Status) {
	t.mu.Lock()
	before := t.status(userID)
	if status == Offline || status == "" {
		delete(t.remote, userID)
	} else {
		t.remote[userID] = status
	}
	after := t.status(userID)
	t.mu.Unlock()
	t.notify(userID, before, after)
}

// Status returns the user's effective presence, a live web connection always counts as online
func (t *Tracker) Status(userID string) Status {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.status(userID)
}

func (t *Tracker) status(userID string) Status {
	if t.web[userID] > 0 {
		return Online
	}
	if s, ok := t.remote[userID]; ok {
		return s
	}
	return Offline
}

func (t *Tracker) notify(userID string, before, after Status) {
	if before != after && t.onChange != nil {
		t.onChange(userID, after)
	}
}
