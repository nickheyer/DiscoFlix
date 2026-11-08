package timeline

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	connect "connectrpc.com/connect/v2"
	"google.golang.org/protobuf/proto"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/space"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1/timelinev1connect"
)

// Handler serves TimelineService over Connect
type Handler struct {
	timelinev1connect.UnimplementedTimelineServiceHandler
	svc   *Service
	check capability.CheckFunc
	cards *extension.Registry
}

// NewHandler wires the service, the relationship check used for stream filtering, and the card schemas
func NewHandler(svc *Service, check capability.CheckFunc, cards *extension.Registry) *Handler {
	return &Handler{svc: svc, check: check, cards: cards}
}

func principal(ctx context.Context) (capability.Principal, error) {
	p, ok := capability.PrincipalFrom(ctx)
	if !ok {
		return p, connect.NewError(connect.CodeUnauthenticated, "sign in to continue")
	}
	return p, nil
}

func mapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound):
		return connect.NewError(connect.CodeNotFound, "not found")
	case errors.Is(err, ErrChannelGone):
		return connect.NewError(connect.CodeFailedPrecondition, "this channel was deleted")
	case errors.Is(err, ErrNoThreads):
		return connect.NewError(connect.CodeFailedPrecondition, "threads in mirrored channels are created on Discord, which is disconnected")
	case errors.Is(err, ErrTooLong):
		return connect.NewError(connect.CodeInvalidArgument, err.Error())
	}
	return err
}

func (h *Handler) ListSpaces(ctx context.Context, _ *timelinev1.ListSpacesRequest) (*timelinev1.ListSpacesResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	spaces, err := h.svc.ListSpaces(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	return &timelinev1.ListSpacesResponse{Spaces: spaces}, nil
}

func (h *Handler) ListChannels(ctx context.Context, req *timelinev1.ListChannelsRequest) (*timelinev1.ListChannelsResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	chans, err := h.svc.ListChannels(ctx, p.UserID, req.GetSpaceId())
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.ListChannelsResponse{Channels: chans}, nil
}

func (h *Handler) ListMembers(ctx context.Context, req *timelinev1.ListMembersRequest) (*timelinev1.ListMembersResponse, error) {
	members, roles, err := h.svc.ListMembers(ctx, req.GetSpaceId())
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.ListMembersResponse{Members: members, Roles: roles}, nil
}

func (h *Handler) ListMessages(ctx context.Context, req *timelinev1.ListMessagesRequest) (*timelinev1.ListMessagesResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	msgs, more, err := h.svc.ListMessages(ctx, p.UserID, req.GetChannelId(), req.GetBeforeSeq(), int(req.GetLimit()))
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.ListMessagesResponse{Messages: msgs, HasMore: more}, nil
}

// contentLimit returns the content length a channel accepts
func (h *Handler) contentLimit(ctx context.Context, channelID string) (int, error) {
	ch, err := h.svc.GetChannel(ctx, channelID)
	if err != nil {
		return 0, err
	}
	sp, err := h.svc.GetSpace(ctx, ch.SpaceID)
	if err != nil {
		return 0, err
	}
	return int(MaxContentFor(sp.Kind)), nil
}

func (h *Handler) PostMessage(ctx context.Context, req *timelinev1.PostMessageRequest) (*timelinev1.PostMessageResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if req.GetCard() != nil && p.Kind == "person" && !p.SystemAdmin {
		return nil, connect.NewError(connect.CodePermissionDenied, "only administrators, bots, plugins, and agents post cards")
	}
	if card := req.GetCard(); card != nil {
		if _, ok := h.cards.CardSchema(card.GetTypeUrl()); !ok {
			return nil, connect.NewError(connect.CodeInvalidArgument, "unknown card type "+card.GetTypeUrl())
		}
	}
	if req.GetContent() == "" && req.GetCard() == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, "message needs content or a card")
	}
	limit, err := h.contentLimit(ctx, req.GetChannelId())
	if err != nil {
		return nil, mapErr(err)
	}
	if len([]rune(req.GetContent())) > limit {
		return nil, connect.NewError(connect.CodeInvalidArgument, "this channel accepts up to "+strconv.Itoa(limit)+" characters")
	}
	m, err := h.svc.Post(ctx, PostInput{ChannelID: req.GetChannelId(), AuthorID: p.UserID, Content: req.GetContent(), CardAny: req.GetCard(), ReplyTo: req.GetReplyTo(), Origin: p.Origin()})
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.PostMessageResponse{Message: m}, nil
}

