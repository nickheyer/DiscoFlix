package discord

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/disgoorg/disgo/bot"
	dg "github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/events"
	"github.com/disgoorg/disgo/rest"
	"github.com/disgoorg/snowflake/v2"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/presence"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	entidentity "github.com/nickheyer/DiscoFlix/internal/store/ent/identity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/membership"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/schema"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

const backfillCount = 50

// syncGuild mirrors the whole guild from the cache, run once it is ready and again when the bot joins
func (s *Service) syncGuild(ctx context.Context, client *bot.Client, gid snowflake.ID) {
	lock := s.guildLock(gid)
	lock.Lock()
	defer lock.Unlock()
	g, ok := client.Caches.Guild(gid)
	if !ok {
		return
	}
	sp, err := s.upsertSpace(ctx, client, g)
	if err != nil {
		s.Log.Error("sync guild", "guild", g.Name, "error", err)
		return
	}
	known := map[string]bool{}
	for _, ch := range orderedChannels(client, gid) {
		row, err := s.ensureChannelLocked(ctx, client, sp, ch)
		if err != nil {
			s.Log.Error("sync channel", "guild", g.Name, "channel", ch.Name(), "error", err)
			continue
		}
		if row != nil {
			known[row.ExternalID] = true
		}
	}
	rows, err := s.Ent.Channel.Query().Where(channel.SpaceID(sp.ID), channel.DeletedAtIsNil(), channel.ExternalIDNEQ("")).All(ctx)
	if err == nil {
		for _, row := range rows {
			if !known[row.ExternalID] {
				if err := s.Timeline.DeleteChannel(ctx, row.ID); err != nil {
					s.Log.Error("delete vanished channel", "channel", row.Name, "error", err)
				}
			}
		}
	}
	seen := map[string]bool{}
	count := 0
	for m := range client.Caches.Members(gid) {
		count++
		uid, err := s.syncMember(ctx, client, sp, m)
		if err != nil {
			s.Log.Error("sync member", "guild", g.Name, "user", m.User.Username, "error", err)
			continue
		}
		if uid != "" {
			seen[uid] = true
		}
	}
	if g.MemberCount == 0 || count*10 >= g.MemberCount*9 {
		s.removeDeparted(ctx, sp, seen)
	}
	if err := s.syncVisibility(ctx, client, gid, sp); err != nil {
		s.Log.Error("sync visibility", "guild", g.Name, "error", err)
	}
	for p := range client.Caches.Presences(gid) {
		s.onPresence(ctx, p)
	}
	s.Timeline.InvalidateSpaceReaders(sp.ID)
	s.markSpaceDirty(ctx, sp.ID)
	s.kick()
	s.Log.Info("guild mirrored", "guild", g.Name, "channels", len(known), "members", count)
}

// syncGuildHeader refreshes the space name, icon, and roles after a guild update
func (s *Service) syncGuildHeader(ctx context.Context, client *bot.Client, gid snowflake.ID) {
	lock := s.guildLock(gid)
	lock.Lock()
	defer lock.Unlock()
	if g, ok := client.Caches.Guild(gid); ok {
		if _, err := s.upsertSpace(ctx, client, g); err != nil {
			s.Log.Error("update guild", "guild", g.Name, "error", err)
		}
	}
}

// upsertSpace mirrors the guild header and roles into its space
func (s *Service) upsertSpace(ctx context.Context, client *bot.Client, g dg.CacheGuild) (*ent.Space, error) {
	var roles []schema.Role
	for r := range client.Caches.Roles(g.ID) {
		if r.ID == g.ID {
			continue
		}
		roles = append(roles, schema.Role{ID: r.ID.String(), Name: r.Name, Color: hexColor(r.Color), Position: int32(r.Position), Hoist: r.Hoist})
	}
	slices.SortFunc(roles, func(a, b schema.Role) int { return int(b.Position - a.Position) })
	if roles == nil {
		roles = []schema.Role{}
	}
	icon := ""
	if u := g.IconURL(dg.WithSize(256)); u != nil {
		icon = *u
	}
	sp, created, err := s.Timeline.UpsertSpace(ctx, timeline.SpaceInput{Kind: space.KindGuild, ExternalID: g.ID.String(), Name: g.Name, IconURL: icon, Roles: roles})
	if err != nil {
		return nil, err
	}
	if created {
		s.audit(ctx, "guild:"+g.ID.String(), "Mirroring "+g.Name, "The bot joined "+g.Name+", its channels, members, and messages now appear as a space.", cardv1.Severity_SEVERITY_SUCCESS)
	}
	return sp, nil
}

