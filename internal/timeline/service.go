package timeline

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/membership"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/readstate"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	_ "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

// Flusher applies staged authorization tuples after a transaction commits
type Flusher interface {
	Flush(ctx context.Context) error
}

// SystemChannels are created in the system space in this order
var SystemChannels = []string{"general", "requests", "queue", "imports", "transcodes", "audit"}

// SystemBotName is the display name of the user that authors system messages
const SystemBotName = "DiscoFlix"

// ErrNotFound reports a missing space, channel, or message
var ErrNotFound = errors.New("timeline: not found")

// Service owns the timeline tables, the system space, and event fan-out
type Service struct {
	ent   *ent.Client
	authz Flusher
	pub   Publisher
	bus   *bus
	log   *slog.Logger

	systemSpaceID string
	systemBotID   string
	channelIDs    map[string]string
}

// New wires the service to its store, authorization flusher, and realtime publisher
func New(entc *ent.Client, flusher Flusher, pub Publisher, log *slog.Logger) *Service {
	return &Service{ent: entc, authz: flusher, pub: pub, bus: newBus(), log: log, channelIDs: map[string]string{}}
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
		s.channelIDs[name] = ch.ID
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.systemSpaceID = sp.ID
	s.systemBotID = bot.ID
	return s.authz.Flush(ctx)
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
	return s.ent.Space.UpdateOneID(s.systemSpaceID).SetName(name).Exec(ctx)
}

// Join adds a user to a space with roles and stages the matching tuples, inside the caller's transaction
func Join(ctx context.Context, tx *ent.Tx, userID, spaceID string, roles ...string) error {
	_, err := tx.Membership.Create().SetUserID(userID).SetSpaceID(spaceID).SetRoles(roles).Save(ctx)
	if err != nil {
		return fmt.Errorf("timeline: join: %w", err)
	}
	ops := []authz.Op{authz.Write("space:"+spaceID, "member", "user:"+userID)}
	for _, r := range roles {
		if r == "admin" {
			ops = append(ops, authz.Write("space:"+spaceID, "admin", "user:"+userID))
		}
	}
	return authz.Stage(ctx, tx, ops...)
}

// PostInput describes a message to append
type PostInput struct {
	ChannelID string
	AuthorID  string
	Kind      message.Kind
	Content   string
	Card      proto.Message
	CardAny   *anypb.Any
	ReplyTo   int64
	External  string
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
	create := tx.Message.Create().
		SetSpaceID(ch.SpaceID).
		SetChannelID(ch.ID).
		SetAuthorID(in.AuthorID).
		SetKind(kind).
		SetContent(in.Content).
		SetReplyTo(in.ReplyTo).
		SetExternalID(in.External)
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
	if m.Edges.Author, err = tx.User.Get(ctx, in.AuthorID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	pm := messageProto(m)
	s.emit(&timelinev1.Event{Seq: m.ID, Kind: timelinev1.EventKind_EVENT_KIND_MESSAGE_CREATED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now()})
	return pm, nil
}

// PostSystem appends a system card authored by the bot to a named system channel
func (s *Service) PostSystem(ctx context.Context, channelName, content string, card proto.Message) (*timelinev1.Message, error) {
	id, ok := s.channelIDs[channelName]
	if !ok {
		return nil, fmt.Errorf("timeline: no system channel %q", channelName)
	}
	return s.Post(ctx, PostInput{ChannelID: id, AuthorID: s.systemBotID, Kind: message.KindSystem, Content: content, Card: card})
}

// Edit replaces the content of a message and emits the edit
func (s *Service) Edit(ctx context.Context, seq int64, content string) (*timelinev1.Message, error) {
	m, err := s.ent.Message.Query().Where(message.ID(seq), message.DeletedAtIsNil()).WithAuthor().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if err := s.ent.Message.UpdateOneID(seq).SetContent(content).SetEditedAt(now).Exec(ctx); err != nil {
		return nil, err
	}
	m.Content, m.EditedAt = content, &now
	pm := messageProto(m)
	s.emit(&timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_MESSAGE_EDITED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now()})
	return pm, nil
}

// UpdateCard replaces the card payload of a message in place and emits the update
func (s *Service) UpdateCard(ctx context.Context, seq int64, card proto.Message) (*timelinev1.Message, error) {
	packed, err := anypb.New(card)
	if err != nil {
		return nil, err
	}
	m, err := s.ent.Message.Query().Where(message.ID(seq), message.DeletedAtIsNil()).WithAuthor().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := s.ent.Message.UpdateOneID(seq).SetCardType(packed.GetTypeUrl()).SetCard(packed.GetValue()).Exec(ctx); err != nil {
		return nil, err
	}
	m.CardType, m.Card = packed.GetTypeUrl(), packed.GetValue()
	pm := messageProto(m)
	s.emit(&timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_CARD_UPDATED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now()})
	return pm, nil
}

// Delete tombstones a message and emits the deletion
func (s *Service) Delete(ctx context.Context, seq int64) error {
	m, err := s.ent.Message.Query().Where(message.ID(seq), message.DeletedAtIsNil()).WithAuthor().Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	now := time.Now()
	if err := s.ent.Message.UpdateOneID(seq).SetDeletedAt(now).SetContent("").ClearCard().SetCardType("").Exec(ctx); err != nil {
		return err
	}
	m.DeletedAt = &now
	pm := messageProto(m)
	s.emit(&timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_MESSAGE_DELETED, Message: pm, ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.Now()})
	return nil
}

