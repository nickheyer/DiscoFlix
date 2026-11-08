package timeline

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

// openAuthz grants every member every channel, so visibility filtering stays out of these tests
type openAuthz struct{ ent *ent.Client }

func (openAuthz) Flush(context.Context) error { return nil }

func (openAuthz) OnChange(func()) {}

func (openAuthz) ListUsers(context.Context, string, string) ([]string, bool, error) {
	return nil, true, nil
}

func (openAuthz) Has(context.Context, string, string, string) (bool, error) { return false, nil }

type capture struct {
	mu   sync.Mutex
	msgs map[string][][]byte
}

func (c *capture) Publish(ch string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.msgs == nil {
		c.msgs = map[string][][]byte{}
	}
	c.msgs[ch] = append(c.msgs[ch], data)
	return nil
}

func (c *capture) count(ch string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.msgs[ch])
}

func newService(t *testing.T) (*Service, *capture, *store.Store) {
	t.Helper()
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	st, err := store.Open(ctx, t.TempDir(), log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.Migrate(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	pub := &capture{}
	svc := New(st.Ent, openAuthz{ent: st.Ent}, pub, log)
	if err := svc.EnsureSystem(ctx, "Test Instance"); err != nil {
		t.Fatal(err)
	}
	return svc, pub, st
}

func TestSystemSpaceAndMessages(t *testing.T) {
	ctx := context.Background()
	svc, pub, st := newService(t)
	if err := svc.EnsureSystem(ctx, "Test Instance"); err != nil {
		t.Fatal(err)
	}
	alice, err := st.Ent.User.Create().SetDisplayName("alice").SetKind(user.KindPerson).Save(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := st.Ent.Tx(ctx)
	if err := Join(ctx, tx, alice.ID, svc.SystemSpaceID(), "admin"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	spaces, err := svc.ListSpaces(ctx, alice.ID)
	if err != nil || len(spaces) != 1 || spaces[0].GetName() != "Test Instance" {
		t.Fatalf("spaces = %v, %v", spaces, err)
	}
	chans, err := svc.ListChannels(ctx, alice.ID, svc.SystemSpaceID())
	if err != nil || len(chans) != len(SystemChannels) {
		t.Fatalf("channels = %d, %v", len(chans), err)
	}
	sub := svc.Subscribe()
	defer sub.Close()

	audit := svc.SystemChannelID("audit")
	boot, err := svc.PostSystem(ctx, "audit", "booted", &cardv1.BootReport{Version: "test", Mode: "headless"})
	if err != nil {
		t.Fatal(err)
	}
	if boot.GetKind() != timelinev1.MessageKind_MESSAGE_KIND_SYSTEM || boot.GetCard().GetTypeUrl() != "type.googleapis.com/discoflix.card.v1.BootReport" {
		t.Fatalf("boot message = %v", boot)
	}
	hello, err := svc.Post(ctx, PostInput{ChannelID: svc.SystemChannelID("general"), AuthorID: alice.ID, Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if hello.GetAuthor().GetDisplayName() != "alice" || hello.GetSeq() <= boot.GetSeq() {
		t.Fatalf("hello = %v", hello)
	}
	for range 2 {
		select {
		case ev := <-sub.C:
			if ev.GetKind() != timelinev1.EventKind_EVENT_KIND_MESSAGE_CREATED {
				t.Fatalf("event = %v", ev)
			}
		case <-time.After(time.Second):
			t.Fatal("no event")
		}
	}
	if pub.count(ChannelName(svc.SystemSpaceID(), audit)) != 1 {
		t.Fatalf("audit publications = %d", pub.count(ChannelName(svc.SystemSpaceID(), audit)))
	}
	if pub.count(UserChannel(alice.ID)) != 2 {
		t.Fatalf("user publications after two posts = %d", pub.count(UserChannel(alice.ID)))
	}

	chans, _ = svc.ListChannels(ctx, alice.ID, svc.SystemSpaceID())
	for _, c := range chans {
		if (c.GetName() == "audit" || c.GetName() == "general") && c.GetUnread() != 1 {
			t.Fatalf("unread %s = %d", c.GetName(), c.GetUnread())
		}
	}
	read, err := svc.MarkRead(ctx, alice.ID, audit, 0)
	if err != nil || read.GetUnread() != 0 || read.GetLastReadSeq() != boot.GetSeq() {
		t.Fatalf("mark read = %v, %v", read, err)
	}
	if pub.count(UserChannel(alice.ID)) != 3 {
		t.Fatalf("user publications after read = %d", pub.count(UserChannel(alice.ID)))
	}

	edited, err := svc.Edit(ctx, hello.GetSeq(), "hello again", Change{Origin: OriginWeb})
	if err != nil || edited.GetContent() != "hello again" || edited.GetEditedAt() == nil {
		t.Fatalf("edit = %v, %v", edited, err)
	}
	if err := svc.Delete(ctx, hello.GetSeq(), Change{Origin: OriginWeb}); err != nil {
		t.Fatal(err)
	}
	msgs, more, err := svc.ListMessages(ctx, alice.ID, svc.SystemChannelID("general"), 0, 10)
	if err != nil || more || len(msgs) != 1 || msgs[0].GetDeletedAt() == nil || msgs[0].GetContent() != "" {
		t.Fatalf("list after delete = %v, %v, %v", msgs, more, err)
	}
	events, err := svc.EventsAfter(ctx, 0, "", 10)
	if err != nil || len(events) != 2 || events[1].GetKind() != timelinev1.EventKind_EVENT_KIND_MESSAGE_DELETED {
		t.Fatalf("events after = %v, %v", events, err)
	}
	if _, err := svc.Edit(ctx, 999, "x", Change{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("edit missing = %v", err)
	}
}

func TestBusDropsLaggingSubscriber(t *testing.T) {
	b := newBus()
	s := b.subscribe(1)
	b.publish(&timelinev1.Event{Seq: 1})
	b.publish(&timelinev1.Event{Seq: 2})
	if _, open := <-s.C; !open {
		t.Fatal("first event missing")
	}
	if _, open := <-s.C; open || !s.Lagged() {
		t.Fatal("lagging subscriber not closed")
	}
}
