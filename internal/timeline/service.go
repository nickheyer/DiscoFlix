package timeline

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/presence"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/identity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/membership"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/reaction"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/readstate"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/schema"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	_ "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

// Authz applies staged tuples, reports when they change, and answers the visibility questions fan-out needs
type Authz interface {
	Flush(ctx context.Context) error
	OnChange(fn func())
	ListUsers(ctx context.Context, object, relation string) ([]string, bool, error)
	Has(ctx context.Context, object, relation, subject string) (bool, error)
}

// ThreadCreator creates a thread on the transport a channel mirrors and returns its external id
type ThreadCreator interface {
	CreateThread(ctx context.Context, parent *ent.Channel, name, fromExternalID string) (string, error)
}

// SystemChannels are created in the system space in this order
var SystemChannels = []string{"general", "requests", "queue", "imports", "transcodes", "audit"}

// SystemBotName is the display name of the user that authors system messages
const SystemBotName = "DiscoFlix"

// Origins a write can be attributed to
const (
	OriginWeb     = "web"
	OriginAPI     = "api"
	OriginSystem  = "system"
	OriginDiscord = "discord"
)

var (
	// ErrNotFound reports a missing space, channel, or message
	ErrNotFound = errors.New("timeline: not found")
	// ErrChannelGone reports a write to a deleted channel
	ErrChannelGone = errors.New("timeline: channel was deleted")
	// ErrNoThreads reports a thread request on a mirrored channel while the mirror is disconnected
	ErrNoThreads = errors.New("timeline: threads in mirrored channels are created on Discord, which is disconnected")
	// ErrTooLong reports content above the channel limit
	ErrTooLong = errors.New("timeline: message is longer than this channel allows")
)

// Service owns the timeline tables, the system space, and event fan-out
type Service struct {
	ent   *ent.Client
	authz Authz
	pub   Publisher
	bus   *bus
	log   *slog.Logger

	systemSpaceID string
	systemBotID   string
	channelIDs    map[string]string

	mu       sync.RWMutex
	presence *presence.Tracker
	threads  ThreadCreator
	readers  *readerCache
}

// New wires the service to its store, authorization store, and realtime publisher
func New(entc *ent.Client, az Authz, pub Publisher, log *slog.Logger) *Service {
	s := &Service{ent: entc, authz: az, pub: pub, bus: newBus(), log: log, channelIDs: map[string]string{}, readers: newReaderCache(az, time.Minute)}
	az.OnChange(s.readers.invalidateAll)
	return s
}

// SetPresence installs the tracker members' online state is read from
func (s *Service) SetPresence(t *presence.Tracker) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.presence = t
}

// SetThreadCreator installs the transport that creates threads for mirrored channels
func (s *Service) SetThreadCreator(t ThreadCreator) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.threads = t
}

func (s *Service) threadCreator() ThreadCreator {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.threads
}

func (s *Service) status(userID string) string {
	s.mu.RLock()
	t := s.presence
	s.mu.RUnlock()
	if t == nil {
		return string(presence.Offline)
	}
	return string(t.Status(userID))
}

// SystemSpaceID returns the id of the system space after EnsureSystem
func (s *Service) SystemSpaceID() string { return s.systemSpaceID }

// SystemBotID returns the id of the user that authors system messages
func (s *Service) SystemBotID() string { return s.systemBotID }

// SystemChannelID returns the id of a system channel by name such as audit
func (s *Service) SystemChannelID(name string) string { return s.channelIDs[name] }

