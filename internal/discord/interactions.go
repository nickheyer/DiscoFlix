package discord

import (
	"context"
	"strconv"
	"strings"

	dg "github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/events"
	"github.com/disgoorg/disgo/rest"

	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

const interactProcedure = "/discoflix.timeline.v1.TimelineService/InteractCard"

// onComponent routes a card button press through InteractCard as the Discord user
func (s *Service) onComponent(ctx context.Context, e *events.ComponentInteractionCreate) {
	parts := strings.SplitN(e.Data.CustomID(), ":", 3)
	if len(parts) != 3 || parts[0] != "card" {
		_ = e.CreateMessage(dg.MessageCreate{Content: "This button belongs to nothing the server knows.", Flags: dg.MessageFlagEphemeral})
		return
	}
	seq, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		_ = e.CreateMessage(dg.MessageCreate{Content: "This button names an unknown card.", Flags: dg.MessageFlagEphemeral})
		return
	}
	if err := e.DeferUpdateMessage(); err != nil {
		s.Log.Warn("defer component", "error", err)
		return
	}
	value := ""
	if sel, ok := e.Data.(dg.StringSelectMenuInteractionData); ok && len(sel.Values) > 0 {
		value = sel.Values[0]
	}
	p, err := s.principalFor(ctx, e.User())
	if err != nil {
		s.followUp(ctx, e, "Could not resolve your DiscoFlix account: "+err.Error())
		return
	}
	req := &timelinev1.InteractCardRequest{Seq: seq, Action: parts[2], Value: value}
	if _, err := s.Invoker.Invoke(ctx, p, interactProcedure, req); err != nil {
		s.followUp(ctx, e, "⚠️ "+errorText(err))
		return
	}
	s.kick()
}

// followUp sends a private note after a deferred component response
func (s *Service) followUp(ctx context.Context, e *events.ComponentInteractionCreate, text string) {
	client, err := s.Client()
	if err != nil {
		return
	}
	if _, err := client.Rest.CreateFollowupMessage(e.ApplicationID(), e.Token(), dg.MessageCreate{Content: text, Flags: dg.MessageFlagEphemeral}, rest.WithCtx(ctx)); err != nil {
		s.Log.Warn("component follow-up", "error", err)
	}
}