func (h *Handler) EditMessage(ctx context.Context, req *timelinev1.EditMessageRequest) (*timelinev1.EditMessageResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	m, err := h.svc.GetMessage(ctx, req.GetSeq())
	if err != nil {
		return nil, mapErr(err)
	}
	if m.Origin == OriginDiscord {
		return nil, connect.NewError(connect.CodeFailedPrecondition, "messages written in Discord can only be edited in Discord")
	}
	if m.CardType != "" && req.GetContent() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, "a card message keeps at least one character of content")
	}
	limit, err := h.contentLimit(ctx, m.ChannelID)
	if err != nil {
		return nil, mapErr(err)
	}
	if len([]rune(req.GetContent())) > limit {
		return nil, connect.NewError(connect.CodeInvalidArgument, "this channel accepts up to "+strconv.Itoa(limit)+" characters")
	}
	pm, err := h.svc.Edit(ctx, req.GetSeq(), req.GetContent(), Change{Origin: p.Origin()})
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.EditMessageResponse{Message: pm}, nil
}

func (h *Handler) DeleteMessage(ctx context.Context, req *timelinev1.DeleteMessageRequest) (*timelinev1.DeleteMessageResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.Delete(ctx, req.GetSeq(), Change{Origin: p.Origin()}); err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.DeleteMessageResponse{}, nil
}

func (h *Handler) AddReaction(ctx context.Context, req *timelinev1.AddReactionRequest) (*timelinev1.AddReactionResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	m, _, err := h.svc.AddReaction(ctx, req.GetSeq(), p.UserID, req.GetEmoji(), p.Origin())
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.AddReactionResponse{Message: m}, nil
}

func (h *Handler) RemoveReaction(ctx context.Context, req *timelinev1.RemoveReactionRequest) (*timelinev1.RemoveReactionResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	m, _, err := h.svc.RemoveReaction(ctx, req.GetSeq(), p.UserID, req.GetEmoji(), p.Origin())
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.RemoveReactionResponse{Message: m}, nil
}

// InteractCard applies a card action through the interactor registered with the card's schema
func (h *Handler) InteractCard(ctx context.Context, req *timelinev1.InteractCardRequest) (*timelinev1.InteractCardResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	m, err := h.svc.GetMessage(ctx, req.GetSeq())
	if err != nil {
		return nil, mapErr(err)
	}
	if m.DeletedAt != nil || m.CardType == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, "this message has no card")
	}
	cs, ok := h.cards.CardSchema(m.CardType)
	if !ok {
		return nil, connect.NewError(connect.CodeFailedPrecondition, "unknown card type "+m.CardType)
	}
	it, ok := cs.(extension.CardInteractor)
	if !ok {
		return nil, connect.NewError(connect.CodeFailedPrecondition, "this card has no actions")
	}
	card := cs.Message()
	if err := proto.Unmarshal(m.Card, card); err != nil {
		return nil, connect.NewError(connect.CodeInternal, "card payload is unreadable: "+err.Error())
	}
	next, err := it.Interact(ctx, extension.Interaction{Principal: p, Seq: m.ID, SpaceID: m.SpaceID, ChannelID: m.ChannelID, Card: card, Action: req.GetAction(), Value: req.GetValue()})
	if err != nil {
		return nil, err
	}
	pm, err := h.svc.UpdateCard(ctx, m.ID, next, p.Origin())
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.InteractCardResponse{Message: pm}, nil
}

func (h *Handler) CreateThread(ctx context.Context, req *timelinev1.CreateThreadRequest) (*timelinev1.CreateThreadResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	c, err := h.svc.CreateThread(ctx, req.GetChannelId(), req.GetName(), req.GetFromSeq())
	if err != nil {
		return nil, mapErr(err)
	}
	chans, err := h.svc.ListChannels(ctx, p.UserID, c.SpaceID)
	if err != nil {
		return nil, mapErr(err)
	}
	for _, ch := range chans {
		if ch.GetId() == c.ID {
			return &timelinev1.CreateThreadResponse{Channel: ch}, nil
		}
	}
	sp, err := h.svc.GetSpace(ctx, c.SpaceID)
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.CreateThreadResponse{Channel: channelProto(c, 0, 0, MaxContentFor(sp.Kind))}, nil
}

func (h *Handler) SendTyping(ctx context.Context, req *timelinev1.SendTypingRequest) (*timelinev1.SendTypingResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.Typing(ctx, req.GetChannelId(), p.UserID, p.DisplayName, p.Origin()); err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.SendTypingResponse{}, nil
}

