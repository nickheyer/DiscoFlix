package discord

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/disgoorg/disgo/bot"
	dg "github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/events"
	"github.com/disgoorg/disgo/rest"
	"github.com/disgoorg/snowflake/v2"

	"github.com/nickheyer/DiscoFlix/internal/identity"
	"github.com/nickheyer/DiscoFlix/internal/presence"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/schema"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
)

// isOwn reports whether the bot or one of its webhooks wrote the message, so it is not mirrored back
func (s *Service) isOwn(m dg.Message) bool {
	s.mu.RLock()
	botID := s.botUser.ID
	s.mu.RUnlock()
	if botID != 0 && m.Author.ID == botID {
		return true
	}
	if m.WebhookID != nil {
		if _, ok := s.webhooks.Load(*m.WebhookID); ok {
			return true
		}
		if m.ApplicationID != nil {
			s.mu.RLock()
			app := s.appID
			s.mu.RUnlock()
			if *m.ApplicationID == app {
				return true
			}
		}
	}
	return false
}

// locate returns the mirrored row for a Discord channel, mirroring it on first sight
func (s *Service) locate(ctx context.Context, client *bot.Client, gid, chID snowflake.ID) (*ent.Channel, error) {
	row, err := s.Timeline.ChannelByExternalID(ctx, chID.String())
	if err == nil {
		return row, nil
	}
	ch, ok := client.Caches.GuildMessageChannel(chID)
	if !ok {
		return nil, fmt.Errorf("discord: channel %s is not in the cache", chID)
	}
	lock := s.guildLock(gid)
	lock.Lock()
	defer lock.Unlock()
	sp, err := s.spaceFor(ctx, client, gid)
	if err != nil {
		return nil, err
	}
	row, err = s.ensureChannelLocked(ctx, client, sp, ch)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, fmt.Errorf("discord: channel %s has a type the timeline does not mirror", ch.Name())
	}
	return row, nil
}

func (s *Service) onMessage(ctx context.Context, client *bot.Client, m dg.Message) {
	if m.GuildID == nil || s.isOwn(m) {
		return
	}
	row, err := s.locate(ctx, client, *m.GuildID, m.ChannelID)
	if err != nil {
		s.Log.Warn("mirror message", "message", m.ID, "error", err)
		return
	}
	if err := s.ingest(ctx, client, m, row, false); err != nil {
		s.Log.Error("mirror message", "message", m.ID, "error", err)
	}
}

// ingest writes a Discord message into the timeline once, keeping Discord's timestamp and author
func (s *Service) ingest(ctx context.Context, client *bot.Client, m dg.Message, row *ent.Channel, backfill bool) error {
	if _, err := s.Timeline.MessageByExternalID(ctx, m.ID.String()); err == nil {
		return nil
	} else if !errors.Is(err, timeline.ErrNotFound) {
		return err
	}
	ext := externalUser(m.Author)
	if m.WebhookID != nil {
		ext.Bot = true
	}
	author, _, err := s.Identity.EnsureExternalUser(ctx, ext)
	if err != nil {
		return err
	}
	kind, content := describe(m)
	replyTo := int64(0)
	if ref := m.MessageReference; ref != nil && ref.MessageID != nil {
		if parent, err := s.Timeline.MessageByExternalID(ctx, ref.MessageID.String()); err == nil {
			replyTo = parent.ID
		}
	}
	posted, err := s.Timeline.Post(ctx, timeline.PostInput{
		ChannelID:   row.ID,
		AuthorID:    author.ID,
		Kind:        kind,
		Content:     content,
		ReplyTo:     replyTo,
		External:    m.ID.String(),
		Origin:      timeline.OriginDiscord,
		Attachments: attachments(m),
		CreatedAt:   m.CreatedAt,
		Synced:      true,
	})
	if err != nil {
		return err
	}
	if backfill && len(m.Reactions) > 0 {
		s.importReactions(ctx, client, m, posted.GetSeq())
	}
	return nil
}