// EnsureSystem creates the system space, its channels, and the bot user once
func (s *Service) EnsureSystem(ctx context.Context, instanceName string) error {
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	bot, err := tx.User.Query().Where(user.KindEQ(user.KindBot), user.DisplayName(SystemBotName)).Only(ctx)
	if ent.IsNotFound(err) {
		bot, err = tx.User.Create().SetDisplayName(SystemBotName).SetKind(user.KindBot).SetAccentColor("7289da").Save(ctx)
	}
	if err != nil {
		return fmt.Errorf("timeline: system bot: %w", err)
	}
	sp, err := tx.Space.Query().Where(space.KindEQ(space.KindSystem)).Only(ctx)
	if ent.IsNotFound(err) {
		sp, err = tx.Space.Create().SetKind(space.KindSystem).SetName(instanceName).SetPosition(-1).Save(ctx)
		if err == nil {
			err = authz.Stage(ctx, tx, authz.Write("space:"+sp.ID, "system", authz.SystemObject))
		}
	}
	if err != nil {
		return fmt.Errorf("timeline: system space: %w", err)
	}
	for i, name := range SystemChannels {
		ch, err := tx.Channel.Query().Where(channel.SpaceID(sp.ID), channel.Name(name)).Only(ctx)
		if ent.IsNotFound(err) {
			ch, err = tx.Channel.Create().SetSpaceID(sp.ID).SetName(name).SetKind(channel.KindText).SetPosition(int32(i)).SetTopic(systemTopics[name]).Save(ctx)
			if err == nil {
				err = authz.Stage(ctx, tx, authz.Write("channel:"+ch.ID, "space", "space:"+sp.ID))
			}
		}
		if err != nil {
			return fmt.Errorf("timeline: system channel %s: %w", name, err)
		}
		if err := s.stageOpen(ctx, tx, ch.ID); err != nil {
			return err
		}
		s.channelIDs[name] = ch.ID
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.systemSpaceID = sp.ID
	s.systemBotID = bot.ID
	return s.authz.Flush(ctx)
}

// stageOpen grants every member of the space read and post on a channel unless already granted
func (s *Service) stageOpen(ctx context.Context, tx *ent.Tx, channelID string) error {
	for _, rel := range []string{"open", "post"} {
		has, err := s.authz.Has(ctx, "channel:"+channelID, rel, authz.Everyone)
		if err != nil {
			return err
		}
		if !has {
			if err := authz.Stage(ctx, tx, authz.Write("channel:"+channelID, rel, authz.Everyone)); err != nil {
				return err
			}
		}
	}
	return nil
}

var systemTopics = map[string]string{
	"general":    "Talk to the server and the people on it",
	"requests":   "Every request and its pipeline",
	"queue":      "Downloads in flight",
	"imports":    "Files landing in libraries",
	"transcodes": "Transcode jobs and reports",
	"audit":      "Sign-ins, settings, updates, and plugin changes",
}

// RenameSystemSpace sets the system space name to the instance name
func (s *Service) RenameSystemSpace(ctx context.Context, name string) error {
	if err := s.ent.Space.UpdateOneID(s.systemSpaceID).SetName(name).Exec(ctx); err != nil {
		return err
	}
	s.notifyMembers(ctx, s.systemSpaceID, timelinev1.EventKind_EVENT_KIND_SPACES_CHANGED)
	return nil
}

// Join adds a user to a space with roles and stages the matching tuples, inside the caller's transaction
func Join(ctx context.Context, tx *ent.Tx, userID, spaceID string, roles ...string) error {
	admin := slices.Contains(roles, "admin")
	_, err := tx.Membership.Create().SetUserID(userID).SetSpaceID(spaceID).SetRoles(roles).SetAdmin(admin).Save(ctx)
	if err != nil {
		return fmt.Errorf("timeline: join: %w", err)
	}
	ops := []authz.Op{authz.Write("space:"+spaceID, "member", "user:"+userID)}
	if admin {
		ops = append(ops, authz.Write("space:"+spaceID, "admin", "user:"+userID))
	}
	return authz.Stage(ctx, tx, ops...)
}

// PostInput describes a message to append
type PostInput struct {
	ChannelID   string
	AuthorID    string
	Kind        message.Kind
	Content     string
	Card        proto.Message
	CardAny     *anypb.Any
	ReplyTo     int64
	External    string
	Origin      string
	Attachments []schema.Attachment
	// Zero means now, the mirror passes the remote timestamp
	CreatedAt time.Time
	// True when the remote copy already matches, so the mirror does not send it back
	Synced bool
}

// Post appends a message and emits its event after commit
func (s *Service) Post(ctx context.Context, in PostInput) (*timelinev1.Message, error) {
	card := in.CardAny
	if in.Card != nil {
		var err error
		if card, err = anypb.New(in.Card); err != nil {
			return nil, fmt.Errorf("timeline: pack card: %w", err)
		}
	}
	kind := in.Kind
	if kind == "" {
		kind = message.KindUser
		if card != nil {
			kind = message.KindCard
		}
	}
	origin := in.Origin
	if origin == "" {
		origin = OriginSystem
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	ch, err := tx.Channel.Get(ctx, in.ChannelID)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if ch.DeletedAt != nil {
		return nil, ErrChannelGone
	}
	now := time.Now()
	createdAt := in.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	create := tx.Message.Create().
		SetSpaceID(ch.SpaceID).
		SetChannelID(ch.ID).
		SetAuthorID(in.AuthorID).
		SetKind(kind).
		SetContent(in.Content).
		SetReplyTo(in.ReplyTo).
		SetExternalID(in.External).
		SetOrigin(origin).
		SetCreatedAt(createdAt).
		SetUpdatedAt(now)
	if len(in.Attachments) > 0 {
		create.SetAttachments(in.Attachments)
	}
	if in.Synced {
		create.SetSyncedAt(now)
	}
	if card != nil {
		create.SetCardType(card.GetTypeUrl()).SetCard(card.GetValue())
	}
	m, err := create.Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("timeline: post: %w", err)
	}
	if err := tx.Channel.UpdateOneID(ch.ID).SetLastSeq(m.ID).Exec(ctx); err != nil {
		return nil, err
	}
	if m.Edges.Author, err = tx.User.Query().Where(user.ID(in.AuthorID)).WithMergedInto().Only(ctx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	pm := messageProto(m, "")
	s.emit(&timelinev1.Event{Seq: m.ID, Kind: timelinev1.EventKind_EVENT_KIND_MESSAGE_CREATED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now(), Origin: origin})
	return pm, nil
}

// PostSystem appends a system card authored by the bot to a named system channel
func (s *Service) PostSystem(ctx context.Context, channelName, content string, card proto.Message) (*timelinev1.Message, error) {
	id, ok := s.channelIDs[channelName]
	if !ok {
		return nil, fmt.Errorf("timeline: no system channel %q", channelName)
	}
	return s.Post(ctx, PostInput{ChannelID: id, AuthorID: s.systemBotID, Kind: message.KindSystem, Content: content, Card: card, Origin: OriginSystem})
}

// Change describes who made an edit or delete and whether the remote copy already has it
type Change struct {
	Origin string
	Synced bool
	// Zero means now
	At          time.Time
	Attachments *[]schema.Attachment
}

func (c Change) at() time.Time {
	if c.At.IsZero() {
		return time.Now()
	}
	return c.At
}

func (c Change) origin() string {
	if c.Origin == "" {
		return OriginSystem
	}
	return c.Origin
}

// Sorts eager-loaded rows oldest first so per-emoji counts keep first-seen order on every read
func reactionsInOrder(q *ent.ReactionQuery) {
	q.Order(ent.Asc(reaction.FieldCreatedAt), ent.Asc(reaction.FieldID))
}

func (s *Service) liveMessage(ctx context.Context, seq int64) (*ent.Message, error) {
	m, err := s.ent.Message.Query().Where(message.ID(seq), message.DeletedAtIsNil()).WithAuthor(func(q *ent.UserQuery) { q.WithMergedInto() }).WithReactions(reactionsInOrder).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return m, err
}

// Edit replaces the content of a message and emits the edit
func (s *Service) Edit(ctx context.Context, seq int64, content string, ch Change) (*timelinev1.Message, error) {
	m, err := s.liveMessage(ctx, seq)
	if err != nil {
		return nil, err
	}
	at := ch.at()
	now := time.Now()
	upd := s.ent.Message.UpdateOneID(seq).SetContent(content).SetEditedAt(at).SetUpdatedAt(now)
	if ch.Attachments != nil {
		upd.SetAttachments(*ch.Attachments)
		m.Attachments = *ch.Attachments
	}
	if ch.Synced {
		upd.SetSyncedAt(now)
	}
	if err := upd.Exec(ctx); err != nil {
		return nil, err
	}
	m.Content, m.EditedAt = content, &at
	pm := messageProto(m, "")
	s.emit(&timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_MESSAGE_EDITED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now(), Origin: ch.origin()})
	return pm, nil
}

// UpdateCard replaces the card payload of a message in place and emits the update
func (s *Service) UpdateCard(ctx context.Context, seq int64, card proto.Message, origin string) (*timelinev1.Message, error) {
	packed, err := anypb.New(card)
	if err != nil {
		return nil, err
	}
	m, err := s.liveMessage(ctx, seq)
	if err != nil {
		return nil, err
	}
	if err := s.ent.Message.UpdateOneID(seq).SetCardType(packed.GetTypeUrl()).SetCard(packed.GetValue()).SetUpdatedAt(time.Now()).Exec(ctx); err != nil {
		return nil, err
	}
	m.CardType, m.Card = packed.GetTypeUrl(), packed.GetValue()
	pm := messageProto(m, "")
	if origin == "" {
		origin = OriginSystem
	}
	s.emit(&timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_CARD_UPDATED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now(), Origin: origin})
	return pm, nil
}