func hexColor(c int) string {
	if c == 0 {
		return ""
	}
	return fmt.Sprintf("#%06x", c)
}

// orderedChannels returns the guild's channels with categories first and threads last so parents exist before children
func orderedChannels(client *bot.Client, gid snowflake.ID) []dg.GuildChannel {
	var out []dg.GuildChannel
	for ch := range client.Caches.ChannelsForGuild(gid) {
		out = append(out, ch)
	}
	rank := func(ch dg.GuildChannel) int {
		switch {
		case ch.Type() == dg.ChannelTypeGuildCategory:
			return 0
		case isThread(ch.Type()):
			return 2
		}
		return 1
	}
	slices.SortStableFunc(out, func(a, b dg.GuildChannel) int {
		if r := rank(a) - rank(b); r != 0 {
			return r
		}
		return a.Position() - b.Position()
	})
	return out
}

func isThread(t dg.ChannelType) bool {
	return t == dg.ChannelTypeGuildPublicThread || t == dg.ChannelTypeGuildPrivateThread || t == dg.ChannelTypeGuildNewsThread
}

// channelKind maps Discord channel types onto timeline kinds, false for kinds the timeline does not mirror
func channelKind(t dg.ChannelType) (channel.Kind, bool) {
	switch t {
	case dg.ChannelTypeGuildText, dg.ChannelTypeGuildNews:
		return channel.KindText, true
	case dg.ChannelTypeGuildCategory:
		return channel.KindCategory, true
	case dg.ChannelTypeGuildVoice, dg.ChannelTypeGuildStageVoice:
		return channel.KindVoice, true
	case dg.ChannelTypeGuildPublicThread, dg.ChannelTypeGuildPrivateThread, dg.ChannelTypeGuildNewsThread:
		return channel.KindThread, true
	}
	return "", false
}

// ensureChannelLocked mirrors one channel row, backfilling recent history the first time it appears
func (s *Service) ensureChannelLocked(ctx context.Context, client *bot.Client, sp *ent.Space, ch dg.GuildChannel) (*ent.Channel, error) {
	kind, ok := channelKind(ch.Type())
	if !ok {
		return nil, nil
	}
	parentID := ""
	if pid := ch.ParentID(); pid != nil {
		parent, err := s.Timeline.ChannelByExternalID(ctx, pid.String())
		if err == nil {
			parentID = parent.ID
		}
	}
	in := timeline.ChannelInput{SpaceID: sp.ID, ExternalID: ch.ID().String(), Kind: kind, Name: ch.Name(), ParentID: parentID, Position: int32(ch.Position())}
	if mc, ok := ch.(dg.GuildMessageChannel); ok {
		if t := mc.Topic(); t != nil {
			in.Topic = *t
		}
	}
	if th, ok := ch.(dg.GuildThread); ok {
		in.Archived = th.ThreadMetadata.Archived
	}
	row, created, err := s.Timeline.UpsertChannel(ctx, in)
	if err != nil {
		return nil, err
	}
	if kind != channel.KindCategory {
		if err := s.syncChannelVisibility(ctx, client, ch.GuildID(), ch, row); err != nil {
			return nil, err
		}
	}
	if created && (kind == channel.KindText || kind == channel.KindThread) {
		s.backfill(ctx, client, sp, row, ch.ID())
	}
	return row, nil
}

// backfill imports the newest messages of a freshly mirrored channel, oldest first
func (s *Service) backfill(ctx context.Context, client *bot.Client, sp *ent.Space, row *ent.Channel, chID snowflake.ID) {
	msgs, err := client.Rest.GetMessages(chID, 0, 0, 0, backfillCount, rest.WithCtx(ctx))
	if err != nil {
		s.audit(ctx, "backfill:"+row.ID, "History of #"+row.Name+" was not imported", fmt.Sprintf("Discord refused to list recent messages in #%s: %v. New messages still mirror, older ones stay on Discord until the bot can read message history there.", row.Name, err), cardv1.Severity_SEVERITY_WARNING)
		return
	}
	slices.Reverse(msgs)
	for _, m := range msgs {
		if s.isOwn(m) {
			continue
		}
		if err := s.ingest(ctx, client, m, row, true); err != nil {
			s.Log.Warn("backfill message", "channel", row.Name, "message", m.ID, "error", err)
		}
	}
	_ = sp
}

