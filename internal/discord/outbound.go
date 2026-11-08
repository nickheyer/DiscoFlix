package discord

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/disgoorg/disgo/bot"
	dg "github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/rest"
	"github.com/disgoorg/snowflake/v2"

	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

const (
	reconcileBatch = 25
	retryDelay     = 30 * time.Second
	typingGap      = 8 * time.Second
	webhookName    = "DiscoFlix"
)

var errTransient = errors.New("discord: retry later")

// onTimelineEvent marks mirrored channels dirty when something not from Discord changed them
func (s *Service) onTimelineEvent(ctx context.Context, ev *timelinev1.Event) {
	if ev.GetOrigin() == timeline.OriginDiscord || ev.GetChannelId() == "" {
		return
	}
	switch ev.GetKind() {
	case timelinev1.EventKind_EVENT_KIND_MESSAGE_CREATED, timelinev1.EventKind_EVENT_KIND_MESSAGE_EDITED, timelinev1.EventKind_EVENT_KIND_MESSAGE_DELETED,
		timelinev1.EventKind_EVENT_KIND_CARD_UPDATED, timelinev1.EventKind_EVENT_KIND_REACTION_ADDED, timelinev1.EventKind_EVENT_KIND_REACTION_REMOVED:
		if _, ok := s.mirrored(ctx, ev.GetChannelId()); ok {
			s.markDirty(ev.GetChannelId())
			s.kick()
		}
	case timelinev1.EventKind_EVENT_KIND_TYPING:
		if ext, ok := s.mirrored(ctx, ev.GetChannelId()); ok {
			s.sendTyping(ctx, ext)
		}
	}
}

// mirrored reports the Discord id of a channel when it belongs to a guild space
func (s *Service) mirrored(ctx context.Context, channelID string) (snowflake.ID, bool) {
	row, err := s.Timeline.GetChannel(ctx, channelID)
	if err != nil || row.ExternalID == "" {
		return 0, false
	}
	sp, err := s.Timeline.GetSpace(ctx, row.SpaceID)
	if err != nil || sp.Kind != space.KindGuild {
		return 0, false
	}
	id, err := snowflake.Parse(row.ExternalID)
	if err != nil {
		return 0, false
	}
	return id, true
}

func (s *Service) kick() {
	select {
	case s.kicks <- struct{}{}:
	default:
	}
}

func (s *Service) markDirty(channelID string) {
	s.dirtyMu.Lock()
	defer s.dirtyMu.Unlock()
	s.dirty[channelID] = struct{}{}
}

// markSpaceDirty queues every live channel of a space for reconciliation
func (s *Service) markSpaceDirty(ctx context.Context, spaceID string) {
	ids, err := s.Ent.Channel.Query().Where(channel.SpaceID(spaceID), channel.DeletedAtIsNil(), channel.KindIn(channel.KindText, channel.KindThread)).IDs(ctx)
	if err != nil {
		s.Log.Error("list channels", "space", spaceID, "error", err)
		return
	}
	s.dirtyMu.Lock()
	defer s.dirtyMu.Unlock()
	for _, id := range ids {
		s.dirty[id] = struct{}{}
	}
}

// markAllDirty queues every mirrored channel, used after connects and on the periodic pass
func (s *Service) markAllDirty(ctx context.Context) {
	spaces, err := s.Ent.Space.Query().Where(space.KindEQ(space.KindGuild)).IDs(ctx)
	if err != nil {
		s.Log.Error("list guild spaces", "error", err)
		return
	}
	for _, id := range spaces {
		s.markSpaceDirty(ctx, id)
	}
}