// Delete tombstones a message and emits the deletion
func (s *Service) Delete(ctx context.Context, seq int64, ch Change) error {
	m, err := s.liveMessage(ctx, seq)
	if err != nil {
		return err
	}
	at := ch.at()
	now := time.Now()
	upd := s.ent.Message.UpdateOneID(seq).SetDeletedAt(at).SetContent("").ClearCard().SetCardType("").ClearAttachments().SetUpdatedAt(now)
	if ch.Synced {
		upd.SetSyncedAt(now)
	}
	if err := upd.Exec(ctx); err != nil {
		return err
	}
	m.DeletedAt = &at
	pm := messageProto(m, "")
	s.emit(&timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_MESSAGE_DELETED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now(), Origin: ch.origin()})
	return nil
}

// MarkSynced records that the remote copy matches the row, storing its external id when given
func (s *Service) MarkSynced(ctx context.Context, seq int64, externalID string) error {
	m, err := s.ent.Message.Get(ctx, seq)
	if ent.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	upd := s.ent.Message.UpdateOneID(seq).SetUpdatedAt(m.UpdatedAt).SetSyncedAt(m.UpdatedAt)
	if externalID != "" {
		upd.SetExternalID(externalID)
	}
	return upd.Exec(ctx)
}

// Unsynced returns messages in the channel whose remote copy is missing or behind, oldest first
func (s *Service) Unsynced(ctx context.Context, channelID string, limit int) ([]*ent.Message, error) {
	return s.ent.Message.Query().
		Where(message.ChannelID(channelID), message.SyncedAtIsNil()).
		Order(ent.Asc(message.FieldID)).
		Limit(limit).
		WithAuthor(func(q *ent.UserQuery) { q.WithMergedInto() }).
		WithReactions(reactionsInOrder).
		All(ctx)
}

// Stale returns messages whose row changed after the remote copy was last written, oldest first
func (s *Service) Stale(ctx context.Context, channelID string, limit int) ([]*ent.Message, error) {
	return s.ent.Message.Query().
		Where(message.ChannelID(channelID), message.SyncedAtNotNil(), func(sel *entsql.Selector) {
			sel.Where(entsql.ColumnsGT(sel.C(message.FieldUpdatedAt), sel.C(message.FieldSyncedAt)))
		}).
		Order(ent.Asc(message.FieldID)).
		Limit(limit).
		WithAuthor(func(q *ent.UserQuery) { q.WithMergedInto() }).
		WithReactions().
		All(ctx)
}

// GetMessage loads one message with its author and reactions
func (s *Service) GetMessage(ctx context.Context, seq int64) (*ent.Message, error) {
	m, err := s.ent.Message.Query().Where(message.ID(seq)).WithAuthor(func(q *ent.UserQuery) { q.WithMergedInto() }).WithReactions(reactionsInOrder).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return m, err
}