// onChannel mirrors a created or updated channel
func (s *Service) onChannel(ctx context.Context, client *bot.Client, ch dg.GuildChannel) {
	lock := s.guildLock(ch.GuildID())
	lock.Lock()
	defer lock.Unlock()
	sp, err := s.spaceFor(ctx, client, ch.GuildID())
	if err != nil {
		return
	}
	if _, err := s.ensureChannelLocked(ctx, client, sp, ch); err != nil {
		s.Log.Error("mirror channel", "channel", ch.Name(), "error", err)
	}
}

// onThread mirrors a thread the bot can see, including archive state
func (s *Service) onThread(ctx context.Context, client *bot.Client, th dg.GuildThread) {
	s.onChannel(ctx, client, th)
}

// onChannelDelete hides the mirrored row for a channel or thread Discord removed
func (s *Service) onChannelDelete(ctx context.Context, id snowflake.ID) {
	row, err := s.Timeline.ChannelByExternalID(ctx, id.String())
	if err != nil {
		return
	}
	if err := s.Timeline.DeleteChannel(ctx, row.ID); err != nil {
		s.Log.Error("delete channel", "channel", row.Name, "error", err)
	}
}

// spaceFor returns the space of a guild, mirroring the guild first when it is not known yet
func (s *Service) spaceFor(ctx context.Context, client *bot.Client, gid snowflake.ID) (*ent.Space, error) {
	sp, err := s.Timeline.SpaceByExternalID(ctx, space.KindGuild, gid.String())
	if err == nil {
		return sp, nil
	}
	g, ok := client.Caches.Guild(gid)
	if !ok {
		return nil, err
	}
	return s.upsertSpace(ctx, client, g)
}

// syncMember mirrors one member into a user and membership, returning the user id
func (s *Service) syncMember(ctx context.Context, client *bot.Client, sp *ent.Space, m dg.Member) (string, error) {
	if m.User.ID == client.ID() {
		return "", nil
	}
	u, _, err := s.Identity.EnsureExternalUser(ctx, externalUser(m.User))
	if err != nil {
		return "", err
	}
	roles := make([]string, 0, len(m.RoleIDs))
	for _, r := range m.RoleIDs {
		roles = append(roles, r.String())
	}
	slices.Sort(roles)
	nick := ""
	if m.Nick != nil {
		nick = *m.Nick
	}
	perms := client.Caches.MemberPermissions(m)
	admin := perms.Has(dg.PermissionAdministrator) || perms.Has(dg.PermissionManageGuild)
	if g, ok := client.Caches.Guild(m.GuildID); ok && g.OwnerID == m.User.ID {
		admin = true
	}
	if _, err := s.Timeline.UpsertMember(ctx, timeline.MemberInput{UserID: u.ID, SpaceID: sp.ID, Roles: roles, Nickname: nick, Admin: admin}); err != nil {
		return "", err
	}
	return u.ID, nil
}

// removeDeparted drops memberships of Discord users no longer in the guild
func (s *Service) removeDeparted(ctx context.Context, sp *ent.Space, seen map[string]bool) {
	rows, err := s.Ent.Membership.Query().Where(membership.SpaceID(sp.ID), membership.HasUserWith(user.HasIdentitiesWith(entidentity.Provider(Provider)))).All(ctx)
	if err != nil {
		s.Log.Error("list memberships", "space", sp.Name, "error", err)
		return
	}
	for _, m := range rows {
		if !seen[m.UserID] {
			if err := s.Timeline.RemoveMember(ctx, m.UserID, sp.ID); err != nil {
				s.Log.Error("remove departed member", "user", m.UserID, "error", err)
			}
		}
	}
}

func (s *Service) onMember(ctx context.Context, client *bot.Client, m dg.Member) {
	lock := s.guildLock(m.GuildID)
	lock.Lock()
	defer lock.Unlock()
	sp, err := s.spaceFor(ctx, client, m.GuildID)
	if err != nil {
		return
	}
	if _, err := s.syncMember(ctx, client, sp, m); err != nil {
		s.Log.Error("mirror member", "user", m.User.Username, "error", err)
		return
	}
	s.scheduleResync(ctx, client, m.GuildID)
}

func (s *Service) onMemberLeave(ctx context.Context, e *events.GuildMemberLeave) {
	sp, err := s.Timeline.SpaceByExternalID(ctx, space.KindGuild, e.GuildID.String())
	if err != nil {
		return
	}
	u, err := s.Identity.UserByIdentity(ctx, Provider, e.User.ID.String())
	if err != nil {
		return
	}
	if err := s.Timeline.RemoveMember(ctx, u.ID, sp.ID); err != nil {
		s.Log.Error("remove member", "user", e.User.Username, "error", err)
	}
	s.Presence.SetRemote(u.ID, presence.Offline)
}