// flushDirty reconciles every dirty channel, keeping the ones that hit transient failures for the next pass
func (s *Service) flushDirty(ctx context.Context) {
	if _, err := s.Client(); err != nil {
		return
	}
	s.dirtyMu.Lock()
	batch := make([]string, 0, len(s.dirty))
	now := time.Now()
	for id := range s.dirty {
		if at, ok := s.retryAt[id]; ok && now.Before(at) {
			continue
		}
		batch = append(batch, id)
	}
	s.dirtyMu.Unlock()
	for _, id := range batch {
		err := s.reconcileChannel(ctx, id)
		s.dirtyMu.Lock()
		if err != nil {
			s.retryAt[id] = time.Now().Add(retryDelay)
		} else {
			delete(s.dirty, id)
			delete(s.retryAt, id)
		}
		s.dirtyMu.Unlock()
		if err != nil && !errors.Is(err, errTransient) {
			s.Log.Warn("reconcile channel", "channel", id, "error", err)
		}
	}
}

// target describes where a mirrored channel's messages go on Discord
type target struct {
	channel snowflake.ID
	thread  snowflake.ID
	webhook snowflake.ID
	guild   snowflake.ID
}

// targetFor resolves the Discord channel, the webhook channel, and the thread id for a timeline channel
func (s *Service) targetFor(ctx context.Context, row *ent.Channel, sp *ent.Space) (target, error) {
	var t target
	var err error
	if t.channel, err = snowflake.Parse(row.ExternalID); err != nil {
		return t, fmt.Errorf("discord: channel %s has no Discord id", row.Name)
	}
	if t.guild, err = snowflake.Parse(sp.ExternalID); err != nil {
		return t, err
	}
	t.webhook = t.channel
	if row.Kind == channel.KindThread && row.ParentID != "" {
		parent, err := s.Timeline.GetChannel(ctx, row.ParentID)
		if err != nil {
			return t, err
		}
		if t.webhook, err = snowflake.Parse(parent.ExternalID); err != nil {
			return t, err
		}
		t.thread = t.channel
	}
	return t, nil
}

// reconcileChannel sends unsent rows and pushes edits, deletes, cards, and reactions the row is ahead on
func (s *Service) reconcileChannel(ctx context.Context, channelID string) error {
	client, err := s.Client()
	if err != nil {
		return errTransient
	}
	row, err := s.Timeline.GetChannel(ctx, channelID)
	if err != nil {
		return err
	}
	sp, err := s.Timeline.GetSpace(ctx, row.SpaceID)
	if err != nil {
		return err
	}
	if sp.Kind != space.KindGuild || row.DeletedAt != nil || row.ExternalID == "" {
		return nil
	}
	t, err := s.targetFor(ctx, row, sp)
	if err != nil {
		return err
	}
	unsynced, err := s.Timeline.Unsynced(ctx, channelID, reconcileBatch)
	if err != nil {
		return err
	}
	for _, m := range unsynced {
		if m.DeletedAt != nil {
			if err := s.Timeline.MarkSynced(ctx, m.ID, ""); err != nil {
				return err
			}
			continue
		}
		id, err := s.send(ctx, client, t, m)
		if err != nil {
			return s.outboundFailure(ctx, row, m, "send", err)
		}
		if err := s.Timeline.MarkSynced(ctx, m.ID, id.String()); err != nil {
			return err
		}
		if len(m.Edges.Reactions) > 0 {
			if err := s.pushReactions(ctx, client, t, m, &dg.Message{ID: id}); err != nil {
				return s.outboundFailure(ctx, row, m, "react", err)
			}
		}
	}
	stale, err := s.Timeline.Stale(ctx, channelID, reconcileBatch)
	if err != nil {
		return err
	}
	for _, m := range stale {
		if m.ExternalID == "" {
			if err := s.Timeline.MarkSynced(ctx, m.ID, ""); err != nil {
				return err
			}
			continue
		}
		if err := s.push(ctx, client, t, m); err != nil {
			return s.outboundFailure(ctx, row, m, "update", err)
		}
		if err := s.Timeline.MarkSynced(ctx, m.ID, ""); err != nil {
			return err
		}
	}
	return nil
}

