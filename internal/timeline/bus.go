// Package timeline stores every Message and fans events out to every transport
package timeline

import (
	"sync"

	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

// Publisher delivers an encoded event to realtime subscribers of one channel name
type Publisher interface {
	Publish(channel string, data []byte) error
}

// Subscription receives live events until Close or until the subscriber lags
type Subscription struct {
	C      chan *timelinev1.Event
	lagged bool
	once   sync.Once
	bus    *bus
}

// Lagged reports whether events were dropped because the subscriber fell behind
func (s *Subscription) Lagged() bool { return s.lagged }

// Close detaches the subscription
func (s *Subscription) Close() { s.bus.remove(s) }

// bus fans events to in-process subscribers without blocking the writer
type bus struct {
	mu   sync.Mutex
	subs map[*Subscription]struct{}
}

func newBus() *bus { return &bus{subs: map[*Subscription]struct{}{}} }

func (b *bus) subscribe(buffer int) *Subscription {
	s := &Subscription{C: make(chan *timelinev1.Event, buffer), bus: b}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	return s
}

func (b *bus) remove(s *Subscription) {
	b.mu.Lock()
	_, ok := b.subs[s]
	delete(b.subs, s)
	b.mu.Unlock()
	if ok {
		s.once.Do(func() { close(s.C) })
	}
}

// publish delivers to every subscriber, closing the ones whose buffer is full
func (b *bus) publish(ev *timelinev1.Event) {
	b.mu.Lock()
	var lagged []*Subscription
	for s := range b.subs {
		select {
		case s.C <- ev:
		default:
			s.lagged = true
			lagged = append(lagged, s)
		}
	}
	b.mu.Unlock()
	for _, s := range lagged {
		b.remove(s)
	}
}