func (s *Service) onUserUpdate(ctx context.Context, u dg.User) {
	if _, _, err := s.Identity.EnsureExternalUser(ctx, externalUser(u)); err != nil {
		s.Log.Error("update user profile", "user", u.Username, "error", err)
	}
}

func (s *Service) onGuildLeave(ctx context.Context, e *events.GuildLeave) {
	name := e.GuildID.String()
	if sp, err := s.Timeline.SpaceByExternalID(ctx, space.KindGuild, name); err == nil {
		name = sp.Name
	}
	s.audit(ctx, "guild-left:"+e.GuildID.String(), "Removed from "+name, "The bot is no longer in "+name+". Its space keeps the mirrored history but receives nothing new.", cardv1.Severity_SEVERITY_WARNING)
}

// scheduleResync recomputes roles and channel visibility for a guild shortly after a burst of changes
func (s *Service) scheduleResync(ctx context.Context, client *bot.Client, gid snowflake.ID) {
	s.resyncMu.Lock()
	defer s.resyncMu.Unlock()
	if t, ok := s.resyncs[gid]; ok {
		t.Reset(2 * time.Second)
		return
	}
	s.resyncs[gid] = time.AfterFunc(2*time.Second, func() {
		s.resyncMu.Lock()
		delete(s.resyncs, gid)
		s.resyncMu.Unlock()
		lock := s.guildLock(gid)
		lock.Lock()
		defer lock.Unlock()
		g, ok := client.Caches.Guild(gid)
		if !ok {
			return
		}
		sp, err := s.upsertSpace(ctx, client, g)
		if err != nil {
			return
		}
		for m := range client.Caches.Members(gid) {
			if _, err := s.syncMember(ctx, client, sp, m); err != nil {
				s.Log.Error("resync member", "user", m.User.Username, "error", err)
			}
		}
		if err := s.syncVisibility(ctx, client, gid, sp); err != nil {
			s.Log.Error("resync visibility", "guild", g.Name, "error", err)
		}
	})
}

// syncVisibility recomputes who may read and post in every mirrored channel of a guild
func (s *Service) syncVisibility(ctx context.Context, client *bot.Client, gid snowflake.ID, sp *ent.Space) error {
	for _, ch := range orderedChannels(client, gid) {
		if ch.Type() == dg.ChannelTypeGuildCategory {
			continue
		}
		if _, ok := channelKind(ch.Type()); !ok {
			continue
		}
		row, err := s.Timeline.ChannelByExternalID(ctx, ch.ID().String())
		if err != nil {
			continue
		}
		if err := s.syncChannelVisibility(ctx, client, gid, ch, row); err != nil {
			return err
		}
	}
	_ = sp
	return nil
}

// access is the computed audience of one channel
type access struct {
	openView bool
	openPost bool
	viewers  []string
	posters  []string
}

// computeAccess evaluates Discord permissions for the everyone role and, when needed, every member
func computeAccess(client *bot.Client, gid snowflake.ID, ch dg.GuildChannel) access {
	permCh := ch
	sendBit := dg.PermissionSendMessages
	if isThread(ch.Type()) {
		sendBit = dg.PermissionSendMessagesInThreads
		if pid := ch.ParentID(); pid != nil {
			if parent, ok := client.Caches.GuildMessageChannel(*pid); ok {
				permCh = parent
			}
		}
	}
	everyone, _ := client.Caches.Role(gid, gid)
	base := everyone.Permissions
	if ow, ok := permCh.PermissionOverwrites().Role(gid); ok {
		base = base.Remove(ow.Deny).Add(ow.Allow)
	}
	a := access{openView: everyone.Permissions.Has(dg.PermissionAdministrator) || base.Has(dg.PermissionViewChannel)}
	a.openPost = a.openView && (everyone.Permissions.Has(dg.PermissionAdministrator) || base.Has(sendBit))
	if a.openView && a.openPost {
		return a
	}
	for m := range client.Caches.Members(gid) {
		if m.User.ID == client.ID() {
			continue
		}
		p := client.Caches.MemberPermissionsInChannel(permCh, m)
		if !p.Has(dg.PermissionViewChannel) {
			continue
		}
		if !a.openView {
			a.viewers = append(a.viewers, m.User.ID.String())
		}
		if !a.openPost && p.Has(sendBit) {
			a.posters = append(a.posters, m.User.ID.String())
		}
	}
	return a
}