// outboundFailure reports a Discord refusal in the audit channel, gives up on permanent ones, and retries the rest
func (s *Service) outboundFailure(ctx context.Context, row *ent.Channel, m *ent.Message, op string, err error) error {
	var re *rest.Error
	status := 0
	if errors.As(err, &re) && re.Response != nil {
		status = re.Response.StatusCode
	}
	key := fmt.Sprintf("outbound:%s:%d", row.ID, status)
	switch status {
	case 400, 404:
		s.audit(ctx, key, "Discord refused a mirrored message", fmt.Sprintf("Could not %s message %d in #%s: %v. The timeline keeps it, Discord will not.", op, m.ID, row.Name, err), cardv1.Severity_SEVERITY_ERROR)
		return s.Timeline.MarkSynced(ctx, m.ID, "")
	case 403:
		s.audit(ctx, key, "Discord permissions block #"+row.Name, fmt.Sprintf("Could not %s a message in #%s because the bot lacks permission: %v. Grant the invite permissions and it retries on its own.", op, row.Name, err), cardv1.Severity_SEVERITY_ERROR)
		return errTransient
	}
	s.Log.Warn("discord outbound", "op", op, "channel", row.Name, "message", m.ID, "error", err)
	return errTransient
}

// viaWebhook reports whether a row is sent as its human author through a webhook rather than as the bot
func viaWebhook(m *ent.Message) bool {
	return m.Kind == message.KindUser && m.CardType == "" && m.Edges.Author != nil && authorKind(m.Edges.Author) == user.KindPerson
}

func authorKind(u *ent.User) user.Kind {
	if u.Edges.MergedInto != nil {
		return u.Edges.MergedInto.Kind
	}
	return u.Kind
}

func authorOf(m *ent.Message) *ent.User {
	if m.Edges.Author != nil && m.Edges.Author.Edges.MergedInto != nil {
		return m.Edges.Author.Edges.MergedInto
	}
	return m.Edges.Author
}

var mentionsUsersOnly = &dg.AllowedMentions{Parse: []dg.AllowedMentionType{dg.AllowedMentionTypeUsers}}

// send creates the Discord copy of a row, as the author through a webhook or as the bot with Components V2
func (s *Service) send(ctx context.Context, client *bot.Client, t target, m *ent.Message) (snowflake.ID, error) {
	if viaWebhook(m) {
		wh, err := s.webhookFor(ctx, client, t.webhook)
		if err != nil {
			return 0, err
		}
		author := authorOf(m)
		create := dg.WebhookMessageCreate{
			Content:         s.webhookContent(ctx, t, m),
			Username:        webhookUsername(author.DisplayName),
			AvatarURL:       author.AvatarURL,
			AllowedMentions: mentionsUsersOnly,
		}
		sent, err := client.Rest.CreateWebhookMessage(wh.id, wh.token, create, rest.CreateWebhookMessageParams{Wait: true, ThreadID: t.thread}, rest.WithCtx(ctx))
		if err != nil {
			if isUnknownWebhook(err) {
				s.forgetWebhook(t.webhook)
			}
			return 0, err
		}
		return sent.ID, nil
	}
	components, err := s.renderMessage(ctx, m)
	if err != nil {
		return 0, err
	}
	create := dg.NewMessageCreateV2(components...)
	create.AllowedMentions = mentionsUsersOnly
	if m.ReplyTo != 0 {
		if parent, err := s.Timeline.GetMessage(ctx, m.ReplyTo); err == nil && parent.ExternalID != "" {
			if pid, err := snowflake.Parse(parent.ExternalID); err == nil {
				create.MessageReference = &dg.MessageReference{MessageID: &pid, FailIfNotExists: false}
			}
		}
	}
	sent, err := client.Rest.CreateMessage(t.channel, create, rest.WithCtx(ctx))
	if err != nil {
		return 0, err
	}
	return sent.ID, nil
}

