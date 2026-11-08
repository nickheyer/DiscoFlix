package timeline

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	connect "connectrpc.com/connect/v2"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/extension"
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
	if errors.Is(err, ErrNotFound) {
		return connect.NewError(connect.CodeNotFound, "not found")
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
		return nil, err
	}
	return &timelinev1.ListChannelsResponse{Channels: chans}, nil
}

func (h *Handler) ListMessages(ctx context.Context, req *timelinev1.ListMessagesRequest) (*timelinev1.ListMessagesResponse, error) {
	msgs, more, err := h.svc.ListMessages(ctx, req.GetChannelId(), req.GetBeforeSeq(), int(req.GetLimit()))
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.ListMessagesResponse{Messages: msgs, HasMore: more}, nil
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
	m, err := h.svc.Post(ctx, PostInput{ChannelID: req.GetChannelId(), AuthorID: p.UserID, Content: req.GetContent(), CardAny: req.GetCard(), ReplyTo: req.GetReplyTo()})
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.PostMessageResponse{Message: m}, nil
}

func (h *Handler) EditMessage(ctx context.Context, req *timelinev1.EditMessageRequest) (*timelinev1.EditMessageResponse, error) {
	m, err := h.svc.Edit(ctx, req.GetSeq(), req.GetContent())
	if err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.EditMessageResponse{Message: m}, nil
}

func (h *Handler) DeleteMessage(ctx context.Context, req *timelinev1.DeleteMessageRequest) (*timelinev1.DeleteMessageResponse, error) {
	if err := h.svc.Delete(ctx, req.GetSeq()); err != nil {
		return nil, mapErr(err)
	}
	return &timelinev1.DeleteMessageResponse{}, nil
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
			ok, err := readable.allowed(ctx, ev.GetChannelId())
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
			ok, err := readable.allowed(ctx, ev.GetChannelId())
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

// ResolveMessage authorizes edits and deletes for the author or a channel admin
func (h *Handler) ResolveMessage(ctx context.Context, p capability.Principal, _ *capability.Entry, id string) (bool, error) {
	seq, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return false, nil //nolint:nilerr // a malformed id names nothing the caller may edit
	}
	m, err := h.svc.GetMessage(ctx, seq)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if m.AuthorID == p.UserID {
		return true, nil
	}
	return h.check(ctx, p.Subject(), "admin", "channel:"+m.ChannelID)
}

// readCache memoizes reader checks per channel for one stream
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

func (c *readCache) allowed(ctx context.Context, channelID string) (bool, error) {
	c.mu.Lock()
	v, ok := c.known[channelID]
	c.mu.Unlock()
	if ok && time.Since(v.at) < c.ttl {
		return v.ok, nil
	}
	allowed, err := c.check(ctx, c.p.Subject(), "reader", "channel:"+channelID)
	if err != nil {
		return false, err
	}
	c.mu.Lock()
	c.known[channelID] = cached{ok: allowed, at: time.Now()}
	c.mu.Unlock()
	return allowed, nil
}
