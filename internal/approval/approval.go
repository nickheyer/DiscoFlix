// Package approval turns destructive capability calls made by automation into cards a space administrator decides
package approval

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	connect "connectrpc.com/connect/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/pendingaction"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

// Service stores pending actions, posts their cards, and runs them once approved
type Service struct {
	ent     *ent.Client
	tl      *timeline.Service
	invoker *capability.Invoker
	check   capability.CheckFunc
	log     *slog.Logger
}

// New wires the approval flow to the store, the timeline, and the capability invoker
func New(entc *ent.Client, tl *timeline.Service, invoker *capability.Invoker, check capability.CheckFunc, log *slog.Logger) *Service {
	return &Service{ent: entc, tl: tl, invoker: invoker, check: check, log: log}
}

// Card returns the Approval card schema with its interactor, for the extension registry
func (s *Service) Card() extension.CardInteractor { return &card{svc: s} }

// Request stores the call and posts an Approval card to the approvals channel of the object's space
func (s *Service) Request(ctx context.Context, p capability.Principal, e *capability.Entry, input proto.Message) (int64, error) {
	spaceID := ""
	if e.Object != nil {
		id, err := capability.ObjectID(input, e.Object.GetField())
		if err != nil {
			return 0, err
		}
		if spaceID, err = s.tl.SpaceOf(ctx, e.Object.GetType(), id); err != nil && !errors.Is(err, timeline.ErrNotFound) {
			return 0, err
		}
	}
	channelID, err := s.tl.ApprovalsChannel(ctx, spaceID)
	if err != nil {
		return 0, err
	}
	raw, err := proto.Marshal(input)
	if err != nil {
		return 0, err
	}
	row, err := s.ent.PendingAction.Create().
		SetProcedure(e.Procedure).
		SetInput(raw).
		SetPrincipalUserID(p.UserID).
		SetPrincipalKind(p.Kind).
		SetPrincipalVia(p.Via).
		Save(ctx)
	if err != nil {
		return 0, err
	}
	inputJSON, err := protojson.MarshalOptions{Multiline: true, Indent: "  "}.Marshal(input)
	if err != nil {
		return 0, err
	}
	title := e.Title
	if title == "" {
		title = e.Method
	}
	c := &cardv1.Approval{
		ActionId:        row.ID,
		Title:           title + " needs approval",
		Body:            fmt.Sprintf("%s (%s) asked to run %s. A space administrator decides whether it runs.", p.DisplayName, p.Kind, strings.ToLower(title)),
		Procedure:       e.Procedure,
		InputJson:       string(inputJSON),
		RequestedBy:     p.UserID,
		RequestedByName: p.DisplayName,
		RequestedVia:    p.Via,
		State:           cardv1.ApprovalState_APPROVAL_STATE_PENDING,
	}
	m, err := s.tl.Post(ctx, timeline.PostInput{ChannelID: channelID, AuthorID: s.tl.SystemBotID(), Kind: message.KindCard, Content: "Approval requested by " + p.DisplayName, Card: c, Origin: timeline.OriginSystem})
	if err != nil {
		return 0, err
	}
	if err := s.ent.PendingAction.UpdateOneID(row.ID).SetMessageSeq(m.GetSeq()).Exec(ctx); err != nil {
		return 0, err
	}
	return m.GetSeq(), nil
}