// webhookContent prefixes a reply pointer, since webhooks cannot reference messages
func (s *Service) webhookContent(ctx context.Context, t target, m *ent.Message) string {
	content := m.Content
	if m.ReplyTo == 0 {
		return content
	}
	parent, err := s.Timeline.GetMessage(ctx, m.ReplyTo)
	if err != nil {
		return content
	}
	name := "a message"
	if a := authorOf(parent); a != nil {
		name = a.DisplayName
	}
	if parent.ExternalID != "" {
		return fmt.Sprintf("-# ↩ Replying to [%s](https://discord.com/channels/%s/%s/%s)\n%s", name, t.guild, t.channel, parent.ExternalID, content)
	}
	return fmt.Sprintf("-# ↩ Replying to %s\n%s", name, content)
}

// webhookUsername keeps names inside Discord's rules for webhook display names
func webhookUsername(name string) string {
	name = strings.TrimSpace(name)
	name = defang(name, "clyde", 1, '1')
	name = defang(name, "discord", 4, '0')
	if len([]rune(name)) > 80 {
		name = string([]rune(name)[:80])
	}
	if name == "" {
		name = "Member"
	}
	return name
}

// Swaps one letter of every case-insensitive occurrence of a reserved word so Discord accepts the name
func defang(name, word string, at int, with rune) string {
	r, w := []rune(name), []rune(word)
	for i := 0; i+len(w) <= len(r); i++ {
		match := true
		for j, c := range w {
			if unicode.ToLower(r[i+j]) != c {
				match = false
				break
			}
		}
		if match {
			r[i+at] = with
		}
	}
	return string(r)
}

// push edits the Discord copy so it matches the row, including deletions, card state, and bot reactions
func (s *Service) push(ctx context.Context, client *bot.Client, t target, m *ent.Message) error {
	id, err := snowflake.Parse(m.ExternalID)
	if err != nil {
		return fmt.Errorf("discord: message %d carries an unparsable Discord id %q", m.ID, m.ExternalID)
	}
	if m.DeletedAt != nil {
		err := client.Rest.DeleteMessage(t.channel, id, rest.WithCtx(ctx))
		if err != nil && !isNotFound(err) {
			return err
		}
		return nil
	}
	remote, err := client.Rest.GetMessage(t.channel, id, rest.WithCtx(ctx))
	if isNotFound(err) {
		return nil //nolint:nilerr // the remote copy is gone, there is nothing left to edit
	}
	if err != nil {
		return err
	}
	if m.Origin != timeline.OriginDiscord {
		if err := s.pushContent(ctx, client, t, m, remote); err != nil {
			return err
		}
	}
	return s.pushReactions(ctx, client, t, m, remote)
}

// pushContent edits text through the webhook that sent it, and bot messages as the bot
func (s *Service) pushContent(ctx context.Context, client *bot.Client, t target, m *ent.Message, remote *dg.Message) error {
	switch {
	case remote.WebhookID != nil:
		wh, err := s.webhookFor(ctx, client, t.webhook)
		if err != nil {
			return err
		}
		if wh.id != *remote.WebhookID {
			return fmt.Errorf("discord: message %d was sent by a webhook that no longer exists, so its edit cannot reach Discord", m.ID)
		}
		content := s.webhookContent(ctx, t, m)
		if remote.Content == content {
			return nil
		}
		_, err = client.Rest.UpdateWebhookMessage(wh.id, wh.token, remote.ID, dg.WebhookMessageUpdate{Content: &content, AllowedMentions: mentionsUsersOnly}, rest.UpdateWebhookMessageParams{ThreadID: t.thread}, rest.WithCtx(ctx))
		return err
	default:
		components, err := s.renderMessage(ctx, m)
		if err != nil {
			return err
		}
		update := dg.NewMessageUpdateV2(components...)
		update.AllowedMentions = mentionsUsersOnly
		_, err = client.Rest.UpdateMessage(t.channel, remote.ID, update, rest.WithCtx(ctx))
		return err
	}
}