// describe maps Discord message types onto timeline kinds and content, naming system events in words
func describe(m dg.Message) (message.Kind, string) {
	switch m.Type {
	case dg.MessageTypeDefault, dg.MessageTypeReply, dg.MessageTypeSlashCommand, dg.MessageTypeContextMenuCommand, dg.MessageTypeThreadStarterMessage:
		return message.KindUser, contentOf(m)
	case dg.MessageTypeUserJoin:
		return message.KindSystem, "joined the server"
	case dg.MessageTypeChannelPinnedMessage:
		return message.KindSystem, "pinned a message to this channel"
	case dg.MessageTypeThreadCreated:
		return message.KindSystem, "started a thread: " + m.Content
	case dg.MessageTypeGuildBoost:
		return message.KindSystem, "boosted the server"
	case dg.MessageTypeChannelNameChange:
		return message.KindSystem, "changed the channel name to " + m.Content
	case dg.MessageTypePollResult:
		return message.KindSystem, "a poll ended"
	}
	text := contentOf(m)
	if text == "" {
		text = fmt.Sprintf("system message of type %d", m.Type)
	}
	return message.KindSystem, text
}

// contentOf returns the message text, describing embeds and stickers when the text is empty
func contentOf(m dg.Message) string {
	if m.Content != "" {
		return m.Content
	}
	var b strings.Builder
	for _, e := range m.Embeds {
		if e.Title != "" {
			b.WriteString("**" + e.Title + "**\n")
		}
		if e.Description != "" {
			b.WriteString(e.Description + "\n")
		}
		if e.URL != "" {
			b.WriteString(e.URL + "\n")
		}
	}
	for _, st := range m.StickerItems {
		b.WriteString("[sticker: " + st.Name + "]\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func attachments(m dg.Message) []schema.Attachment {
	if len(m.Attachments) == 0 {
		return nil
	}
	out := make([]schema.Attachment, 0, len(m.Attachments))
	for _, a := range m.Attachments {
		at := schema.Attachment{ID: a.ID.String(), Name: a.Filename, URL: a.URL, Size: int64(a.Size)}
		if a.ContentType != nil {
			at.ContentType = *a.ContentType
		}
		if a.Width != nil {
			at.Width = int32(*a.Width)
		}
		if a.Height != nil {
			at.Height = int32(*a.Height)
		}
		out = append(out, at)
	}
	return out
}

// importReactions copies who reacted with what onto a backfilled message
func (s *Service) importReactions(ctx context.Context, client *bot.Client, m dg.Message, seq int64) {
	for i, r := range m.Reactions {
		if i >= 10 {
			return
		}
		emoji := r.Emoji.Reaction()
		if emoji == "" {
			continue
		}
		users, err := client.Rest.GetReactions(m.ChannelID, m.ID, emoji, dg.MessageReactionTypeNormal, 0, 100, rest.WithCtx(ctx))
		if err != nil {
			return
		}
		for _, u := range users {
			if u.ID == client.ID() {
				continue
			}
			reactor, _, err := s.Identity.EnsureExternalUser(ctx, externalUser(u))
			if err != nil {
				continue
			}
			if _, _, err := s.Timeline.AddReaction(ctx, seq, reactor.ID, emoji, timeline.OriginDiscord); err != nil {
				return
			}
		}
	}
}

func (s *Service) onMessageUpdate(ctx context.Context, client *bot.Client, m dg.Message) {
	if s.isOwn(m) {
		return
	}
	existing, err := s.Timeline.MessageByExternalID(ctx, m.ID.String())
	if err != nil {
		return
	}
	if existing.DeletedAt != nil {
		return
	}
	kind, content := describe(m)
	if kind != message.KindUser && content == "" {
		return
	}
	next := attachments(m)
	if existing.Content == content && sameAttachments(existing.Attachments, next) {
		return
	}
	ch := timeline.Change{Origin: timeline.OriginDiscord, Synced: true, Attachments: &next}
	if m.EditedTimestamp != nil {
		ch.At = *m.EditedTimestamp
	}
	if _, err := s.Timeline.Edit(ctx, existing.ID, content, ch); err != nil {
		s.Log.Error("mirror edit", "message", m.ID, "error", err)
	}
	_ = client
}

func sameAttachments(a, b []schema.Attachment) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID {
			return false
		}
	}
	return true
}

