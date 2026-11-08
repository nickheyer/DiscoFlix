package timeline

import (
	"fmt"

	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/schema"
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

// Longest content accepted per space kind, Discord caps webhook messages at 2000 characters
const (
	MaxContent         = 4000
	MaxMirroredContent = 2000
)

// MaxContentFor returns the content limit of channels in a space of the given kind
func MaxContentFor(kind space.Kind) int32 {
	if kind == space.KindGuild {
		return MaxMirroredContent
	}
	return MaxContent
}

func spaceProto(s *ent.Space, unread int64) *timelinev1.Space {
	return &timelinev1.Space{
		Id:                 s.ID,
		Kind:               spaceKinds[s.Kind],
		Name:               s.Name,
		IconUrl:            s.IconURL,
		ExternalId:         s.ExternalID,
		Position:           s.Position,
		CreatedAt:          timestamppb.New(s.CreatedAt),
		Unread:             unread,
		ApprovalsChannelId: s.ApprovalsChannelID,
	}
}

func channelProto(c *ent.Channel, lastRead, unread int64, maxContent int32) *timelinev1.Channel {
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
		MaxContent:  maxContent,
	}
}

// authorProto renders the user a message is attributed to, following a merge to the surviving user
func authorProto(u *ent.User) *timelinev1.Author {
	if u == nil {
		return nil
	}
	if u.Edges.MergedInto != nil {
		u = u.Edges.MergedInto
	}
	return &timelinev1.Author{
		Id:          u.ID,
		DisplayName: u.DisplayName,
		AvatarUrl:   u.AvatarURL,
		AccentColor: u.AccentColor,
		Kind:        string(u.Kind),
	}
}

func attachmentProtos(in []schema.Attachment) []*timelinev1.Attachment {
	if len(in) == 0 {
		return nil
	}
	out := make([]*timelinev1.Attachment, len(in))
	for i, a := range in {
		out[i] = &timelinev1.Attachment{Id: a.ID, Name: a.Name, Url: a.URL, ContentType: a.ContentType, Size: a.Size, Width: a.Width, Height: a.Height}
	}
	return out
}

// reactionProtos folds reaction rows into per-emoji counts in first-seen order
func reactionProtos(rows []*ent.Reaction, viewerID string) []*timelinev1.Reaction {
	if len(rows) == 0 {
		return nil
	}
	var out []*timelinev1.Reaction
	index := map[string]int{}
	for _, r := range rows {
		i, ok := index[r.Emoji]
		if !ok {
			i = len(out)
			index[r.Emoji] = i
			out = append(out, &timelinev1.Reaction{Emoji: r.Emoji})
		}
		out[i].Count++
		if viewerID != "" && r.UserID == viewerID {
			out[i].Me = true
		}
	}
	return out
}

// messageProto renders a row with its eager-loaded author and reactions, keeping tombstones free of content
func messageProto(m *ent.Message, viewerID string) *timelinev1.Message {
	out := &timelinev1.Message{
		Seq:        m.ID,
		SpaceId:    m.SpaceID,
		ChannelId:  m.ChannelID,
		Author:     authorProto(m.Edges.Author),
		Kind:       messageKinds[m.Kind],
		ReplyTo:    m.ReplyTo,
		ExternalId: m.ExternalID,
		Origin:     m.Origin,
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
	out.Attachments = attachmentProtos(m.Attachments)
	out.Reactions = reactionProtos(m.Edges.Reactions, viewerID)
	if m.CardType != "" {
		out.Card = &anypb.Any{TypeUrl: m.CardType, Value: m.Card}
	}
	return out
}

func roleProtos(in []schema.Role) []*timelinev1.Role {
	out := make([]*timelinev1.Role, 0, len(in))
	for _, r := range in {
		out = append(out, &timelinev1.Role{Id: r.ID, Name: r.Name, Color: r.Color, Position: r.Position, Hoist: r.Hoist})
	}
	return out
}

func memberProto(m *ent.Membership, externalID, status string) *timelinev1.Member {
	return &timelinev1.Member{
		User:       authorProto(m.Edges.User),
		Roles:      m.Roles,
		Nickname:   m.Nickname,
		Presence:   status,
		ExternalId: externalID,
		JoinedAt:   timestamppb.New(m.JoinedAt),
		Admin:      m.Admin,
	}
}

// ChannelName is the realtime channel carrying one timeline channel's events
func ChannelName(spaceID, channelID string) string {
	return "space:" + spaceID + ":channel:" + channelID
}

// SpaceName is the realtime channel carrying one space's presence, member, and channel changes
func SpaceName(spaceID string) string {
	return "space:" + spaceID
}

// UserChannel is the realtime channel carrying one user's private events
func UserChannel(userID string) string {
	return "user:" + userID
}

// ParseName splits a realtime channel name into its space and channel ids
func ParseName(name string) (spaceID, channelID string, ok bool) {
	var s, c string
	if n, _ := fmt.Sscanf(name, "space:%36s:channel:%36s", &s, &c); n == 2 {
		return s, c, true
	}
	if n, _ := fmt.Sscanf(name, "space:%36s", &s); n == 1 && len(name) == len("space:")+len(s) {
		return s, "", true
	}
	return "", "", false
}
