package timeline

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/nickheyer/DiscoFlix/internal/presence"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/authzoutbox"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/schema"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

func newPerson(t *testing.T, st *store.Store, name string) *ent.User {
	t.Helper()
	u, err := st.Ent.User.Create().SetDisplayName(name).SetKind(user.KindPerson).Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// Makes the user a plain member of the system space so its channels list for them
func joinSystem(t *testing.T, svc *Service, st *store.Store, userID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := st.Ent.Tx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := Join(ctx, tx, userID, svc.SystemSpaceID()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

// Decodes every event published on one realtime channel name in publish order
func (c *capture) events(t *testing.T, name string) []*timelinev1.Event {
	t.Helper()
	c.mu.Lock()
	raw := slices.Clone(c.msgs[name])
	c.mu.Unlock()
	out := make([]*timelinev1.Event, 0, len(raw))
	for _, data := range raw {
		ev := &timelinev1.Event{}
		if err := protojson.Unmarshal(data, ev); err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	return out
}

func ofKind(evs []*timelinev1.Event, kind timelinev1.EventKind) []*timelinev1.Event {
	var out []*timelinev1.Event
	for _, ev := range evs {
		if ev.GetKind() == kind {
			out = append(out, ev)
		}
	}
	return out
}

func seqsOf(rows []*ent.Message) []int64 {
	out := make([]int64, len(rows))
	for i, m := range rows {
		out[i] = m.ID
	}
	return out
}

// Fails unless the unsynced and stale lists of a channel hold exactly the given seqs
func expectQueues(t *testing.T, svc *Service, channelID string, unsynced, stale []int64) {
	t.Helper()
	ctx := context.Background()
	u, err := svc.Unsynced(ctx, channelID, 50)
	if err != nil {
		t.Fatal(err)
	}
	s, err := svc.Stale(ctx, channelID, 50)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(seqsOf(u), unsynced) || !slices.Equal(seqsOf(s), stale) {
		t.Fatalf("unsynced = %v want %v, stale = %v want %v", seqsOf(u), unsynced, seqsOf(s), stale)
	}
}

func newGuild(t *testing.T, svc *Service) (*ent.Space, *ent.Channel) {
	t.Helper()
	ctx := context.Background()
	sp, _, err := svc.UpsertSpace(ctx, SpaceInput{Kind: space.KindGuild, ExternalID: "g1", Name: "Guild"})
	if err != nil {
		t.Fatal(err)
	}
	ch, _, err := svc.UpsertChannel(ctx, ChannelInput{SpaceID: sp.ID, ExternalID: "c1", Kind: channel.KindText, Name: "chat", Open: true})
	if err != nil {
		t.Fatal(err)
	}
	return sp, ch
}

func TestMirroredPostIsSynced(t *testing.T) {
	ctx := context.Background()
	svc, _, st := newService(t)
	alice := newPerson(t, st, "alice")
	general := svc.SystemChannelID("general")
	past := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	posted, err := svc.Post(ctx, PostInput{ChannelID: general, AuthorID: alice.ID, Content: "from discord", External: "111", Origin: OriginDiscord, CreatedAt: past, Synced: true})
	if err != nil {
		t.Fatal(err)
	}
	row, err := svc.GetMessage(ctx, posted.GetSeq())
	if err != nil || row.SyncedAt == nil || !row.CreatedAt.Equal(past) {
		t.Fatalf("row = %+v, %v", row, err)
	}
	expectQueues(t, svc, general, nil, nil)
	found, err := svc.MessageByExternalID(ctx, "111")
	if err != nil || found.ID != posted.GetSeq() {
		t.Fatalf("by external id = %v, %v", found, err)
	}
	pm := svc.Proto(found, alice.ID)
	if pm.GetOrigin() != OriginDiscord || pm.GetExternalId() != "111" || !pm.GetCreatedAt().AsTime().Equal(past) || pm.GetAuthor().GetId() != alice.ID || pm.GetContent() != "from discord" {
		t.Fatalf("proto = %v", pm)
	}
	if _, err := svc.MessageByExternalID(ctx, "222"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing external id = %v", err)
	}
}

func TestWebPostSyncCycle(t *testing.T) {
	ctx := context.Background()
	svc, _, st := newService(t)
	alice := newPerson(t, st, "alice")
	general := svc.SystemChannelID("general")
	m, err := svc.Post(ctx, PostInput{ChannelID: general, AuthorID: alice.ID, Content: "from the web", Origin: OriginWeb})
	if err != nil {
		t.Fatal(err)
	}
	seq := m.GetSeq()
	expectQueues(t, svc, general, []int64{seq}, nil)
	if err := svc.MarkSynced(ctx, seq, "123"); err != nil {
		t.Fatal(err)
	}
	if row, _ := svc.GetMessage(ctx, seq); row.ExternalID != "123" || row.SyncedAt == nil {
		t.Fatalf("after mark synced = %+v", row)
	}
	expectQueues(t, svc, general, nil, nil)

	if _, err := svc.Edit(ctx, seq, "edited on the web", Change{Origin: OriginWeb}); err != nil {
		t.Fatal(err)
	}
	expectQueues(t, svc, general, nil, []int64{seq})
	if err := svc.MarkSynced(ctx, seq, ""); err != nil {
		t.Fatal(err)
	}
	if row, _ := svc.GetMessage(ctx, seq); row.ExternalID != "123" {
		t.Fatalf("empty external id overwrote the stored one = %q", row.ExternalID)
	}
	expectQueues(t, svc, general, nil, nil)

	if _, err := svc.Edit(ctx, seq, "edited in discord", Change{Origin: OriginDiscord, Synced: true}); err != nil {
		t.Fatal(err)
	}
	expectQueues(t, svc, general, nil, nil)
	if err := svc.Delete(ctx, seq, Change{Origin: OriginDiscord, Synced: true}); err != nil {
		t.Fatal(err)
	}
	if row, _ := svc.GetMessage(ctx, seq); row.DeletedAt == nil {
		t.Fatal("delete did not tombstone")
	}
	expectQueues(t, svc, general, nil, nil)

	second, err := svc.Post(ctx, PostInput{ChannelID: general, AuthorID: alice.ID, Content: "delete me from the web", Origin: OriginWeb})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.MarkSynced(ctx, second.GetSeq(), "124"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Delete(ctx, second.GetSeq(), Change{Origin: OriginWeb}); err != nil {
		t.Fatal(err)
	}
	expectQueues(t, svc, general, nil, []int64{second.GetSeq()})

	var queued []int64
	for i := range 3 {
		p, err := svc.Post(ctx, PostInput{ChannelID: general, AuthorID: alice.ID, Content: "queued " + strconv.Itoa(i), Origin: OriginWeb})
		if err != nil {
			t.Fatal(err)
		}
		queued = append(queued, p.GetSeq())
	}
	rows, err := svc.Unsynced(ctx, general, 2)
	if err != nil || !slices.Equal(seqsOf(rows), queued[:2]) || rows[0].Edges.Author == nil {
		t.Fatalf("limited unsynced = %v, %v", seqsOf(rows), err)
	}
	if err := svc.MarkSynced(ctx, 999999, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mark missing = %v", err)
	}
}

func TestReactions(t *testing.T) {
	ctx := context.Background()
	svc, pub, st := newService(t)
	alice := newPerson(t, st, "alice")
	bob := newPerson(t, st, "bob")
	general := svc.SystemChannelID("general")
	m, err := svc.Post(ctx, PostInput{ChannelID: general, AuthorID: alice.ID, Content: "react to me", Origin: OriginWeb})
	if err != nil {
		t.Fatal(err)
	}
	seq := m.GetSeq()
	if err := svc.MarkSynced(ctx, seq, "300"); err != nil {
		t.Fatal(err)
	}

	pm, added, err := svc.AddReaction(ctx, seq, alice.ID, "👍", OriginWeb)
	if err != nil || !added || len(pm.GetReactions()) != 1 || pm.GetReactions()[0].GetCount() != 1 || !pm.GetReactions()[0].GetMe() {
		t.Fatalf("first reaction = %v, %v, %v", pm, added, err)
	}
	expectQueues(t, svc, general, nil, []int64{seq})
	if err := svc.MarkSynced(ctx, seq, ""); err != nil {
		t.Fatal(err)
	}
	pm, added, err = svc.AddReaction(ctx, seq, alice.ID, "👍", OriginWeb)
	if err != nil || added || pm.GetReactions()[0].GetCount() != 1 {
		t.Fatalf("repeated reaction = %v, %v, %v", pm, added, err)
	}
	expectQueues(t, svc, general, nil, nil)
	pm, added, err = svc.AddReaction(ctx, seq, bob.ID, "👍", OriginDiscord)
	if err != nil || !added || pm.GetReactions()[0].GetCount() != 2 || !pm.GetReactions()[0].GetMe() {
		t.Fatalf("second reactor = %v, %v, %v", pm, added, err)
	}
	if _, _, err := svc.AddReaction(ctx, seq, bob.ID, "🎉", OriginDiscord); err != nil {
		t.Fatal(err)
	}
	expectQueues(t, svc, general, nil, nil)

	rows, err := svc.Reactors(ctx, seq)
	if err != nil || len(rows) != 3 {
		t.Fatalf("reactors = %v, %v", rows, err)
	}
	row, err := svc.GetMessage(ctx, seq)
	if err != nil {
		t.Fatal(err)
	}
	got := svc.Proto(row, alice.ID).GetReactions()
	if len(got) != 2 || got[0].GetEmoji() != "👍" || got[0].GetCount() != 2 || !got[0].GetMe() || got[1].GetEmoji() != "🎉" || got[1].GetCount() != 1 || got[1].GetMe() {
		t.Fatalf("proto reactions = %v", got)
	}

	pm, removed, err := svc.RemoveReaction(ctx, seq, alice.ID, "👍", OriginWeb)
	if err != nil || !removed || pm.GetReactions()[0].GetCount() != 1 || pm.GetReactions()[0].GetMe() {
		t.Fatalf("remove = %v, %v, %v", pm, removed, err)
	}
	expectQueues(t, svc, general, nil, []int64{seq})
	if err := svc.MarkSynced(ctx, seq, ""); err != nil {
		t.Fatal(err)
	}
	if _, removed, err := svc.RemoveReaction(ctx, seq, alice.ID, "👍", OriginWeb); err != nil || removed {
		t.Fatalf("remove twice = %v, %v", removed, err)
	}
	if err := svc.ClearReactions(ctx, seq, "🎉", OriginDiscord); err != nil {
		t.Fatal(err)
	}
	if rows, _ := svc.Reactors(ctx, seq); len(rows) != 1 || rows[0].Emoji != "👍" || rows[0].UserID != bob.ID {
		t.Fatalf("after clearing one emoji = %v", rows)
	}
	if err := svc.ClearReactions(ctx, seq, "", OriginDiscord); err != nil {
		t.Fatal(err)
	}
	if rows, _ := svc.Reactors(ctx, seq); len(rows) != 0 {
		t.Fatalf("after clearing all = %v", rows)
	}
	expectQueues(t, svc, general, nil, nil)

	evs := pub.events(t, ChannelName(svc.SystemSpaceID(), general))
	adds := ofKind(evs, timelinev1.EventKind_EVENT_KIND_REACTION_ADDED)
	removes := ofKind(evs, timelinev1.EventKind_EVENT_KIND_REACTION_REMOVED)
	if len(adds) != 3 || len(removes) != 3 {
		t.Fatalf("reaction events = %d added, %d removed", len(adds), len(removes))
	}
	first := adds[0]
	if r := first.GetReaction(); r.GetSeq() != seq || r.GetEmoji() != "👍" || r.GetUserId() != alice.ID || r.GetCount() != 1 ||
		first.GetOrigin() != OriginWeb || first.GetChannelId() != general || first.GetSpaceId() != svc.SystemSpaceID() {
		t.Fatalf("first added event = %v", first)
	}
	if r := removes[0].GetReaction(); r.GetUserId() != alice.ID || r.GetCount() != 1 || removes[0].GetOrigin() != OriginWeb {
		t.Fatalf("first removed event = %v", removes[0])
	}
	if r := removes[2].GetReaction(); r.GetUserId() != bob.ID || r.GetEmoji() != "👍" || r.GetCount() != 0 || removes[2].GetOrigin() != OriginDiscord {
		t.Fatalf("last removed event = %v", removes[2])
	}

	if err := svc.Delete(ctx, seq, Change{Origin: OriginWeb}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.AddReaction(ctx, seq, alice.ID, "👍", OriginWeb); !errors.Is(err, ErrNotFound) {
		t.Fatalf("react to deleted = %v", err)
	}
}

func TestMirrorStructure(t *testing.T) {
	ctx := context.Background()
	svc, _, st := newService(t)
	alice := newPerson(t, st, "alice")
	joinSystem(t, svc, st, alice.ID)
	roles := []schema.Role{{ID: "r1", Name: "Mods", Color: "#ff0000", Position: 2, Hoist: true}}
	in := SpaceInput{Kind: space.KindGuild, ExternalID: "g1", Name: "Guild", Roles: roles}
	sp, created, err := svc.UpsertSpace(ctx, in)
	if err != nil || !created || sp.Kind != space.KindGuild {
		t.Fatalf("create space = %v, %v, %v", sp, created, err)
	}
	again, created, err := svc.UpsertSpace(ctx, in)
	if err != nil || created || again.ID != sp.ID {
		t.Fatalf("same space = %v, %v, %v", again, created, err)
	}
	in.Name = "Renamed Guild"
	renamed, created, err := svc.UpsertSpace(ctx, in)
	if err != nil || created || renamed.ID != sp.ID || renamed.Name != "Renamed Guild" {
		t.Fatalf("rename space = %v, %v, %v", renamed, created, err)
	}
	if stored, _ := svc.GetSpace(ctx, sp.ID); stored.Name != "Renamed Guild" {
		t.Fatalf("stored name = %s", stored.Name)
	}
	if n, _ := st.Ent.Space.Query().Where(space.ExternalID("g1")).Count(ctx); n != 1 {
		t.Fatalf("guild rows = %d", n)
	}
	if _, _, err := svc.UpsertSpace(ctx, SpaceInput{Kind: space.KindGuild, Name: "no id"}); err == nil {
		t.Fatal("space without external id accepted")
	}
	if got, err := svc.SpaceByExternalID(ctx, space.KindGuild, "g1"); err != nil || got.ID != sp.ID {
		t.Fatalf("space by external id = %v, %v", got, err)
	}
	if _, err := svc.SpaceByExternalID(ctx, space.KindGuild, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing space = %v", err)
	}

	chIn := ChannelInput{SpaceID: sp.ID, ExternalID: "c1", Kind: channel.KindText, Name: "chat", Position: 1, Open: true}
	ch, created, err := svc.UpsertChannel(ctx, chIn)
	if err != nil || !created {
		t.Fatalf("create channel = %v, %v, %v", ch, created, err)
	}
	same, created, err := svc.UpsertChannel(ctx, chIn)
	if err != nil || created || same.ID != ch.ID {
		t.Fatalf("same channel = %v, %v, %v", same, created, err)
	}
	chIn.Topic = "announcements"
	updated, created, err := svc.UpsertChannel(ctx, chIn)
	if err != nil || created || updated.ID != ch.ID || updated.Topic != "announcements" {
		t.Fatalf("update channel = %v, %v, %v", updated, created, err)
	}
	if got, err := svc.ChannelByExternalID(ctx, "c1"); err != nil || got.ID != ch.ID {
		t.Fatalf("channel by external id = %v, %v", got, err)
	}

	member := MemberInput{UserID: alice.ID, SpaceID: sp.ID, Roles: []string{"r1"}, Nickname: "Ali", Admin: true}
	if created, err := svc.UpsertMember(ctx, member); err != nil || !created {
		t.Fatalf("create member = %v, %v", created, err)
	}
	if created, err := svc.UpsertMember(ctx, member); err != nil || created {
		t.Fatalf("same member = %v, %v", created, err)
	}
	members, gotRoles, err := svc.ListMembers(ctx, sp.ID)
	if err != nil || len(members) != 1 {
		t.Fatalf("members = %v, %v", members, err)
	}
	if mb := members[0]; mb.GetUser().GetId() != alice.ID || !slices.Equal(mb.GetRoles(), []string{"r1"}) || mb.GetNickname() != "Ali" || !mb.GetAdmin() || mb.GetPresence() != "offline" {
		t.Fatalf("member = %v", mb)
	}
	if len(gotRoles) != 1 || gotRoles[0].GetId() != "r1" || gotRoles[0].GetName() != "Mods" || gotRoles[0].GetColor() != "#ff0000" || gotRoles[0].GetPosition() != 2 || !gotRoles[0].GetHoist() {
		t.Fatalf("roles = %v", gotRoles)
	}

	chans, err := svc.ListChannels(ctx, alice.ID, sp.ID)
	if err != nil || len(chans) != 1 || chans[0].GetId() != ch.ID || chans[0].GetMaxContent() != MaxMirroredContent || chans[0].GetTopic() != "announcements" {
		t.Fatalf("guild channels = %v, %v", chans, err)
	}
	sysChans, err := svc.ListChannels(ctx, alice.ID, svc.SystemSpaceID())
	if err != nil || len(sysChans) != len(SystemChannels) {
		t.Fatalf("system channels = %v, %v", sysChans, err)
	}
	for _, c := range sysChans {
		if c.GetMaxContent() != MaxContent {
			t.Fatalf("system channel %s max content = %d", c.GetName(), c.GetMaxContent())
		}
	}

	if err := svc.DeleteChannel(ctx, ch.ID); err != nil {
		t.Fatal(err)
	}
	if chans, _ := svc.ListChannels(ctx, alice.ID, sp.ID); len(chans) != 0 {
		t.Fatalf("deleted channel still listed = %v", chans)
	}
	if _, err := svc.ChannelByExternalID(ctx, "c1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted channel by external id = %v", err)
	}
	if err := svc.DeleteChannel(ctx, ch.ID); err != nil {
		t.Fatalf("delete twice = %v", err)
	}
	revived, created, err := svc.UpsertChannel(ctx, chIn)
	if err != nil || created || revived.ID != ch.ID || revived.DeletedAt != nil {
		t.Fatalf("revive channel = %v, %v, %v", revived, created, err)
	}
	if chans, _ := svc.ListChannels(ctx, alice.ID, sp.ID); len(chans) != 1 {
		t.Fatalf("revived channel listed = %v", chans)
	}

	if err := svc.RemoveMember(ctx, alice.ID, sp.ID); err != nil {
		t.Fatal(err)
	}
	if members, _, _ := svc.ListMembers(ctx, sp.ID); len(members) != 0 {
		t.Fatalf("members after remove = %v", members)
	}
	if chans, err := svc.ListChannels(ctx, alice.ID, sp.ID); err != nil || len(chans) != 0 {
		t.Fatalf("channels listed for a removed member = %v, %v", chans, err)
	}
	removals, err := st.Ent.AuthzOutbox.Query().Where(authzoutbox.Object("space:"+sp.ID), authzoutbox.Subject("user:"+alice.ID), authzoutbox.OpEQ(authzoutbox.OpDelete)).All(ctx)
	if err != nil || len(removals) != 2 {
		t.Fatalf("staged removals = %v, %v", removals, err)
	}
	if err := svc.RemoveMember(ctx, alice.ID, sp.ID); err != nil {
		t.Fatalf("remove twice = %v", err)
	}
}

// Records what a mirrored channel asks the transport to create and answers with a fixed id
type fakeThreads struct {
	id, parent, name, from string
}

func (f *fakeThreads) CreateThread(_ context.Context, parent *ent.Channel, name, fromExternalID string) (string, error) {
	f.parent, f.name, f.from = parent.ID, name, fromExternalID
	return f.id, nil
}

// Maps each relation written to the outbox for an object to its subject
func staged(t *testing.T, st *store.Store, object string) map[string]string {
	t.Helper()
	rows, err := st.Ent.AuthzOutbox.Query().Where(authzoutbox.Object(object), authzoutbox.OpEQ(authzoutbox.OpWrite)).All(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, r := range rows {
		out[r.Relation] = r.Subject
	}
	return out
}

func TestCreateThread(t *testing.T) {
	ctx := context.Background()
	svc, _, st := newService(t)
	alice := newPerson(t, st, "alice")
	joinSystem(t, svc, st, alice.ID)
	general := svc.SystemChannelID("general")
	hello, err := svc.Post(ctx, PostInput{ChannelID: general, AuthorID: alice.ID, Content: "start here", Origin: OriginWeb})
	if err != nil {
		t.Fatal(err)
	}
	th, err := svc.CreateThread(ctx, general, "side chat", hello.GetSeq())
	if err != nil || th.Kind != channel.KindThread || th.ParentID != general || th.SpaceID != svc.SystemSpaceID() || th.Name != "side chat" || th.ExternalID != "" {
		t.Fatalf("system thread = %+v, %v", th, err)
	}
	tuples := staged(t, st, "channel:"+th.ID)
	if tuples["space"] != "space:"+svc.SystemSpaceID() || tuples["open"] != "user:*" || tuples["post"] != "user:*" {
		t.Fatalf("thread tuples = %v", tuples)
	}
	chans, err := svc.ListChannels(ctx, alice.ID, svc.SystemSpaceID())
	if err != nil {
		t.Fatal(err)
	}
	idx := slices.IndexFunc(chans, func(c *timelinev1.Channel) bool { return c.GetId() == th.ID })
	if idx < 0 || chans[idx].GetKind() != timelinev1.ChannelKind_CHANNEL_KIND_THREAD || chans[idx].GetParentId() != general {
		t.Fatalf("thread listing = %v", chans)
	}
	elsewhere, err := svc.PostSystem(ctx, "audit", "elsewhere", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateThread(ctx, general, "wrong parent", elsewhere.GetSeq()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("thread from another channel's message = %v", err)
	}
	if _, err := svc.CreateThread(ctx, "missing", "x", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("thread under missing channel = %v", err)
	}

	_, guildCh := newGuild(t, svc)
	if _, err := svc.CreateThread(ctx, guildCh.ID, "guild thread", 0); !errors.Is(err, ErrNoThreads) {
		t.Fatalf("guild thread without a mirror = %v", err)
	}
	fake := &fakeThreads{id: "t-1"}
	svc.SetThreadCreator(fake)
	from, err := svc.Post(ctx, PostInput{ChannelID: guildCh.ID, AuthorID: alice.ID, Content: "thread me", External: "m9", Origin: OriginDiscord, Synced: true})
	if err != nil {
		t.Fatal(err)
	}
	gth, err := svc.CreateThread(ctx, guildCh.ID, "guild thread", from.GetSeq())
	if err != nil || gth.ExternalID != "t-1" || gth.ParentID != guildCh.ID || gth.Kind != channel.KindThread {
		t.Fatalf("guild thread = %+v, %v", gth, err)
	}
	if fake.parent != guildCh.ID || fake.name != "guild thread" || fake.from != "m9" {
		t.Fatalf("thread request = %+v", fake)
	}
	if tuples := staged(t, st, "channel:"+gth.ID); len(tuples) != 1 || tuples["space"] == "" {
		t.Fatalf("guild thread tuples = %v", tuples)
	}
	if err := svc.DeleteChannel(ctx, guildCh.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateThread(ctx, guildCh.ID, "too late", 0); !errors.Is(err, ErrChannelGone) {
		t.Fatalf("thread under deleted channel = %v", err)
	}
}

func TestTypingAndPresence(t *testing.T) {
	ctx := context.Background()
	svc, pub, st := newService(t)
	alice := newPerson(t, st, "alice")
	joinSystem(t, svc, st, alice.ID)
	sp, _ := newGuild(t, svc)
	if _, err := svc.UpsertMember(ctx, MemberInput{UserID: alice.ID, SpaceID: sp.ID}); err != nil {
		t.Fatal(err)
	}
	general := svc.SystemChannelID("general")
	sub := svc.Subscribe()
	defer sub.Close()

	userBefore, spaceBefore := pub.count(UserChannel(alice.ID)), pub.count(SpaceName(svc.SystemSpaceID()))
	if err := svc.Typing(ctx, general, alice.ID, "alice", OriginWeb); err != nil {
		t.Fatal(err)
	}
	evs := pub.events(t, ChannelName(svc.SystemSpaceID(), general))
	if len(evs) != 1 {
		t.Fatalf("channel events = %v", evs)
	}
	if ev := evs[0]; ev.GetKind() != timelinev1.EventKind_EVENT_KIND_TYPING || ev.GetOrigin() != OriginWeb ||
		ev.GetTyping().GetChannelId() != general || ev.GetTyping().GetUserId() != alice.ID || ev.GetTyping().GetDisplayName() != "alice" {
		t.Fatalf("typing event = %v", ev)
	}
	if pub.count(UserChannel(alice.ID)) != userBefore || pub.count(SpaceName(svc.SystemSpaceID())) != spaceBefore {
		t.Fatal("typing leaked past the channel topic")
	}
	select {
	case ev := <-sub.C:
		if ev.GetKind() != timelinev1.EventKind_EVENT_KIND_TYPING {
			t.Fatalf("bus event = %v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("typing missing from the bus")
	}
	if err := svc.Typing(ctx, "missing", alice.ID, "alice", OriginWeb); !errors.Is(err, ErrNotFound) {
		t.Fatalf("typing in missing channel = %v", err)
	}

	svc.PresenceChanged(alice.ID, presence.Idle)
	for _, spaceID := range []string{svc.SystemSpaceID(), sp.ID} {
		got := ofKind(pub.events(t, SpaceName(spaceID)), timelinev1.EventKind_EVENT_KIND_PRESENCE_CHANGED)
		if len(got) != 1 || got[0].GetSpaceId() != spaceID || got[0].GetChannelId() != "" ||
			got[0].GetPresence().GetUserId() != alice.ID || got[0].GetPresence().GetStatus() != "idle" {
			t.Fatalf("presence events in %s = %v", spaceID, got)
		}
	}

	tracker := presence.New(svc.PresenceChanged)
	svc.SetPresence(tracker)
	tracker.Connect(alice.ID)
	members, _, err := svc.ListMembers(ctx, sp.ID)
	if err != nil || len(members) != 1 || members[0].GetPresence() != "online" {
		t.Fatalf("members with tracker = %v, %v", members, err)
	}
	got := ofKind(pub.events(t, SpaceName(sp.ID)), timelinev1.EventKind_EVENT_KIND_PRESENCE_CHANGED)
	if len(got) != 2 || got[1].GetPresence().GetStatus() != "online" {
		t.Fatalf("presence after connect = %v", got)
	}
}

func TestSpaceOfAndApprovalsChannel(t *testing.T) {
	ctx := context.Background()
	svc, _, st := newService(t)
	alice := newPerson(t, st, "alice")
	sys := svc.SystemSpaceID()
	general, audit := svc.SystemChannelID("general"), svc.SystemChannelID("audit")
	m, err := svc.Post(ctx, PostInput{ChannelID: general, AuthorID: alice.ID, Content: "hi", Origin: OriginWeb})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ typ, id, want string }{
		{"space", "abc", "abc"},
		{"channel", general, sys},
		{"message", strconv.FormatInt(m.GetSeq(), 10), sys},
		{"system", "main", ""},
	} {
		if got, err := svc.SpaceOf(ctx, c.typ, c.id); err != nil || got != c.want {
			t.Fatalf("space of %s %s = %q, %v", c.typ, c.id, got, err)
		}
	}
	for _, c := range []struct{ typ, id string }{{"message", "nope"}, {"message", "999999"}, {"channel", "missing"}} {
		if _, err := svc.SpaceOf(ctx, c.typ, c.id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("space of %s %s = %v", c.typ, c.id, err)
		}
	}

	expect := func(spaceID, want string) {
		t.Helper()
		if got, err := svc.ApprovalsChannel(ctx, spaceID); err != nil || got != want {
			t.Fatalf("approvals channel of %q = %q, %v want %q", spaceID, got, err, want)
		}
	}
	expect("", audit)
	expect(sys, audit)
	if err := svc.SetApprovalsChannel(ctx, sys, general); err != nil {
		t.Fatal(err)
	}
	expect(sys, general)

	sp, guildCh := newGuild(t, svc)
	if err := svc.SetApprovalsChannel(ctx, sys, guildCh.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("approvals in another space's channel = %v", err)
	}
	expect(sys, general)
	expect(sp.ID, audit)
	category, _, err := svc.UpsertChannel(ctx, ChannelInput{SpaceID: sp.ID, ExternalID: "cat1", Kind: channel.KindCategory, Name: "Text Channels"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetApprovalsChannel(ctx, sp.ID, category.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("approvals in a category = %v", err)
	}
	if err := svc.SetApprovalsChannel(ctx, sp.ID, guildCh.ID); err != nil {
		t.Fatal(err)
	}
	expect(sp.ID, guildCh.ID)
	if err := svc.DeleteChannel(ctx, guildCh.ID); err != nil {
		t.Fatal(err)
	}
	expect(sp.ID, audit)
	if err := svc.SetApprovalsChannel(ctx, sys, ""); err != nil {
		t.Fatal(err)
	}
	expect(sys, audit)
	if _, err := svc.ApprovalsChannel(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("approvals of missing space = %v", err)
	}
	if err := svc.SetApprovalsChannel(ctx, "missing", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("set approvals of missing space = %v", err)
	}
}