// syncChannelVisibility writes the open, viewer, post, and poster tuples a channel's Discord permissions imply
func (s *Service) syncChannelVisibility(ctx context.Context, client *bot.Client, gid snowflake.ID, ch dg.GuildChannel, row *ent.Channel) error {
	a := computeAccess(client, gid, ch)
	ids, err := s.userIDs(ctx, append(append([]string(nil), a.viewers...), a.posters...))
	if err != nil {
		return err
	}
	object := "channel:" + row.ID
	var ops []authz.Op
	for rel, want := range map[string]bool{"open": a.openView, "post": a.openPost} {
		has, err := s.Authz.Has(ctx, object, rel, authz.Everyone)
		if err != nil {
			return err
		}
		switch {
		case want && !has:
			ops = append(ops, authz.Write(object, rel, authz.Everyone))
		case !want && has:
			ops = append(ops, authz.Delete(object, rel, authz.Everyone))
		}
	}
	for rel, subjects := range map[string][]string{"viewer": a.viewers, "poster": a.posters} {
		want := map[string]bool{}
		for _, subj := range subjects {
			if uid, ok := ids[subj]; ok {
				want[uid] = true
			}
		}
		current, _, err := s.Authz.ListUsers(ctx, object, rel)
		if err != nil {
			return err
		}
		have := map[string]bool{}
		for _, uid := range current {
			have[uid] = true
			if !want[uid] {
				ops = append(ops, authz.Delete(object, rel, "user:"+uid))
			}
		}
		for uid := range want {
			if !have[uid] {
				ops = append(ops, authz.Write(object, rel, "user:"+uid))
			}
		}
	}
	if len(ops) == 0 {
		return nil
	}
	tx, err := s.Ent.Tx(ctx)
	if err != nil {
		return err
	}
	if err := authz.Stage(ctx, tx, ops...); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := s.Authz.Flush(ctx); err != nil {
		return err
	}
	s.Timeline.InvalidateReaders(row.ID)
	return nil
}

// userIDs maps Discord user ids onto DiscoFlix user ids for the ones that exist
func (s *Service) userIDs(ctx context.Context, subjects []string) (map[string]string, error) {
	out := map[string]string{}
	if len(subjects) == 0 {
		return out, nil
	}
	rows, err := s.Ent.Identity.Query().Where(entidentity.Provider(Provider), entidentity.SubjectIn(subjects...)).WithUser().All(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range rows {
		uid := id.UserID
		if id.Edges.User != nil && id.Edges.User.MergedIntoID != "" {
			uid = id.Edges.User.MergedIntoID
		}
		out[id.Subject] = uid
	}
	return out, nil
}

// CreateThread starts a thread on Discord and mirrors it before returning its id, for the timeline's thread requests
func (s *Service) CreateThread(ctx context.Context, parent *ent.Channel, name, fromExternalID string) (string, error) {
	client, err := s.Client()
	if err != nil {
		return "", timeline.ErrNoThreads
	}
	parentID, err := snowflake.Parse(parent.ExternalID)
	if err != nil {
		return "", fmt.Errorf("discord: channel %s has no Discord id", parent.Name)
	}
	sp, err := s.Timeline.GetSpace(ctx, parent.SpaceID)
	if err != nil {
		return "", err
	}
	gid, err := snowflake.Parse(sp.ExternalID)
	if err != nil {
		return "", err
	}
	lock := s.guildLock(gid)
	lock.Lock()
	defer lock.Unlock()
	var th *dg.GuildThread
	name = strings.TrimSpace(name)
	if fromExternalID != "" {
		msgID, err := snowflake.Parse(fromExternalID)
		if err != nil {
			return "", err
		}
		th, err = client.Rest.CreateThreadFromMessage(parentID, msgID, dg.ThreadCreateFromMessage{Name: name}, rest.WithCtx(ctx))
		if err != nil {
			return "", fmt.Errorf("discord: create thread: %w", err)
		}
	} else {
		th, err = client.Rest.CreateThread(parentID, dg.GuildPublicThreadCreate{Name: name}, rest.WithCtx(ctx))
		if err != nil {
			return "", fmt.Errorf("discord: create thread: %w", err)
		}
	}
	if _, err := s.ensureChannelLocked(ctx, client, sp, *th); err != nil {
		return "", err
	}
	return th.ID().String(), nil
}