func (s *Service) onMessageDelete(ctx context.Context, id snowflake.ID) {
	existing, err := s.Timeline.MessageByExternalID(ctx, id.String())
	if err != nil || existing.DeletedAt != nil {
		return
	}
	if err := s.Timeline.Delete(ctx, existing.ID, timeline.Change{Origin: timeline.OriginDiscord, Synced: true}); err != nil {
		s.Log.Error("mirror delete", "message", id, "error", err)
	}
}

// reactor resolves the user behind a reaction, from the cache or Discord when the member is unknown
func (s *Service) reactor(ctx context.Context, client *bot.Client, gid, uid snowflake.ID) (*ent.User, error) {
	if m, ok := client.Caches.Member(gid, uid); ok {
		u, _, err := s.Identity.EnsureExternalUser(ctx, externalUser(m.User))
		return u, err
	}
	if u, err := s.Identity.UserByIdentity(ctx, Provider, uid.String()); err == nil {
		return u, nil
	}
	du, err := client.Rest.GetUser(uid, rest.WithCtx(ctx))
	if err != nil {
		return nil, err
	}
	u, _, err := s.Identity.EnsureExternalUser(ctx, externalUser(*du))
	return u, err
}

func (s *Service) onReaction(ctx context.Context, client *bot.Client, e *events.GenericGuildMessageReaction, add bool) {
	if e.UserID == client.ID() {
		return
	}
	existing, err := s.Timeline.MessageByExternalID(ctx, e.MessageID.String())
	if err != nil {
		return
	}
	emoji := e.Emoji.Reaction()
	if emoji == "" {
		return
	}
	u, err := s.reactor(ctx, client, e.GuildID, e.UserID)
	if err != nil {
		s.Log.Warn("resolve reactor", "user", e.UserID, "error", err)
		return
	}
	if add {
		_, _, err = s.Timeline.AddReaction(ctx, existing.ID, u.ID, emoji, timeline.OriginDiscord)
	} else {
		_, _, err = s.Timeline.RemoveReaction(ctx, existing.ID, u.ID, emoji, timeline.OriginDiscord)
	}
	if err != nil {
		s.Log.Error("mirror reaction", "message", e.MessageID, "error", err)
	}
}

func (s *Service) onReactionsCleared(ctx context.Context, msgID snowflake.ID, emoji string) {
	existing, err := s.Timeline.MessageByExternalID(ctx, msgID.String())
	if err != nil {
		return
	}
	if err := s.Timeline.ClearReactions(ctx, existing.ID, emoji, timeline.OriginDiscord); err != nil {
		s.Log.Error("mirror reaction clear", "message", msgID, "error", err)
	}
}

func (s *Service) onTyping(ctx context.Context, e *events.GuildMemberTypingStart) {
	if e.UserID == e.Client().ID() {
		return
	}
	u, err := s.Identity.UserByIdentity(ctx, Provider, e.UserID.String())
	if err != nil {
		return
	}
	row, err := s.Timeline.ChannelByExternalID(ctx, e.ChannelID.String())
	if err != nil {
		return
	}
	if err := s.Timeline.Typing(ctx, row.ID, u.ID, u.DisplayName, timeline.OriginDiscord); err != nil {
		s.Log.Warn("mirror typing", "error", err)
	}
}

// onPresence records a member's Discord status against the user it maps to
func (s *Service) onPresence(ctx context.Context, p dg.Presence) {
	u, err := s.Identity.UserByIdentity(ctx, Provider, p.PresenceUser.ID.String())
	if err != nil {
		if !errors.Is(err, identity.ErrUnknownUser) {
			s.Log.Warn("presence lookup", "error", err)
		}
		return
	}
	s.Presence.SetRemote(u.ID, statusOf(p.Status))
}

func statusOf(st dg.OnlineStatus) presence.Status {
	switch st {
	case dg.OnlineStatusOnline:
		return presence.Online
	case dg.OnlineStatusIdle:
		return presence.Idle
	case dg.OnlineStatusDND:
		return presence.DND
	}
	return presence.Offline
}