// decide records the decision and runs the stored call when it was approved
func (s *Service) decide(ctx context.Context, in extension.Interaction, c *cardv1.Approval) (*cardv1.Approval, error) {
	if c.GetState() != cardv1.ApprovalState_APPROVAL_STATE_PENDING {
		return nil, connect.NewError(connect.CodeFailedPrecondition, "this approval was already decided")
	}
	if in.Principal.Automation() {
		return nil, connect.NewError(connect.CodePermissionDenied, "approvals are decided by people, not by bots, plugins, or agents")
	}
	allowed, err := s.check(ctx, in.Principal.Subject(), "admin", "channel:"+in.ChannelID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, connect.NewError(connect.CodePermissionDenied, "only administrators of this space decide approvals")
	}
	row, err := s.ent.PendingAction.Get(ctx, c.GetActionId())
	if ent.IsNotFound(err) {
		return nil, connect.NewError(connect.CodeNotFound, "the pending action behind this card is gone")
	}
	if err != nil {
		return nil, err
	}
	if row.State != pendingaction.StatePending {
		return nil, connect.NewError(connect.CodeFailedPrecondition, "this action was already "+string(row.State))
	}
	now := time.Now()
	next := proto.Clone(c).(*cardv1.Approval)
	next.DecidedBy = in.Principal.UserID
	next.DecidedByName = in.Principal.DisplayName
	next.DecidedAt = timestamppb.New(now)
	if in.Action == "deny" {
		next.State = cardv1.ApprovalState_APPROVAL_STATE_DENIED
		return next, s.ent.PendingAction.UpdateOneID(row.ID).SetState(pendingaction.StateDenied).SetDecidedBy(in.Principal.UserID).SetDecidedAt(now).Exec(ctx)
	}
	if err := s.ent.PendingAction.UpdateOneID(row.ID).SetState(pendingaction.StateApproved).SetDecidedBy(in.Principal.UserID).SetDecidedAt(now).Exec(ctx); err != nil {
		return nil, err
	}
	next.State = cardv1.ApprovalState_APPROVAL_STATE_APPROVED
	input, _, err := s.invoker.NewInput(row.Procedure)
	if err != nil {
		return s.fail(ctx, row, next, err)
	}
	if err := proto.Unmarshal(row.Input, input); err != nil {
		return s.fail(ctx, row, next, err)
	}
	requester, err := s.ent.User.Get(ctx, row.PrincipalUserID)
	if err != nil {
		return s.fail(ctx, row, next, err)
	}
	p := capability.Principal{UserID: requester.ID, DisplayName: requester.DisplayName, Kind: string(requester.Kind), Via: "approval", SystemAdmin: requester.SystemAdmin}
	out, err := s.invoker.InvokeApproved(ctx, p, row.Procedure, input)
	if err != nil {
		return s.fail(ctx, row, next, err)
	}
	result, err := protojson.MarshalOptions{Multiline: true, Indent: "  "}.Marshal(out)
	if err != nil {
		return s.fail(ctx, row, next, err)
	}
	text := string(result)
	if text == "{}" {
		text = "Done"
	}
	next.State = cardv1.ApprovalState_APPROVAL_STATE_EXECUTED
	next.Result = truncate(text, 2000)
	return next, s.ent.PendingAction.UpdateOneID(row.ID).SetState(pendingaction.StateExecuted).SetResult(next.GetResult()).Exec(ctx)
}

func (s *Service) fail(ctx context.Context, row *ent.PendingAction, next *cardv1.Approval, cause error) (*cardv1.Approval, error) {
	next.State = cardv1.ApprovalState_APPROVAL_STATE_FAILED
	next.Result = truncate(cause.Error(), 2000)
	s.log.Warn("approved action failed", "procedure", row.Procedure, "error", cause)
	return next, s.ent.PendingAction.UpdateOneID(row.ID).SetState(pendingaction.StateFailed).SetResult(next.GetResult()).Exec(ctx)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// card is the Approval schema registered with the extension registry
type card struct {
	svc *Service
}

func (card) Describe() extension.Descriptor {
	return extension.Descriptor{ID: "discoflix.card.approval", Name: "Approval", Version: "1", Kind: extension.KindCardSchema, Origin: "builtin"}
}

func (card) TypeURL() string {
	return extension.TypeURLOf((&cardv1.Approval{}).ProtoReflect().Descriptor())
}

func (card) Message() proto.Message { return &cardv1.Approval{} }

// Actions offers approve and deny while the card is pending
func (card) Actions(m proto.Message) []extension.Action {
	c, ok := m.(*cardv1.Approval)
	if !ok || c.GetState() != cardv1.ApprovalState_APPROVAL_STATE_PENDING {
		return nil
	}
	return []extension.Action{{ID: "approve", Label: "Approve", Style: "success"}, {ID: "deny", Label: "Deny", Style: "danger"}}
}

func (k *card) Interact(ctx context.Context, in extension.Interaction) (proto.Message, error) {
	c, ok := in.Card.(*cardv1.Approval)
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, "not an approval card")
	}
	if in.Action != "approve" && in.Action != "deny" {
		return nil, connect.NewError(connect.CodeInvalidArgument, "unknown action "+in.Action)
	}
	return k.svc.decide(ctx, in, c)
}