// GetMessage loads one message with its author
func (s *Service) GetMessage(ctx context.Context, seq int64) (*ent.Message, error) {
	m, err := s.ent.Message.Query().Where(message.ID(seq)).WithAuthor().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return m, err
}

// ListMessages returns up to limit messages before seq, newest first, plus whether older ones exist
func (s *Service) ListMessages(ctx context.Context, channelID string, beforeSeq int64, limit int) ([]*timelinev1.Message, bool, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := s.ent.Message.Query().Where(message.ChannelID(channelID))
	if beforeSeq > 0 {
		q = q.Where(message.IDLT(beforeSeq))
	}
	rows, err := q.Order(ent.Desc(message.FieldID)).Limit(limit + 1).WithAuthor().All(ctx)
	if err != nil {
		return nil, false, err
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	out := make([]*timelinev1.Message, len(rows))
	for i, m := range rows {
		out[i] = messageProto(m)
	}
	return out, more, nil
}

// ListSpaces returns the spaces the user belongs to with unread counts
func (s *Service) ListSpaces(ctx context.Context, userID string) ([]*timelinev1.Space, error) {
	spaces, err := s.ent.Space.Query().
		Where(space.HasMembershipsWith(membership.UserID(userID))).
		Order(ent.Asc(space.FieldPosition), ent.Asc(space.FieldCreatedAt)).
		All(ctx)
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

// ListChannels returns the channels of a space with the user's read cursor and unread count
func (s *Service) ListChannels(ctx context.Context, userID, spaceID string) ([]*timelinev1.Channel, error) {
	chans, err := s.ent.Channel.Query().
		Where(channel.SpaceID(spaceID)).
		Order(ent.Asc(channel.FieldPosition), ent.Asc(channel.FieldCreatedAt)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	states, err := s.ent.ReadState.Query().Where(readstate.UserID(userID), readstate.HasChannelWith(channel.SpaceID(spaceID))).All(ctx)
	if err != nil {
		return nil, err
	}
	lastRead := map[string]int64{}
	for _, rs := range states {
		lastRead[rs.ChannelID] = rs.LastReadSeq
	}
	out := make([]*timelinev1.Channel, 0, len(chans))
	for _, c := range chans {
		unread, err := s.ent.Message.Query().Where(message.ChannelID(c.ID), message.IDGT(lastRead[c.ID]), message.DeletedAtIsNil()).Count(ctx)
		if err != nil {
			return nil, err
		}
		out = append(out, channelProto(c, lastRead[c.ID], int64(unread)))
	}
	return out, nil
}

// GetChannel loads one channel
func (s *Service) GetChannel(ctx context.Context, channelID string) (*ent.Channel, error) {
	c, err := s.ent.Channel.Get(ctx, channelID)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return c, err
}

// MarkRead advances the user's cursor on a channel and emits a read event to that user
func (s *Service) MarkRead(ctx context.Context, userID, channelID string, seq int64) (*timelinev1.Channel, error) {
	ch, err := s.GetChannel(ctx, channelID)
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
	out := channelProto(ch, seq, int64(unread))
	ev := &timelinev1.Event{Seq: seq, Kind: timelinev1.EventKind_EVENT_KIND_CHANNEL_READ, ChannelId: channelID, SpaceId: ch.SpaceID, At: timestamppb.Now()}
	if data, err := protojson.Marshal(ev); err == nil {
		if err := s.pub.Publish(UserChannel(userID), data); err != nil {
			s.log.Warn("publish read event", "error", err)
		}
	}
	return out, nil
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
	rows, err := q.Order(ent.Asc(message.FieldID)).Limit(limit).WithAuthor().All(ctx)
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
		out = append(out, &timelinev1.Event{Seq: m.ID, Kind: kind, Message: messageProto(m), ChannelId: m.ChannelID, SpaceId: m.SpaceID, At: timestamppb.New(m.CreatedAt)})
	}
	return out, nil
}

// ChannelName is the realtime channel carrying one timeline channel's events
func ChannelName(spaceID, channelID string) string {
	return "space:" + spaceID + ":channel:" + channelID
}

// UserChannel is the realtime channel carrying one user's private events
func UserChannel(userID string) string {
	return "user:" + userID
}

// emit publishes an event to the channel stream, to every member's user stream, and to in-process subscribers
func (s *Service) emit(ev *timelinev1.Event) {
	data, err := protojson.Marshal(ev)
	if err != nil {
		s.log.Error("encode event", "seq", ev.GetSeq(), "error", err)
		return
	}
	if err := s.pub.Publish(ChannelName(ev.GetSpaceId(), ev.GetChannelId()), data); err != nil {
		s.log.Warn("publish event", "seq", ev.GetSeq(), "error", err)
	}
	members, err := s.ent.Membership.Query().Where(membership.SpaceID(ev.GetSpaceId())).Select(membership.FieldUserID).Strings(context.Background())
	if err != nil {
		s.log.Error("list members for event", "space", ev.GetSpaceId(), "error", err)
	}
	for _, uid := range members {
		if err := s.pub.Publish(UserChannel(uid), data); err != nil {
			s.log.Warn("publish user event", "seq", ev.GetSeq(), "user", uid, "error", err)
		}
	}
	s.bus.publish(ev)
}
