package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/realtime"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
)

type stack struct {
	ids *Service
	tl  *timeline.Service
	az  *authz.Service
	st  *store.Store
}

// Opens the store, embedded OpenFGA, realtime node, timeline, and identity service in a temp dir
func newStack(t *testing.T) *stack {
	t.Helper()
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	dir := t.TempDir()
	st, err := store.Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.Migrate(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	az, err := authz.Open(ctx, dir, st.Ent, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(az.Close)
	node, err := realtime.New(log, "test", func(context.Context, string, string) (bool, error) { return true, nil }, realtime.Hooks{})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.Run(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = node.Shutdown(ctx) })
	tl := timeline.New(st.Ent, az, node, log)
	if err := tl.EnsureSystem(ctx, "DiscoFlix"); err != nil {
		t.Fatal(err)
	}
	secrets, err := config.OpenSecrets(dir)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := Open(ctx, dir, secrets, st.Ent, az, tl, Build{Version: "test"}, false, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ids.Close() })
	return &stack{ids: ids, tl: tl, az: az, st: st}
}

// Creates a person whose only sign-in is a username on this server
func (s *stack) localUser(t *testing.T, name, username string) *ent.User {
	t.Helper()
	ctx := context.Background()
	u, err := s.st.Ent.User.Create().SetDisplayName(name).SetKind(user.KindPerson).Save(ctx)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := s.st.Ent.Identity.Create().SetUserID(u.ID).SetProvider("local").SetSubject(username).SetDisplay(username).SetVerifiedAt(now).SetLinkedAt(now).Save(ctx); err != nil {
		t.Fatal(err)
	}
	return u
}

func (s *stack) allowed(t *testing.T, subject, relation, object string) bool {
	t.Helper()
	ok, err := s.az.Check(context.Background(), subject, relation, object, nil)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func memberIDs(t *testing.T, tl *timeline.Service, spaceID string) []string {
	t.Helper()
	members, _, err := tl.ListMembers(context.Background(), spaceID)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(members))
	for i, m := range members {
		out[i] = m.GetUser().GetId()
	}
	return out
}

func TestEnsureExternalUser(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	in := ExternalUser{Provider: "discord", Subject: "42", DisplayName: "  Dee  ", AvatarURL: "https://cdn/a1.png"}
	u, created, err := s.ids.EnsureExternalUser(ctx, in)
	if err != nil || !created || u.DisplayName != "Dee" || u.Kind != user.KindPerson || u.AvatarURL != "https://cdn/a1.png" {
		t.Fatalf("first sight = %+v, %v, %v", u, created, err)
	}
	if !s.allowed(t, "user:"+u.ID, "member", authz.SystemObject) {
		t.Fatal("external user is not a system member")
	}
	in.DisplayName, in.AvatarURL = "Dee Two", "https://cdn/a2.png"
	again, created, err := s.ids.EnsureExternalUser(ctx, in)
	if err != nil || created || again.ID != u.ID || again.DisplayName != "Dee Two" || again.AvatarURL != "https://cdn/a2.png" {
		t.Fatalf("second sight = %+v, %v, %v", again, created, err)
	}
	if stored, _ := s.st.Ent.User.Get(ctx, u.ID); stored.DisplayName != "Dee Two" {
		t.Fatalf("stored name = %s", stored.DisplayName)
	}
	if n, _ := s.st.Ent.User.Query().Count(ctx); n != 2 {
		t.Fatalf("users after two sightings = %d, want the bot and one person", n)
	}

	now := time.Now()
	if _, err := s.st.Ent.Identity.Create().SetUserID(u.ID).SetProvider("local").SetSubject("dee").SetDisplay("dee").SetLinkedAt(now).Save(ctx); err != nil {
		t.Fatal(err)
	}
	in.DisplayName, in.AvatarURL = "Remote Rename", "https://cdn/a3.png"
	linked, _, err := s.ids.EnsureExternalUser(ctx, in)
	if err != nil || linked.DisplayName != "Dee Two" || linked.AvatarURL != "https://cdn/a3.png" {
		t.Fatalf("rename with a second identity = %+v, %v", linked, err)
	}
	if stored, _ := s.st.Ent.User.Get(ctx, u.ID); stored.DisplayName != "Dee Two" || stored.AvatarURL != "https://cdn/a3.png" {
		t.Fatalf("stored after second identity = %+v", stored)
	}

	bot, created, err := s.ids.EnsureExternalUser(ctx, ExternalUser{Provider: "discord", Subject: "77", Bot: true})
	if err != nil || !created || bot.Kind != user.KindBot || bot.DisplayName != "77" {
		t.Fatalf("bot = %+v, %v, %v", bot, created, err)
	}
	if _, err := s.ids.UserByIdentity(ctx, "discord", "nobody"); !errors.Is(err, ErrUnknownUser) {
		t.Fatalf("unknown identity = %v", err)
	}
}