// MessageByExternalID finds the row mirrored from a remote message id
func (s *Service) MessageByExternalID(ctx context.Context, externalID string) (*ent.Message, error) {
	m, err := s.ent.Message.Query().Where(message.ExternalID(externalID)).WithAuthor(func(q *ent.UserQuery) { q.WithMergedInto() }).WithReactions(reactionsInOrder).First(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return m, err
}

// Proto renders a loaded row for a viewer
func (s *Service) Proto(m *ent.Message, viewerID string) *timelinev1.Message {
	return messageProto(m, viewerID)
}

// ListMessages returns up to limit messages before seq, newest first, plus whether older ones exist
func (s *Service) ListMessages(ctx context.Context, viewerID, channelID string, beforeSeq int64, limit int) ([]*timelinev1.Message, bool, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := s.ent.Message.Query().Where(message.ChannelID(channelID))
	if beforeSeq > 0 {
		q = q.Where(message.IDLT(beforeSeq))
	}
	rows, err := q.Order(ent.Desc(message.FieldID)).Limit(limit + 1).WithAuthor(func(q *ent.UserQuery) { q.WithMergedInto() }).WithReactions(reactionsInOrder).All(ctx)
	if err != nil {
		return nil, false, err
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	out := make([]*timelinev1.Message, len(rows))
	for i, m := range rows {
		out[i] = messageProto(m, viewerID)
	}
	return out, more, nil
}

// AddReaction records one user's emoji on a message, reporting whether it was new
func (s *Service) AddReaction(ctx context.Context, seq int64, userID, emoji, origin string) (*timelinev1.Message, bool, error) {
	m, err := s.liveMessage(ctx, seq)
	if err != nil {
		return nil, false, err
	}
	if origin == "" {
		origin = OriginSystem
	}
	if err := s.ent.Reaction.Create().SetMessageID(seq).SetUserID(userID).SetEmoji(emoji).SetOrigin(origin).
		OnConflictColumns(reaction.FieldMessageID, reaction.FieldUserID, reaction.FieldEmoji).Ignore().Exec(ctx); err != nil {
		return nil, false, err
	}
	rows, err := s.ent.Reaction.Query().Where(reaction.MessageID(seq)).Order(ent.Asc(reaction.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, false, err
	}
	added := len(rows) != len(m.Edges.Reactions)
	if added {
		if err := s.touchReactions(ctx, seq, origin); err != nil {
			return nil, false, err
		}
	}
	m.Edges.Reactions = rows
	pm := messageProto(m, userID)
	if added {
		s.emit(&timelinev1.Event{
			Kind: timelinev1.EventKind_EVENT_KIND_REACTION_ADDED, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now(), Origin: origin,
			Reaction: &timelinev1.ReactionChange{Seq: seq, Emoji: emoji, UserId: userID, Count: countEmoji(rows, emoji)},
		})
	}
	return pm, added, nil
}

// RemoveReaction deletes one user's emoji from a message, reporting whether it existed
func (s *Service) RemoveReaction(ctx context.Context, seq int64, userID, emoji, origin string) (*timelinev1.Message, bool, error) {
	m, err := s.liveMessage(ctx, seq)
	if err != nil {
		return nil, false, err
	}
	if origin == "" {
		origin = OriginSystem
	}
	n, err := s.ent.Reaction.Delete().Where(reaction.MessageID(seq), reaction.UserID(userID), reaction.Emoji(emoji)).Exec(ctx)
	if err != nil {
		return nil, false, err
	}
	rows, err := s.ent.Reaction.Query().Where(reaction.MessageID(seq)).Order(ent.Asc(reaction.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, false, err
	}
	if n > 0 {
		if err := s.touchReactions(ctx, seq, origin); err != nil {
			return nil, false, err
		}
	}
	m.Edges.Reactions = rows
	pm := messageProto(m, userID)
	if n > 0 {
		s.emit(&timelinev1.Event{
			Kind: timelinev1.EventKind_EVENT_KIND_REACTION_REMOVED, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now(), Origin: origin,
			Reaction: &timelinev1.ReactionChange{Seq: seq, Emoji: emoji, UserId: userID, Count: countEmoji(rows, emoji)},
		})
	}
	return pm, n > 0, nil
}

// ClearReactions removes every reaction with the emoji, or every reaction when emoji is empty
func (s *Service) ClearReactions(ctx context.Context, seq int64, emoji, origin string) error {
	m, err := s.liveMessage(ctx, seq)
	if err != nil {
		return err
	}
	for _, r := range m.Edges.Reactions {
		if emoji != "" && r.Emoji != emoji {
			continue
		}
		if _, _, err := s.RemoveReaction(ctx, seq, r.UserID, r.Emoji, origin); err != nil {
			return err
		}
	}
	return nil
}

// Advances updated_at after a change made outside Discord so the mirror pushes it as stale
func (s *Service) touchReactions(ctx context.Context, seq int64, origin string) error {
	if origin == OriginDiscord {
		return nil
	}
	return s.ent.Message.UpdateOneID(seq).SetUpdatedAt(time.Now()).Exec(ctx)
}

// Reactors returns every reaction row on a message
func (s *Service) Reactors(ctx context.Context, seq int64) ([]*ent.Reaction, error) {
	return s.ent.Reaction.Query().Where(reaction.MessageID(seq)).All(ctx)
}

func countEmoji(rows []*ent.Reaction, emoji string) int64 {
	var n int64
	for _, r := range rows {
		if r.Emoji == emoji {
			n++
		}
	}
	return n
}

// ListSpaces returns the spaces the user belongs to, or every space for a system administrator, with unread counts
func (s *Service) ListSpaces(ctx context.Context, userID string) ([]*timelinev1.Space, error) {
	u, err := s.ent.User.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	q := s.ent.Space.Query()
	if !u.SystemAdmin {
		q = q.Where(space.HasMembershipsWith(membership.UserID(userID)))
	}
	spaces, err := q.Order(ent.Asc(space.FieldPosition), ent.Asc(space.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*timelinev1.Space, 0, len(spaces))
	for _, sp := range spaces {
		chans, err := s.ListChannels(ctx, userID, sp.ID)
		if err != nil {
			return nil, err
		}
		var unread int64
		for _, c := range chans {
			unread += c.Unread
		}
		out = append(out, spaceProto(sp, unread))
	}
	return out, nil
}

// ListChannels returns the channels of a space the user may read with their read cursor and unread count
func (s *Service) ListChannels(ctx context.Context, userID, spaceID string) ([]*timelinev1.Channel, error) {
	sp, err := s.GetSpace(ctx, spaceID)
	if err != nil {
		return nil, err
	}
	chans, err := s.ent.Channel.Query().
		Where(channel.SpaceID(spaceID), channel.DeletedAtIsNil(), channel.Archived(false)).
		Order(ent.Asc(channel.FieldPosition), ent.Asc(channel.FieldCreatedAt)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	members := func() ([]string, error) { return s.MemberUserIDs(ctx, spaceID) }
	allowed := make(map[string]bool, len(chans))
	for _, c := range chans {
		if c.Kind == channel.KindCategory {
			continue
		}
		readers, err := s.readers.readers(ctx, c.ID, members)
		if err != nil {
			return nil, err
		}
		if slices.Contains(readers, userID) {
			allowed[c.ID] = true
		}
	}
	states, err := s.ent.ReadState.Query().Where(readstate.UserID(userID), readstate.HasChannelWith(channel.SpaceID(spaceID))).All(ctx)
	if err != nil {
		return nil, err
	}
	lastRead := map[string]int64{}
	for _, rs := range states {
		lastRead[rs.ChannelID] = rs.LastReadSeq
	}
	maxContent := MaxContentFor(sp.Kind)
	out := make([]*timelinev1.Channel, 0, len(chans))
	for _, c := range chans {
		if !allowed[c.ID] && c.Kind != channel.KindCategory {
			continue
		}
		unread, err := s.ent.Message.Query().Where(message.ChannelID(c.ID), message.IDGT(lastRead[c.ID]), message.DeletedAtIsNil()).Count(ctx)
		if err != nil {
			return nil, err
		}
		out = append(out, channelProto(c, lastRead[c.ID], int64(unread), maxContent))
	}
	return out, nil
}

// ListMembers returns the members of a space with roles and presence, merged users folded into their survivor
func (s *Service) ListMembers(ctx context.Context, spaceID string) ([]*timelinev1.Member, []*timelinev1.Role, error) {
	sp, err := s.GetSpace(ctx, spaceID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.ent.Membership.Query().
		Where(membership.SpaceID(spaceID), membership.HasUserWith(user.MergedIntoIDIsNil(), user.StatusEQ(user.StatusActive))).
		WithUser().
		All(ctx)
	if err != nil {
		return nil, nil, err
	}
	userIDs := make([]string, 0, len(rows))
	for _, m := range rows {
		userIDs = append(userIDs, m.UserID)
	}
	ids, err := s.ent.Identity.Query().Where(identity.Provider("discord"), identity.UserIDIn(userIDs...)).All(ctx)
	if err != nil {
		return nil, nil, err
	}
	external := map[string]string{}
	for _, id := range ids {
		external[id.UserID] = id.Subject
	}
	out := make([]*timelinev1.Member, 0, len(rows))
	for _, m := range rows {
		out = append(out, memberProto(m, external[m.UserID], s.status(m.UserID)))
	}
	slices.SortFunc(out, func(a, b *timelinev1.Member) int {
		return compareFold(a.GetUser().GetDisplayName(), b.GetUser().GetDisplayName())
	})
	return out, roleProtos(sp.Roles), nil
}

func compareFold(a, b string) int {
	switch {
	case a == b:
		return 0
	case a < b:
		return -1
	}
	return 1
}

// GetChannel loads one channel
func (s *Service) GetChannel(ctx context.Context, channelID string) (*ent.Channel, error) {
	c, err := s.ent.Channel.Get(ctx, channelID)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return c, err
}

// ChannelByExternalID finds the channel mirrored from a remote channel id
func (s *Service) ChannelByExternalID(ctx context.Context, externalID string) (*ent.Channel, error) {
	c, err := s.ent.Channel.Query().Where(channel.ExternalID(externalID), channel.DeletedAtIsNil()).First(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return c, err
}

// GetSpace loads one space
func (s *Service) GetSpace(ctx context.Context, spaceID string) (*ent.Space, error) {
	sp, err := s.ent.Space.Get(ctx, spaceID)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return sp, err
}

// SpaceByExternalID finds the space mirrored from a remote id such as a guild
func (s *Service) SpaceByExternalID(ctx context.Context, kind space.Kind, externalID string) (*ent.Space, error) {
	sp, err := s.ent.Space.Query().Where(space.KindEQ(kind), space.ExternalID(externalID)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return sp, err
}

// SpaceOf returns the space an authorization object lives in
func (s *Service) SpaceOf(ctx context.Context, objectType, id string) (string, error) {
	switch objectType {
	case "space":
		return id, nil
	case "channel":
		c, err := s.GetChannel(ctx, id)
		if err != nil {
			return "", err
		}
		return c.SpaceID, nil
	case "message":
		var seq int64
		if _, err := fmt.Sscan(id, &seq); err != nil {
			return "", ErrNotFound
		}
		m, err := s.GetMessage(ctx, seq)
		if err != nil {
			return "", err
		}
		return m.SpaceID, nil
	}
	return "", nil
}

// ApprovalsChannel returns the channel approvals for a space are posted to, falling back to the system audit channel
func (s *Service) ApprovalsChannel(ctx context.Context, spaceID string) (string, error) {
	if spaceID != "" {
		sp, err := s.GetSpace(ctx, spaceID)
		if err != nil {
			return "", err
		}
		if sp.ApprovalsChannelID != "" {
			c, err := s.GetChannel(ctx, sp.ApprovalsChannelID)
			if err == nil && c.DeletedAt == nil {
				return c.ID, nil
			}
		}
	}
	return s.channelIDs["audit"], nil
}

// SetApprovalsChannel points a space's approvals at one of its channels, empty restores the default
func (s *Service) SetApprovalsChannel(ctx context.Context, spaceID, channelID string) error {
	if channelID != "" {
		c, err := s.GetChannel(ctx, channelID)
		if err != nil {
			return err
		}
		if c.SpaceID != spaceID || c.Kind != channel.KindText || c.DeletedAt != nil {
			return ErrNotFound
		}
	}
	if err := s.ent.Space.UpdateOneID(spaceID).SetApprovalsChannelID(channelID).Exec(ctx); err != nil {
		if ent.IsNotFound(err) {
			return ErrNotFound
		}
		return err
	}
	s.notifyMembers(ctx, spaceID, timelinev1.EventKind_EVENT_KIND_SPACES_CHANGED)
	return nil
}

// SpaceInput describes a space mirrored from a transport
type SpaceInput struct {
	Kind       space.Kind
	ExternalID string
	Name       string
	IconURL    string
	Position   int32
	Roles      []schema.Role
}

// UpsertSpace creates or updates the space mirrored from an external id, reporting whether it was created
func (s *Service) UpsertSpace(ctx context.Context, in SpaceInput) (*ent.Space, bool, error) {
	if in.ExternalID == "" {
		return nil, false, errors.New("timeline: upsert space needs an external id")
	}
	existing, err := s.SpaceByExternalID(ctx, in.Kind, in.ExternalID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	if existing != nil {
		changed := existing.Name != in.Name || existing.IconURL != in.IconURL || !slices.Equal(existing.Roles, in.Roles)
		if !changed {
			return existing, false, nil
		}
		updated, err := s.ent.Space.UpdateOneID(existing.ID).SetName(in.Name).SetIconURL(in.IconURL).SetRoles(in.Roles).Save(ctx)
		if err != nil {
			return nil, false, err
		}
		s.notifyMembers(ctx, existing.ID, timelinev1.EventKind_EVENT_KIND_SPACES_CHANGED)
		return updated, false, nil
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	sp, err := tx.Space.Create().SetKind(in.Kind).SetExternalID(in.ExternalID).SetName(in.Name).SetIconURL(in.IconURL).SetPosition(in.Position).SetRoles(in.Roles).Save(ctx)
	if err != nil {
		return nil, false, err
	}
	if err := authz.Stage(ctx, tx, authz.Write("space:"+sp.ID, "system", authz.SystemObject)); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return sp, true, s.authz.Flush(ctx)
}

// ChannelInput describes a channel mirrored from a transport or created from a thread request
type ChannelInput struct {
	SpaceID    string
	ExternalID string
	Kind       channel.Kind
	Name       string
	Topic      string
	ParentID   string
	Position   int32
	Archived   bool
	// Grants every member read and post, used for channels without their own visibility rules
	Open bool
}

// UpsertChannel creates or updates a channel, matching mirrored channels by external id, and reports creation
func (s *Service) UpsertChannel(ctx context.Context, in ChannelInput) (*ent.Channel, bool, error) {
	var existing *ent.Channel
	if in.ExternalID != "" {
		c, err := s.ent.Channel.Query().Where(channel.SpaceID(in.SpaceID), channel.ExternalID(in.ExternalID)).First(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, false, err
		}
		existing = c
	}
	if existing != nil {
		same := existing.Name == in.Name && existing.Topic == in.Topic && existing.ParentID == in.ParentID && existing.Position == in.Position && existing.Archived == in.Archived && existing.Kind == in.Kind && existing.DeletedAt == nil
		if same {
			return existing, false, nil
		}
		updated, err := s.ent.Channel.UpdateOneID(existing.ID).SetName(in.Name).SetTopic(in.Topic).SetParentID(in.ParentID).SetPosition(in.Position).SetArchived(in.Archived).SetKind(in.Kind).ClearDeletedAt().Save(ctx)
		if err != nil {
			return nil, false, err
		}
		s.emitSpace(in.SpaceID, timelinev1.EventKind_EVENT_KIND_CHANNELS_CHANGED)
		return updated, false, nil
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	c, err := tx.Channel.Create().SetSpaceID(in.SpaceID).SetExternalID(in.ExternalID).SetKind(in.Kind).SetName(in.Name).SetTopic(in.Topic).SetParentID(in.ParentID).SetPosition(in.Position).SetArchived(in.Archived).Save(ctx)
	if err != nil {
		return nil, false, err
	}
	ops := []authz.Op{authz.Write("channel:"+c.ID, "space", "space:"+in.SpaceID)}
	if in.Open {
		ops = append(ops, authz.Write("channel:"+c.ID, "open", authz.Everyone), authz.Write("channel:"+c.ID, "post", authz.Everyone))
	}
	if err := authz.Stage(ctx, tx, ops...); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	if err := s.authz.Flush(ctx); err != nil {
		return nil, false, err
	}
	s.emitSpace(in.SpaceID, timelinev1.EventKind_EVENT_KIND_CHANNELS_CHANGED)
	return c, true, nil
}

// DeleteChannel hides a channel from listings while keeping its history
func (s *Service) DeleteChannel(ctx context.Context, channelID string) error {
	c, err := s.GetChannel(ctx, channelID)
	if err != nil {
		return err
	}
	if c.DeletedAt != nil {
		return nil
	}
	if err := s.ent.Channel.UpdateOneID(channelID).SetDeletedAt(time.Now()).Exec(ctx); err != nil {
		return err
	}
	s.emitSpace(c.SpaceID, timelinev1.EventKind_EVENT_KIND_CHANNELS_CHANGED)
	return nil
}

// CreateThread starts a thread under a channel, on Discord first when the channel is mirrored
func (s *Service) CreateThread(ctx context.Context, parentID, name string, fromSeq int64) (*ent.Channel, error) {
	parent, err := s.GetChannel(ctx, parentID)
	if err != nil {
		return nil, err
	}
	if parent.DeletedAt != nil {
		return nil, ErrChannelGone
	}
	sp, err := s.GetSpace(ctx, parent.SpaceID)
	if err != nil {
		return nil, err
	}
	fromExternal := ""
	if fromSeq > 0 {
		m, err := s.GetMessage(ctx, fromSeq)
		if err != nil {
			return nil, err
		}
		if m.ChannelID != parent.ID {
			return nil, ErrNotFound
		}
		fromExternal = m.ExternalID
	}
	in := ChannelInput{SpaceID: parent.SpaceID, Kind: channel.KindThread, Name: name, ParentID: parent.ID, Position: parent.Position, Open: sp.Kind != space.KindGuild}
	if sp.Kind == space.KindGuild {
		tc := s.threadCreator()
		if tc == nil {
			return nil, ErrNoThreads
		}
		if in.ExternalID, err = tc.CreateThread(ctx, parent, name, fromExternal); err != nil {
			return nil, err
		}
	}
	c, _, err := s.UpsertChannel(ctx, in)
	return c, err
}

// MemberInput describes one user's membership in a space
type MemberInput struct {
	UserID   string
	SpaceID  string
	Roles    []string
	Nickname string
	Admin    bool
}

// UpsertMember creates or updates a membership and its tuples, reporting whether it was created
func (s *Service) UpsertMember(ctx context.Context, in MemberInput) (bool, error) {
	existing, err := s.ent.Membership.Query().Where(membership.UserID(in.UserID), membership.SpaceID(in.SpaceID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return false, err
	}
	roles := in.Roles
	if roles == nil {
		roles = []string{}
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var ops []authz.Op
	created := existing == nil
	switch {
	case created:
		if _, err := tx.Membership.Create().SetUserID(in.UserID).SetSpaceID(in.SpaceID).SetRoles(roles).SetNickname(in.Nickname).SetAdmin(in.Admin).Save(ctx); err != nil {
			return false, err
		}
		ops = append(ops, authz.Write("space:"+in.SpaceID, "member", "user:"+in.UserID))
		if in.Admin {
			ops = append(ops, authz.Write("space:"+in.SpaceID, "admin", "user:"+in.UserID))
		}
	default:
		if slices.Equal(existing.Roles, roles) && existing.Nickname == in.Nickname && existing.Admin == in.Admin {
			return false, nil
		}
		if err := tx.Membership.UpdateOneID(existing.ID).SetRoles(roles).SetNickname(in.Nickname).SetAdmin(in.Admin).Exec(ctx); err != nil {
			return false, err
		}
		switch {
		case in.Admin && !existing.Admin:
			ops = append(ops, authz.Write("space:"+in.SpaceID, "admin", "user:"+in.UserID))
		case !in.Admin && existing.Admin:
			ops = append(ops, authz.Delete("space:"+in.SpaceID, "admin", "user:"+in.UserID))
		}
	}
	if len(ops) > 0 {
		if err := authz.Stage(ctx, tx, ops...); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	if err := s.authz.Flush(ctx); err != nil {
		return false, err
	}
	s.readers.invalidateSpace(in.SpaceID)
	s.emitSpace(in.SpaceID, timelinev1.EventKind_EVENT_KIND_MEMBERS_CHANGED)
	if created {
		s.emitUser(in.UserID, &timelinev1.Event{Kind: timelinev1.EventKind_EVENT_KIND_SPACES_CHANGED, SpaceId: in.SpaceID, At: timestamppb.Now(), Origin: OriginSystem})
	}
	return created, nil
}

// RemoveMember deletes a membership and its tuples
func (s *Service) RemoveMember(ctx context.Context, userID, spaceID string) error {
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	n, err := tx.Membership.Delete().Where(membership.UserID(userID), membership.SpaceID(spaceID)).Exec(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		return nil
	}
	if err := authz.Stage(ctx, tx, authz.Delete("space:"+spaceID, "member", "user:"+userID), authz.Delete("space:"+spaceID, "admin", "user:"+userID)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := s.authz.Flush(ctx); err != nil {
		return err
	}
	s.readers.invalidateSpace(spaceID)
	s.emitSpace(spaceID, timelinev1.EventKind_EVENT_KIND_MEMBERS_CHANGED)
	s.emitUser(userID, &timelinev1.Event{Kind: timelinev1.EventKind_EVENT_KIND_SPACES_CHANGED, SpaceId: spaceID, At: timestamppb.Now(), Origin: OriginSystem})
	return nil
}

// MemberUserIDs returns the ids of every member of a space
func (s *Service) MemberUserIDs(ctx context.Context, spaceID string) ([]string, error) {
	return s.ent.Membership.Query().Where(membership.SpaceID(spaceID)).Select(membership.FieldUserID).Strings(ctx)
}

// InvalidateReaders forgets cached visibility for a channel after its tuples changed
func (s *Service) InvalidateReaders(channelID string) { s.readers.invalidate(channelID) }

// InvalidateSpaceReaders forgets cached visibility for every channel in a space
func (s *Service) InvalidateSpaceReaders(spaceID string) { s.readers.invalidateSpace(spaceID) }

// MarkRead advances the user's cursor on a channel and emits a read event to that user
func (s *Service) MarkRead(ctx context.Context, userID, channelID string, seq int64) (*timelinev1.Channel, error) {
	ch, err := s.GetChannel(ctx, channelID)
	if err != nil {
		return nil, err
	}
	sp, err := s.GetSpace(ctx, ch.SpaceID)
	if err != nil {
		return nil, err
	}
	if seq <= 0 || seq > ch.LastSeq {
		seq = ch.LastSeq
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rs, err := tx.ReadState.Query().Where(readstate.UserID(userID), readstate.ChannelID(channelID)).Only(ctx)
	switch {
	case ent.IsNotFound(err):
		_, err = tx.ReadState.Create().SetUserID(userID).SetChannelID(channelID).SetLastReadSeq(seq).Save(ctx)
	case err == nil && rs.LastReadSeq < seq:
		err = tx.ReadState.UpdateOneID(rs.ID).SetLastReadSeq(seq).Exec(ctx)
	case err == nil:
		seq = rs.LastReadSeq
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	unread, err := s.ent.Message.Query().Where(message.ChannelID(channelID), message.IDGT(seq), message.DeletedAtIsNil()).Count(ctx)
	if err != nil {
		return nil, err
	}
	out := channelProto(ch, seq, int64(unread), MaxContentFor(sp.Kind))
	s.emitUser(userID, &timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_CHANNEL_READ, ChannelId: channelID, SpaceId: ch.SpaceID, At: timestamppb.Now(), Origin: OriginSystem})
	return out, nil
}

// Typing tells everyone watching a channel that a user is writing
func (s *Service) Typing(ctx context.Context, channelID, userID, displayName, origin string) error {
	ch, err := s.GetChannel(ctx, channelID)
	if err != nil {
		return err
	}
	if origin == "" {
		origin = OriginSystem
	}
	ev := &timelinev1.Event{
		Kind: timelinev1.EventKind_EVENT_KIND_TYPING, ChannelId: ch.ID, SpaceId: ch.SpaceID, At: timestamppb.Now(), Origin: origin,
		Typing: &timelinev1.Typing{ChannelId: ch.ID, UserId: userID, DisplayName: displayName},
	}
	data, err := protojson.Marshal(ev)
	if err != nil {
		return err
	}
	if err := s.pub.Publish(ChannelName(ch.SpaceID, ch.ID), data); err != nil {
		s.log.Warn("publish typing", "channel", ch.ID, "error", err)
	}
	s.bus.publish(ev)
	return nil
}

// PresenceChanged publishes a user's new status to every space they belong to
func (s *Service) PresenceChanged(userID string, status presence.Status) {
	ctx := context.Background()
	spaces, err := s.ent.Membership.Query().Where(membership.UserID(userID)).Select(membership.FieldSpaceID).Strings(ctx)
	if err != nil {
		s.log.Error("list spaces for presence", "user", userID, "error", err)
		return
	}
	for _, spaceID := range spaces {
		ev := &timelinev1.Event{
			Kind: timelinev1.EventKind_EVENT_KIND_PRESENCE_CHANGED, SpaceId: spaceID, At: timestamppb.Now(), Origin: OriginSystem,
			Presence: &timelinev1.PresenceChange{UserId: userID, Status: string(status)},
		}
		data, err := protojson.Marshal(ev)
		if err != nil {
			continue
		}
		if err := s.pub.Publish(SpaceName(spaceID), data); err != nil {
			s.log.Warn("publish presence", "space", spaceID, "error", err)
		}
		s.bus.publish(ev)
	}
}

// Subscribe returns a live subscription to every event, buffered for slow readers
func (s *Service) Subscribe() *Subscription {
	return s.bus.subscribe(512)
}

// EventsAfter replays stored messages with seq above afterSeq as created events, oldest first
func (s *Service) EventsAfter(ctx context.Context, afterSeq int64, spaceID string, limit int) ([]*timelinev1.Event, error) {
	q := s.ent.Message.Query().Where(message.IDGT(afterSeq))
	if spaceID != "" {
		q = q.Where(message.SpaceID(spaceID))
	}
	rows, err := q.Order(ent.Asc(message.FieldID)).Limit(limit).WithAuthor(func(q *ent.UserQuery) { q.WithMergedInto() }).WithReactions(reactionsInOrder).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*timelinev1.Event, 0, len(rows))
	for _, m := range rows {
		kind := timelinev1.EventKind_EVENT_KIND_MESSAGE_CREATED
		if m.DeletedAt != nil {
			kind = timelinev1.EventKind_EVENT_KIND_MESSAGE_DELETED
		} else if m.EditedAt != nil {
			kind = timelinev1.EventKind_EVENT_KIND_MESSAGE_EDITED
		}
		out = append(out, &timelinev1.Event{Seq: m.ID, Kind: kind, Message: messageProto(m, ""), ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.New(m.CreatedAt), Origin: m.Origin})
	}
	return out, nil
}

// emit publishes a channel event to its channel stream, to every reader's user stream, and to in-process subscribers
func (s *Service) emit(ev *timelinev1.Event) {
	data, err := protojson.Marshal(ev)
	if err != nil {
		s.log.Error("encode event", "seq", ev.GetSeq(), "error", err)
		return
	}
	if err := s.pub.Publish(ChannelName(ev.GetSpaceId(), ev.GetChannelId()), data); err != nil {
		s.log.Warn("publish event", "seq", ev.GetSeq(), "error", err)
	}
	ctx := context.Background()
	readers, err := s.readers.readers(ctx, ev.GetChannelId(), func() ([]string, error) { return s.MemberUserIDs(ctx, ev.GetSpaceId()) })
	if err != nil {
		s.log.Error("list readers for event", "channel", ev.GetChannelId(), "error", err)
	}
	for _, uid := range readers {
		if err := s.pub.Publish(UserChannel(uid), data); err != nil {
			s.log.Warn("publish user event", "seq", ev.GetSeq(), "user", uid, "error", err)
		}
	}
	s.bus.publish(ev)
}

// emitSpace publishes a structure event to a space stream and in-process subscribers
func (s *Service) emitSpace(spaceID string, kind timelinev1.EventKind) {
	ev := &timelinev1.Event{Kind: kind, SpaceId: spaceID, At: timestamppb.Now(), Origin: OriginSystem}
	data, err := protojson.Marshal(ev)
	if err != nil {
		return
	}
	if err := s.pub.Publish(SpaceName(spaceID), data); err != nil {
		s.log.Warn("publish space event", "space", spaceID, "error", err)
	}
	s.bus.publish(ev)
}

// emitUser publishes a private event to one user's stream and in-process subscribers
func (s *Service) emitUser(userID string, ev *timelinev1.Event) {
	data, err := protojson.Marshal(ev)
	if err != nil {
		return
	}
	if err := s.pub.Publish(UserChannel(userID), data); err != nil {
		s.log.Warn("publish user event", "user", userID, "error", err)
	}
	s.bus.publish(ev)
}

// notifyMembers tells every member of a space that its listing changed
func (s *Service) notifyMembers(ctx context.Context, spaceID string, kind timelinev1.EventKind) {
	ids, err := s.MemberUserIDs(ctx, spaceID)
	if err != nil {
		s.log.Error("list members", "space", spaceID, "error", err)
		return
	}
	for _, uid := range ids {
		s.emitUser(uid, &timelinev1.Event{Kind: kind, SpaceId: spaceID, At: timestamppb.Now(), Origin: OriginSystem})
	}
}

// readerCache remembers who may read each channel so fan-out does not ask the authorization store per event
type readerCache struct {
	authz Authz
	ttl   time.Duration
	mu    sync.Mutex
	known map[string]readerEntry
}

type readerEntry struct {
	ids      []string
	everyone bool
	at       time.Time
}

func newReaderCache(az Authz, ttl time.Duration) *readerCache {
	return &readerCache{authz: az, ttl: ttl, known: map[string]readerEntry{}}
}

// readers returns the user ids that may read the channel, expanding the wildcard through members
func (c *readerCache) readers(ctx context.Context, channelID string, members func() ([]string, error)) ([]string, error) {
	c.mu.Lock()
	e, ok := c.known[channelID]
	c.mu.Unlock()
	if !ok || time.Since(e.at) > c.ttl {
		ids, everyone, err := c.authz.ListUsers(ctx, "channel:"+channelID, "reader")
		if err != nil {
			return nil, err
		}
		e = readerEntry{ids: ids, everyone: everyone, at: time.Now()}
		c.mu.Lock()
		c.known[channelID] = e
		c.mu.Unlock()
	}
	if !e.everyone {
		return e.ids, nil
	}
	all, err := members()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(all)+len(e.ids))
	out := make([]string, 0, len(all)+len(e.ids))
	for _, id := range append(all, e.ids...) {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

func (c *readerCache) invalidate(channelID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.known, channelID)
}

// invalidateSpace drops every cached channel, membership changes affect channels the cache cannot map to spaces
func (c *readerCache) invalidateSpace(string) {
	c.invalidateAll()
}

// invalidateAll forgets every cached audience after any tuple change
func (c *readerCache) invalidateAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.known = map[string]readerEntry{}
}