// pushReactions makes the bot carry exactly the emojis web users reacted with
func (s *Service) pushReactions(ctx context.Context, client *bot.Client, t target, m *ent.Message, remote *dg.Message) error {
	rows, err := s.Timeline.Reactors(ctx, m.ID)
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, r := range rows {
		if r.Origin != timeline.OriginDiscord {
			want[r.Emoji] = true
		}
	}
	have := map[string]bool{}
	for _, r := range remote.Reactions {
		if r.Me {
			have[r.Emoji.Reaction()] = true
		}
	}
	for emoji := range want {
		if !have[emoji] {
			if err := client.Rest.AddReaction(t.channel, remote.ID, emoji, rest.WithCtx(ctx)); err != nil {
				return err
			}
		}
	}
	for emoji := range have {
		if !want[emoji] {
			if err := client.Rest.RemoveOwnReaction(t.channel, remote.ID, emoji, rest.WithCtx(ctx)); err != nil && !isNotFound(err) {
				return err
			}
		}
	}
	return nil
}

func isNotFound(err error) bool {
	var re *rest.Error
	return errors.As(err, &re) && re.Response != nil && re.Response.StatusCode == 404
}

func isUnknownWebhook(err error) bool {
	var re *rest.Error
	return errors.As(err, &re) && (re.Code == 10015 || isNotFound(err))
}

// sendTyping shows the bot typing in a Discord channel while a web user writes, at most once per gap
func (s *Service) sendTyping(ctx context.Context, ch snowflake.ID) {
	client, err := s.Client()
	if err != nil {
		return
	}
	s.typingMu.Lock()
	last := s.typingAt[ch]
	if time.Since(last) < typingGap {
		s.typingMu.Unlock()
		return
	}
	s.typingAt[ch] = time.Now()
	s.typingMu.Unlock()
	if err := client.Rest.SendTyping(ch, rest.WithCtx(ctx)); err != nil {
		s.Log.Debug("send typing", "channel", ch, "error", err)
	}
}

// webhook is the credential pair one channel's human messages go through
type webhook struct {
	id    snowflake.ID
	token string
}

// webhookFor finds or creates the DiscoFlix webhook of a channel, remembering its token in the secrets file
func (s *Service) webhookFor(ctx context.Context, client *bot.Client, ch snowflake.ID) (webhook, error) {
	if v, ok := s.webhooks.Load(ch); ok {
		return v.(webhook), nil
	}
	key := secretWebhook + ch.String()
	if raw, ok := s.Secrets.Get(key); ok && raw != "" {
		if idText, token, ok := strings.Cut(raw, ":"); ok {
			if id, err := snowflake.Parse(idText); err == nil {
				wh := webhook{id: id, token: token}
				s.webhooks.Store(ch, wh)
				s.webhooks.Store(id, wh)
				return wh, nil
			}
		}
	}
	s.mu.RLock()
	app := s.appID
	s.mu.RUnlock()
	existing, err := client.Rest.GetWebhooks(ch, rest.WithCtx(ctx))
	if err != nil {
		return webhook{}, err
	}
	var wh webhook
	for _, w := range existing {
		if in, ok := w.(dg.IncomingWebhook); ok && in.Token != "" && (in.ApplicationID == app || in.Name() == webhookName) {
			wh = webhook{id: in.ID(), token: in.Token}
			break
		}
	}
	if wh.id == 0 {
		created, err := client.Rest.CreateWebhook(ch, dg.WebhookCreate{Name: webhookName}, rest.WithCtx(ctx))
		if err != nil {
			return webhook{}, err
		}
		wh = webhook{id: created.ID(), token: created.Token}
	}
	if err := s.Secrets.Set(key, wh.id.String()+":"+wh.token); err != nil {
		return webhook{}, err
	}
	s.webhooks.Store(ch, wh)
	s.webhooks.Store(wh.id, wh)
	return wh, nil
}

func (s *Service) forgetWebhook(ch snowflake.ID) {
	if v, ok := s.webhooks.Load(ch); ok {
		s.webhooks.Delete(v.(webhook).id)
	}
	s.webhooks.Delete(ch)
	_ = s.Secrets.Set(secretWebhook+ch.String(), "")
}