func TestLinkIdentityMergesAndReverts(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	local := s.localUser(t, "Nick", "nick")
	synced, _, err := s.ids.EnsureExternalUser(ctx, ExternalUser{Provider: "discord", Subject: "1001", DisplayName: "nick_dc"})
	if err != nil {
		t.Fatal(err)
	}
	sp, _, err := s.tl.UpsertSpace(ctx, timeline.SpaceInput{Kind: space.KindGuild, ExternalID: "g1", Name: "Guild"})
	if err != nil {
		t.Fatal(err)
	}
	ch, _, err := s.tl.UpsertChannel(ctx, timeline.ChannelInput{SpaceID: sp.ID, ExternalID: "c1", Kind: channel.KindText, Name: "chat", Open: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.tl.UpsertMember(ctx, timeline.MemberInput{UserID: synced.ID, SpaceID: sp.ID, Roles: []string{"r1"}, Nickname: "nicky", Admin: true}); err != nil {
		t.Fatal(err)
	}
	posted, err := s.tl.Post(ctx, timeline.PostInput{ChannelID: ch.ID, AuthorID: synced.ID, Content: "hello from discord", External: "m1", Origin: timeline.OriginDiscord, Synced: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := memberIDs(t, s.tl, sp.ID); !slices.Equal(got, []string{synced.ID}) {
		t.Fatalf("members before merge = %v", got)
	}

	id, merged, err := s.ids.LinkIdentity(ctx, local.ID, "discord", "1001", "nick_dc", Meta{})
	if err != nil || !merged || id.UserID != local.ID || id.VerifiedAt == nil {
		t.Fatalf("link = %+v, %v, %v", id, merged, err)
	}
	if row, _ := s.st.Ent.User.Get(ctx, synced.ID); row.MergedIntoID != local.ID {
		t.Fatalf("merged_into = %q", row.MergedIntoID)
	}
	if got := memberIDs(t, s.tl, sp.ID); !slices.Equal(got, []string{local.ID}) {
		t.Fatalf("members after merge = %v", got)
	}
	members, _, _ := s.tl.ListMembers(ctx, sp.ID)
	if mb := members[0]; !slices.Equal(mb.GetRoles(), []string{"r1"}) || mb.GetNickname() != "nicky" || !mb.GetAdmin() || mb.GetExternalId() != "1001" {
		t.Fatalf("carried membership = %v", mb)
	}
	if !s.allowed(t, "user:"+local.ID, "admin", "space:"+sp.ID) || !s.allowed(t, "user:"+local.ID, "reader", "channel:"+ch.ID) {
		t.Fatal("survivor did not gain the merged user's space tuples")
	}
	if u, err := s.ids.UserByIdentity(ctx, "discord", "1001"); err != nil || u.ID != local.ID {
		t.Fatalf("identity resolves to = %v, %v", u, err)
	}
	if u, err := s.ids.GetUser(ctx, synced.ID); err != nil || u.ID != local.ID {
		t.Fatalf("merged user resolves to = %v, %v", u, err)
	}
	users, err := s.ids.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(users, func(u *ent.User) bool { return u.ID == synced.ID }) || !slices.ContainsFunc(users, func(u *ent.User) bool { return u.ID == local.ID }) {
		t.Fatalf("listed users = %v", users)
	}
	row, err := s.tl.GetMessage(ctx, posted.GetSeq())
	if err != nil {
		t.Fatal(err)
	}
	if author := s.tl.Proto(row, "").GetAuthor(); author.GetId() != local.ID || author.GetDisplayName() != "Nick" {
		t.Fatalf("message author after merge = %v", author)
	}
	merges, err := s.ids.ListMerges(ctx)
	if err != nil || len(merges) != 1 || merges[0].FromUserID != synced.ID || merges[0].IntoUserID != local.ID || !slices.Equal(merges[0].AddedSpaceIds, []string{sp.ID}) {
		t.Fatalf("merges = %v, %v", merges, err)
	}
	if again, merged, err := s.ids.LinkIdentity(ctx, local.ID, "discord", "1001", "nick_dc2", Meta{}); err != nil || merged || again.ID != id.ID || again.Display != "nick_dc2" {
		t.Fatalf("relink own identity = %+v, %v, %v", again, merged, err)
	}

	actor := capability.Principal{UserID: local.ID, DisplayName: "Nick", Kind: "person", Via: "session"}
	if err := s.ids.RevertMerge(ctx, actor, merges[0].ID, Meta{}); err != nil {
		t.Fatal(err)
	}
	if u, err := s.ids.UserByIdentity(ctx, "discord", "1001"); err != nil || u.ID != synced.ID {
		t.Fatalf("identity after revert = %v, %v", u, err)
	}
	if row, _ := s.st.Ent.User.Get(ctx, synced.ID); row.MergedIntoID != "" {
		t.Fatalf("merged_into after revert = %q", row.MergedIntoID)
	}
	if got := memberIDs(t, s.tl, sp.ID); !slices.Equal(got, []string{synced.ID}) {
		t.Fatalf("members after revert = %v", got)
	}
	if s.allowed(t, "user:"+local.ID, "member", "space:"+sp.ID) {
		t.Fatal("survivor kept the gained space membership tuple")
	}
	if row, _ := s.tl.GetMessage(ctx, posted.GetSeq()); s.tl.Proto(row, "").GetAuthor().GetId() != synced.ID {
		t.Fatal("message author did not return to the split user")
	}
	merges, _ = s.ids.ListMerges(ctx)
	if len(merges) != 1 || merges[0].RevertedAt == nil {
		t.Fatalf("merge after revert = %v", merges)
	}
	if err := s.ids.RevertMerge(ctx, actor, merges[0].ID, Meta{}); !errors.Is(err, ErrMergeReverted) {
		t.Fatalf("second revert = %v", err)
	}
	if err := s.ids.RevertMerge(ctx, actor, "missing", Meta{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revert missing = %v", err)
	}

	audit, _, err := s.tl.ListMessages(ctx, local.ID, s.tl.SystemChannelID("audit"), 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	var linkedAudit, revertAudit bool
	for _, m := range audit {
		linkedAudit = linkedAudit || strings.Contains(m.GetContent(), "merging nick_dc")
		revertAudit = revertAudit || strings.Contains(m.GetContent(), "split two merged users")
		if m.GetCard().GetTypeUrl() != "type.googleapis.com/discoflix.card.v1.SecurityEvent" {
			t.Fatalf("audit card = %v", m.GetCard().GetTypeUrl())
		}
	}
	if !linkedAudit || !revertAudit {
		t.Fatalf("audit trail = %v", audit)
	}
}

func TestUnlinkIdentity(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	local := s.localUser(t, "Nick", "nick")
	p := capability.Principal{UserID: local.ID, DisplayName: "Nick", Kind: "person", Via: "session"}
	ids, err := s.ids.Identities(ctx, local.ID)
	if err != nil || len(ids) != 1 {
		t.Fatalf("identities = %v, %v", ids, err)
	}
	if err := s.ids.UnlinkIdentity(ctx, p, ids[0].ID, Meta{}); !errors.Is(err, ErrLastIdentity) {
		t.Fatalf("unlink last = %v", err)
	}
	gh, merged, err := s.ids.LinkIdentity(ctx, local.ID, "github", "gh1", "nick-gh", Meta{})
	if err != nil || merged || gh.UserID != local.ID {
		t.Fatalf("link fresh identity = %+v, %v, %v", gh, merged, err)
	}
	if err := s.ids.UnlinkIdentity(ctx, p, "missing", Meta{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unlink missing = %v", err)
	}
	other := s.localUser(t, "Other", "other")
	otherIDs, _ := s.ids.Identities(ctx, other.ID)
	if err := s.ids.UnlinkIdentity(ctx, p, otherIDs[0].ID, Meta{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unlink someone else's identity = %v", err)
	}
	if err := s.ids.UnlinkIdentity(ctx, p, gh.ID, Meta{}); err != nil {
		t.Fatal(err)
	}
	ids, _ = s.ids.Identities(ctx, local.ID)
	if len(ids) != 1 || ids[0].Provider != "local" {
		t.Fatalf("identities after unlink = %v", ids)
	}
	if _, err := s.ids.UserByIdentity(ctx, "github", "gh1"); !errors.Is(err, ErrUnknownUser) {
		t.Fatalf("unlinked identity still resolves = %v", err)
	}
}

func TestCreateServiceAccount(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	admin := s.localUser(t, "Nick", "nick")
	actor := capability.Principal{UserID: admin.ID, DisplayName: "Nick", Kind: "person", Via: "session"}
	u, cred, secret, err := s.ids.CreateServiceAccount(ctx, actor, "Helper", user.KindAgent, "ci", nil, Meta{})
	if err != nil || u.Kind != user.KindAgent || u.DisplayName != "Helper" || cred.UserID != u.ID || cred.Name != "ci" || !strings.HasPrefix(secret, "dfx_") {
		t.Fatalf("service account = %+v, %+v, %q, %v", u, cred, secret, err)
	}
	if !s.allowed(t, "user:"+u.ID, "member", authz.SystemObject) {
		t.Fatal("service account is not a system member")
	}
	if !s.allowed(t, "user:"+u.ID, "member", "space:"+s.tl.SystemSpaceID()) {
		t.Fatal("service account is not a member of the system space")
	}
	mems, err := s.ids.Memberships(ctx, u.ID)
	if err != nil || len(mems) != 1 || mems[0].SpaceID != s.tl.SystemSpaceID() || mems[0].Admin {
		t.Fatalf("memberships = %v, %v", mems, err)
	}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	p, err := s.ids.AuthenticateHTTP(req)
	if err != nil || p.UserID != u.ID || p.Kind != "agent" || p.Via != "apikey" || !p.Automation() {
		t.Fatalf("api key principal = %+v, %v", p, err)
	}

	before, _ := s.st.Ent.User.Query().Count(ctx)
	if _, _, _, err := s.ids.CreateServiceAccount(ctx, actor, "Not A Robot", user.KindPerson, "k", nil, Meta{}); err == nil {
		t.Fatal("person service account accepted")
	}
	if after, _ := s.st.Ent.User.Query().Count(ctx); after != before {
		t.Fatalf("refused service account left a user behind, %d then %d", before, after)
	}
}

func TestLinkCodes(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	local := s.localUser(t, "Nick", "nick")
	localP := capability.Principal{UserID: local.ID, DisplayName: "Nick", Kind: "person", Via: "session"}
	dc, _, err := s.ids.EnsureExternalUser(ctx, ExternalUser{Provider: "discord", Subject: "900", DisplayName: "Disco"})
	if err != nil {
		t.Fatal(err)
	}
	dcP := capability.Principal{UserID: dc.ID, DisplayName: "Disco", Kind: "person", Via: "discord"}

	if _, _, err := s.ids.CreateLinkCode(ctx, localP); !errors.Is(err, ErrNotExternal) {
		t.Fatalf("link code without discord = %v", err)
	}
	if _, _, err := s.ids.CreateLinkCode(ctx, dcP); !errors.Is(err, ErrNoPublicURL) {
		t.Fatalf("link code without a base = %v", err)
	}
	s.ids.SetLinkBase("http://host:1/")
	url, expires, err := s.ids.CreateLinkCode(ctx, dcP)
	if err != nil || !strings.HasPrefix(url, "http://host:1/link/") || !strings.Contains(url, "/link/") {
		t.Fatalf("link url = %q, %v", url, err)
	}
	if left := time.Until(expires); left <= 9*time.Minute || left > 10*time.Minute {
		t.Fatalf("link code lifetime = %s", left)
	}
	code := strings.TrimPrefix(url, "http://host:1/link/")
	if code == "" {
		t.Fatal("empty link code")
	}

	if _, _, err := s.ids.FinishLinkCode(ctx, localP, "wrong", Meta{}); !errors.Is(err, ErrLinkExpired) {
		t.Fatalf("wrong code = %v", err)
	}
	id, merged, err := s.ids.FinishLinkCode(ctx, localP, " "+code+"\n", Meta{})
	if err != nil || !merged || id.UserID != local.ID || id.Subject != "900" {
		t.Fatalf("finish link = %+v, %v, %v", id, merged, err)
	}
	if u, err := s.ids.UserByIdentity(ctx, "discord", "900"); err != nil || u.ID != local.ID {
		t.Fatalf("discord identity after link = %v, %v", u, err)
	}
	if _, _, err := s.ids.FinishLinkCode(ctx, localP, code, Meta{}); !errors.Is(err, ErrLinkExpired) {
		t.Fatalf("second use of a code = %v", err)
	}

	s.ids.SetPublicURL("https://public.example/")
	if base := s.ids.LinkBase(); base != "https://public.example" {
		t.Fatalf("link base with a public url = %q", base)
	}
	if u, _ := s.ids.LinkURL("abc"); u != "https://public.example/link/abc" {
		t.Fatalf("link url with a public url = %q", u)
	}
}
