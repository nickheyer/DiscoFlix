package discord

import (
	"context"
	"errors"
	"time"

	connect "connectrpc.com/connect/v2"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/timeline"
	discordv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/discord/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/discord/v1/discordv1connect"
)

// Handler serves DiscordService over Connect
type Handler struct {
	discordv1connect.UnimplementedDiscordServiceHandler
	svc *Service
}

// NewHandler wraps the mirror service
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

func mapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotConfigured):
		return connect.NewError(connect.CodeFailedPrecondition, "configure a bot token first")
	case errors.Is(err, ErrBadToken):
		return connect.NewError(connect.CodeInvalidArgument, err.Error())
	case errors.Is(err, ErrDisconnected):
		return connect.NewError(connect.CodeUnavailable, "the Discord gateway is not connected")
	case errors.Is(err, timeline.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, "not found")
	}
	return err
}

func (h *Handler) GetDiscordStatus(ctx context.Context, _ *discordv1.GetDiscordStatusRequest) (*discordv1.GetDiscordStatusResponse, error) {
	return &discordv1.GetDiscordStatusResponse{Status: h.svc.Status(ctx)}, nil
}

func (h *Handler) ConfigureDiscord(ctx context.Context, req *discordv1.ConfigureDiscordRequest) (*discordv1.ConfigureDiscordResponse, error) {
	if err := h.svc.Configure(ctx, req.GetBotToken(), req.GetClientSecret()); err != nil {
		return nil, mapErr(err)
	}
	return &discordv1.ConfigureDiscordResponse{Status: h.svc.Status(ctx)}, nil
}

func (h *Handler) DisconnectDiscord(ctx context.Context, _ *discordv1.DisconnectDiscordRequest) (*discordv1.DisconnectDiscordResponse, error) {
	if err := h.svc.Forget(ctx); err != nil {
		return nil, mapErr(err)
	}
	return &discordv1.DisconnectDiscordResponse{}, nil
}

func (h *Handler) SetApprovalsChannel(ctx context.Context, req *discordv1.SetApprovalsChannelRequest) (*discordv1.SetApprovalsChannelResponse, error) {
	if err := h.svc.Timeline.SetApprovalsChannel(ctx, req.GetSpaceId(), req.GetChannelId()); err != nil {
		return nil, mapErr(err)
	}
	return &discordv1.SetApprovalsChannelResponse{}, nil
}

func stamp(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}