func (h *Handler) MarkRead(ctx context.Context, req *timelinev1.MarkReadRequest) (*timelinev1.MarkReadResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	ch, err := h.svc.MarkRead(ctx, p.UserID, req.GetChannelId(), req.GetSeq())
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.MarkReadResponse{Channel: ch}, nil
}

const catchUpPage = 200

// WatchEvents replays events after the cursor, then streams live ones the caller may read
func (h *Handler) WatchEvents(ctx context.Context, req *timelinev1.WatchEventsRequest, stream timelinev1connect.TimelineServiceWatchEventsServerStream) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	readable := newReadCache(h.check, p, 5*time.Minute)
	sub := h.svc.Subscribe()
	defer sub.Close()
	cursor := req.GetAfterSeq()
	for cursor > 0 {
		events, err := h.svc.EventsAfter(ctx, cursor, req.GetSpaceId(), catchUpPage)
		if err != nil {
			return err
		}
		for _, ev := range events {
			cursor = ev.GetSeq()
			ok, err := readable.allowed(ctx, ev)
			if err != nil {
				return err
			}
			if ok {
				if err := stream.Send(&timelinev1.WatchEventsResponse{Event: ev}); err != nil {
					return err
				}
			}
		}
		if len(events) < catchUpPage {
			break
		}
	}
	if err := stream.SendHeaders(); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, open := <-sub.C:
			if !open {
				if sub.Lagged() {
					return connect.NewError(connect.CodeUnavailable, "event stream lagged, resume with after_seq")
				}
				return nil
			}
			if req.GetSpaceId() != "" && ev.GetSpaceId() != req.GetSpaceId() {
				continue
			}
			if ev.GetKind() == timelinev1.EventKind_EVENT_KIND_MESSAGE_CREATED && ev.GetSeq() <= cursor {
				continue
			}
			ok, err := readable.allowed(ctx, ev)
			if err != nil {
				return err
			}
			if !ok {
				continue
			}
			if err := stream.Send(&timelinev1.WatchEventsResponse{Event: ev}); err != nil {
				return err
			}
		}
	}
}

// ResolveMessage authorizes message objects, readers of the channel for reader scopes and the author or a channel admin otherwise
func (h *Handler) ResolveMessage(ctx context.Context, p capability.Principal, e *capability.Entry, id string) (bool, error) {
	seq, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return false, nil //nolint:nilerr // a malformed id names nothing the caller may touch
	}
	m, err := h.svc.GetMessage(ctx, seq)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if e.Scope == "reader" {
		return h.check(ctx, p.Subject(), "reader", "channel:"+m.ChannelID)
	}
	author := m.AuthorID
	if m.Edges.Author != nil && m.Edges.Author.MergedIntoID != "" {
		author = m.Edges.Author.MergedIntoID
	}
	if author == p.UserID {
		return true, nil
	}
	return h.check(ctx, p.Subject(), "admin", "channel:"+m.ChannelID)
}

// SpaceKindOf reports the kind of the space a channel belongs to
func (h *Handler) SpaceKindOf(ctx context.Context, channelID string) (space.Kind, error) {
	ch, err := h.svc.GetChannel(ctx, channelID)
	if err != nil {
		return "", err
	}
	sp, err := h.svc.GetSpace(ctx, ch.SpaceID)
	if err != nil {
		return "", err
	}
	return sp.Kind, nil
}

// readCache memoizes visibility checks per channel and space for one stream
type readCache struct {
	check capability.CheckFunc
	p     capability.Principal
	ttl   time.Duration
	mu    sync.Mutex
	known map[string]cached
}

type cached struct {
	ok bool
	at time.Time
}

func newReadCache(check capability.CheckFunc, p capability.Principal, ttl time.Duration) *readCache {
	return &readCache{check: check, p: p, ttl: ttl, known: map[string]cached{}}
}

// allowed reports whether the principal may see an event, by channel reader or by space member for space-level events
func (c *readCache) allowed(ctx context.Context, ev *timelinev1.Event) (bool, error) {
	relation, object := "reader", "channel:"+ev.GetChannelId()
	if ev.GetChannelId() == "" {
		if ev.GetSpaceId() == "" {
			return true, nil
		}
		relation, object = "member", "space:"+ev.GetSpaceId()
	}
	c.mu.Lock()
	v, ok := c.known[object]
	c.mu.Unlock()
	if ok && time.Since(v.at) < c.ttl {
		return v.ok, nil
	}
	allowed, err := c.check(ctx, c.p.Subject(), relation, object)
	if err != nil {
		return false, err
	}
	c.mu.Lock()
	c.known[object] = cached{ok: allowed, at: time.Now()}
	c.mu.Unlock()
	return allowed, nil
}
