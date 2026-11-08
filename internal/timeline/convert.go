package timeline

import (
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

var spaceKinds = map[space.Kind]timelinev1.SpaceKind{
	space.KindSystem:   timelinev1.SpaceKind_SPACE_KIND_SYSTEM,
	space.KindGuild:    timelinev1.SpaceKind_SPACE_KIND_GUILD,
	space.KindLibrary:  timelinev1.SpaceKind_SPACE_KIND_LIBRARY,
	space.KindPlugin:   timelinev1.SpaceKind_SPACE_KIND_PLUGIN,
	space.KindProvider: timelinev1.SpaceKind_SPACE_KIND_PROVIDER,
	space.KindServer:   timelinev1.SpaceKind_SPACE_KIND_SERVER,
}

var channelKinds = map[channel.Kind]timelinev1.ChannelKind{
	channel.KindText:     timelinev1.ChannelKind_CHANNEL_KIND_TEXT,
	channel.KindCategory: timelinev1.ChannelKind_CHANNEL_KIND_CATEGORY,
	channel.KindVoice:    timelinev1.ChannelKind_CHANNEL_KIND_VOICE,
	channel.KindThread:   timelinev1.ChannelKind_CHANNEL_KIND_THREAD,
}

var messageKinds = map[message.Kind]timelinev1.MessageKind{
	message.KindUser:   timelinev1.MessageKind_MESSAGE_KIND_USER,
	message.KindSystem: timelinev1.MessageKind_MESSAGE_KIND_SYSTEM,
	message.KindCard:   timelinev1.MessageKind_MESSAGE_KIND_CARD,
}

func spaceProto(s *ent.Space, unread int64) *timelinev1.Space {
	return &timelinev1.Space{
		Id:         s.ID,
		Kind:       spaceKinds[s.Kind],
		Name:       s.Name,
		IconUrl:    s.IconURL,
		ExternalId: s.ExternalID,
		Position:   s.Position,
		CreatedAt:  timestamppb.New(s.CreatedAt),
		Unread:     unread,
	}
}

func channelProto(c *ent.Channel, lastRead, unread int64) *timelinev1.Channel {
	return &timelinev1.Channel{
		Id:          c.ID,
		SpaceId:     c.SpaceID,
		Kind:        channelKinds[c.Kind],
		Name:        c.Name,
		Topic:       c.Topic,
		ParentId:    c.ParentID,
		Position:    c.Position,
		ExternalId:  c.ExternalID,
		LastSeq:     c.LastSeq,
		LastReadSeq: lastRead,
		Unread:      unread,
	}
}

func authorProto(u *ent.User) *timelinev1.Author {
	if u == nil {
		return nil
	}
	return &timelinev1.Author{
		Id:          u.ID,
		DisplayName: u.DisplayName,
		AvatarUrl:   u.AvatarURL,
		AccentColor: u.AccentColor,
		Kind:        string(u.Kind),
	}
}

// messageProto renders a row with its eager-loaded author, keeping tombstones free of content
func messageProto(m *ent.Message) *timelinev1.Message {
	out := &timelinev1.Message{
		Seq:        m.ID,
		SpaceId:    m.SpaceID,
		ChannelId:  m.ChannelID,
		Author:     authorProto(m.Edges.Author),
		Kind:       messageKinds[m.Kind],
		ReplyTo:    m.ReplyTo,
		ExternalId: m.ExternalID,
		CreatedAt:  timestamppb.New(m.CreatedAt),
	}
	if m.EditedAt != nil {
		out.EditedAt = timestamppb.New(*m.EditedAt)
	}
	if m.DeletedAt != nil {
		out.DeletedAt = timestamppb.New(*m.DeletedAt)
		return out
	}
	out.Content = m.Content
	if m.CardType != "" {
		out.Card = &anypb.Any{TypeUrl: m.CardType, Value: m.Card}
	}
	return out
}
