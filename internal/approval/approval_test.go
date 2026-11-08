package approval_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/validate"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/nickheyer/DiscoFlix/internal/approval"
	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/identity"
	"github.com/nickheyer/DiscoFlix/internal/realtime"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/pendingaction"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1/capabilityv1connect"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	identityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1/identityv1connect"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1/timelinev1connect"
)

const (
	deleteProcedure   = "/discoflix.timeline.v1.TimelineService/DeleteMessage"
	interactProcedure = "/discoflix.timeline.v1.TimelineService/InteractCard"
	approvalTypeURL   = "type.googleapis.com/discoflix.card.v1.Approval"
)

type stack struct {
	st      *store.Store
	tl      *timeline.Service
	ids     *identity.Service
	invoker *capability.Invoker

	admin, agent, person capability.Principal
}

// Wires store, OpenFGA, timeline, identity, interceptor, invoker, and approvals the way the app does
func newStack(t *testing.T) *stack {
	t.Helper()
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	dir := t.TempDir()
	st, err := store.Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.Migrate(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	az, err := authz.Open(ctx, dir, st.Ent, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(az.Close)
	check := func(ctx context.Context, subject, relation, object string) (bool, error) {
		return az.Check(ctx, subject, relation, object, nil)
	}
	node, err := realtime.New(log, "test", func(context.Context, string, string) (bool, error) { return true, nil }, realtime.Hooks{})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.Run(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = node.Shutdown(ctx) })
	tl := timeline.New(st.Ent, az, node, log)
	if err := tl.EnsureSystem(ctx, "DiscoFlix"); err != nil {
		t.Fatal(err)
	}
	secrets, err := config.OpenSecrets(dir)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := identity.Open(ctx, dir, secrets, st.Ent, az, tl, identity.Build{Version: "test"}, false, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ids.Close() })

	reg := capability.NewRegistry()
	for _, sd := range []protoreflect.ServiceDescriptor{
		capabilityv1.File_discoflix_capability_v1_capability_proto.Services().ByName("CapabilityService"),
		timelinev1.File_discoflix_timeline_v1_timeline_proto.Services().ByName("TimelineService"),
		identityv1.File_discoflix_identity_v1_identity_proto.Services().ByName("IdentityService"),
	} {
		if err := reg.AddService(sd); err != nil {
			t.Fatal(err)
		}
	}
	exts := extension.NewRegistry()
	for _, card := range []proto.Message{&cardv1.SystemNotice{}, &cardv1.BootReport{}, &cardv1.SecurityEvent{}, &cardv1.UpdateEvent{}} {
		if err := exts.Register(extension.BuiltinCard(card)); err != nil {
			t.Fatal(err)
		}
	}
	gate := capability.NewGate(check)
	tlHandler := timeline.NewHandler(tl, check, exts)
	gate.Resolve("message", tlHandler.ResolveMessage)
	interceptor := capability.NewInterceptor(reg, ids, gate, log)
	srv := connect.NewServer(validate.NewServerInterceptor(), interceptor.Server())
	invoker := capability.NewInvoker(reg, srv)
	approvals := approval.New(st.Ent, tl, invoker, check, log)
	interceptor.SetApprover(approvals)
	if err := exts.Register(approvals.Card()); err != nil {
		t.Fatal(err)
	}
	capabilityv1connect.RegisterCapabilityServiceHandler(srv, capability.NewHandler(reg))
	timelinev1connect.RegisterTimelineServiceHandler(srv, tlHandler)
	identityv1connect.RegisterIdentityServiceHandler(srv, identity.NewHandler(ids))

	s := &stack{st: st, tl: tl, ids: ids, invoker: invoker}
	admin := s.user(t, "Nick", user.KindPerson, true, "admin")
	agent := s.user(t, "Helper", user.KindAgent, false, "admin")
	person := s.user(t, "Pat", user.KindPerson, false)
	if err := az.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	s.admin = capability.Principal{UserID: admin.ID, DisplayName: admin.DisplayName, Kind: "person", Via: "session", SystemAdmin: true}
	s.agent = capability.Principal{UserID: agent.ID, DisplayName: agent.DisplayName, Kind: "agent", Via: "apikey"}
	s.person = capability.Principal{UserID: person.ID, DisplayName: person.DisplayName, Kind: "person", Via: "session"}
	return s
}

// Creates a system member who joins the system space with the given roles
func (s *stack) user(t *testing.T, name string, kind user.Kind, systemAdmin bool, roles ...string) *ent.User {
	t.Helper()
	ctx := context.Background()
	tx, err := s.st.Ent.Tx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	u, err := tx.User.Create().SetDisplayName(name).SetKind(kind).SetSystemAdmin(systemAdmin).Save(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := timeline.Join(ctx, tx, u.ID, s.tl.SystemSpaceID(), roles...); err != nil {
		t.Fatal(err)
	}
	ops := []authz.Op{authz.Write(authz.SystemObject, "member", "user:"+u.ID)}
	if systemAdmin {
		ops = append(ops, authz.Write(authz.SystemObject, "admin", "user:"+u.ID))
	}
	if err := authz.Stage(ctx, tx, ops...); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return u
}

func (s *stack) post(t *testing.T, authorID, content string) int64 {
	t.Helper()
	m, err := s.tl.Post(context.Background(), timeline.PostInput{ChannelID: s.tl.SystemChannelID("general"), AuthorID: authorID, Content: content, Origin: timeline.OriginWeb})
	if err != nil {
		t.Fatal(err)
	}
	return m.GetSeq()
}

func (s *stack) del(p capability.Principal, seq int64) error {
	_, err := s.invoker.Invoke(context.Background(), p, deleteProcedure, &timelinev1.DeleteMessageRequest{Seq: seq})
	return err
}

func (s *stack) interact(p capability.Principal, seq int64, action string) (*timelinev1.Message, error) {
	out, err := s.invoker.Invoke(context.Background(), p, interactProcedure, &timelinev1.InteractCardRequest{Seq: seq, Action: action})
	if err != nil {
		return nil, err
	}
	return out.(*timelinev1.InteractCardResponse).GetMessage(), nil
}

func (s *stack) deleted(t *testing.T, seq int64) bool {
	t.Helper()
	m, err := s.tl.GetMessage(context.Background(), seq)
	if err != nil {
		t.Fatal(err)
	}
	return m.DeletedAt != nil
}

// Decodes the Approval payload stored on a message
func (s *stack) card(t *testing.T, seq int64) *cardv1.Approval {
	t.Helper()
	m, err := s.tl.GetMessage(context.Background(), seq)
	if err != nil {
		t.Fatal(err)
	}
	if m.CardType != approvalTypeURL {
		t.Fatalf("message %d card type = %q", seq, m.CardType)
	}
	c := &cardv1.Approval{}
	if err := proto.Unmarshal(m.Card, c); err != nil {
		t.Fatal(err)
	}
	return c
}

func (s *stack) pending(t *testing.T, cardSeq int64) *ent.PendingAction {
	t.Helper()
	row, err := s.st.Ent.PendingAction.Query().Where(pendingaction.MessageSeq(cardSeq)).Only(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func codeOf(t *testing.T, err error, want connect.Code) {
	t.Helper()
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != want {
		t.Fatalf("error = %v, want code %s", err, want)
	}
}

// Extracts the number of the message awaiting a decision from an automation refusal
func approvalSeq(t *testing.T, err error) int64 {
	t.Helper()
	codeOf(t, err, connect.CodeFailedPrecondition)
	var ce *connect.Error
	if !errors.As(err, &ce) || !strings.Contains(ce.Message(), "approval required: card") {
		t.Fatalf("refusal message = %q", ce.Message())
	}
	var seq int64
	if _, err := fmt.Sscanf(ce.Message(), "approval required: card %d", &seq); err != nil || seq == 0 {
		t.Fatalf("card seq in %q = %d, %v", ce.Message(), seq, err)
	}
	return seq
}

func decoded(t *testing.T, m *timelinev1.Message) *cardv1.Approval {
	t.Helper()
	if m.GetCard().GetTypeUrl() != approvalTypeURL {
		t.Fatalf("response card = %v", m.GetCard())
	}
	c := &cardv1.Approval{}
	if err := m.GetCard().UnmarshalTo(c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestApproveRunsTheStoredCall(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	audit := s.tl.SystemChannelID("audit")
	target := s.post(t, s.admin.UserID, "please delete me")

	seq := approvalSeq(t, s.del(s.agent, target))
	if s.deleted(t, target) {
		t.Fatal("destructive call ran before approval")
	}
	cardMsg, err := s.tl.GetMessage(ctx, seq)
	if err != nil {
		t.Fatal(err)
	}
	if cardMsg.ChannelID != audit || cardMsg.AuthorID != s.tl.SystemBotID() || cardMsg.Kind != message.KindCard || !strings.HasSuffix(cardMsg.CardType, "discoflix.card.v1.Approval") {
		t.Fatalf("approval message = %+v", cardMsg)
	}
	listed, _, err := s.tl.ListMessages(ctx, s.admin.UserID, audit, 0, 50)
	if err != nil || len(listed) == 0 || listed[0].GetSeq() != seq || !strings.HasSuffix(listed[0].GetCard().GetTypeUrl(), "discoflix.card.v1.Approval") {
		t.Fatalf("audit listing = %v, %v", listed, err)
	}
	c := s.card(t, seq)
	if c.GetState() != cardv1.ApprovalState_APPROVAL_STATE_PENDING || c.GetProcedure() != deleteProcedure || c.GetRequestedBy() != s.agent.UserID ||
		c.GetRequestedVia() != "apikey" || c.GetActionId() == "" || !strings.Contains(c.GetInputJson(), strconv.FormatInt(target, 10)) {
		t.Fatalf("pending card = %v", c)
	}
	if row := s.pending(t, seq); row.State != pendingaction.StatePending || row.PrincipalUserID != s.agent.UserID || row.PrincipalKind != "agent" || row.Procedure != deleteProcedure {
		t.Fatalf("pending row = %+v", row)
	}

	_, err = s.interact(s.agent, seq, "approve")
	codeOf(t, err, connect.CodePermissionDenied)
	_, err = s.interact(s.person, seq, "approve")
	codeOf(t, err, connect.CodePermissionDenied)
	_, err = s.interact(s.admin, seq, "maybe")
	codeOf(t, err, connect.CodeInvalidArgument)
	if s.card(t, seq).GetState() != cardv1.ApprovalState_APPROVAL_STATE_PENDING || s.deleted(t, target) {
		t.Fatal("refused interactions changed the card or ran the call")
	}

	res, err := s.interact(s.admin, seq, "approve")
	if err != nil {
		t.Fatal(err)
	}
	done := decoded(t, res)
	if done.GetState() != cardv1.ApprovalState_APPROVAL_STATE_EXECUTED || done.GetDecidedBy() != s.admin.UserID || done.GetDecidedByName() != "Nick" || done.GetDecidedAt() == nil || done.GetResult() != "Done" {
		t.Fatalf("approved card = %v", done)
	}
	if !s.deleted(t, target) {
		t.Fatal("approved delete did not run")
	}
	if stored := s.card(t, seq); stored.GetState() != cardv1.ApprovalState_APPROVAL_STATE_EXECUTED {
		t.Fatalf("stored card = %v", stored)
	}
	if row := s.pending(t, seq); row.State != pendingaction.StateExecuted || row.DecidedBy != s.admin.UserID || row.DecidedAt == nil || row.Result != "Done" {
		t.Fatalf("executed row = %+v", row)
	}
	_, err = s.interact(s.admin, seq, "approve")
	codeOf(t, err, connect.CodeFailedPrecondition)
}

func TestDenyKeepsTheMessage(t *testing.T) {
	s := newStack(t)
	target := s.post(t, s.admin.UserID, "keep me")
	seq := approvalSeq(t, s.del(s.agent, target))
	res, err := s.interact(s.admin, seq, "deny")
	if err != nil {
		t.Fatal(err)
	}
	if c := decoded(t, res); c.GetState() != cardv1.ApprovalState_APPROVAL_STATE_DENIED || c.GetDecidedBy() != s.admin.UserID || c.GetResult() != "" {
		t.Fatalf("denied card = %v", c)
	}
	if s.deleted(t, target) {
		t.Fatal("denied delete ran")
	}
	if row := s.pending(t, seq); row.State != pendingaction.StateDenied || row.DecidedBy != s.admin.UserID {
		t.Fatalf("denied row = %+v", row)
	}
	_, err = s.interact(s.admin, seq, "approve")
	codeOf(t, err, connect.CodeFailedPrecondition)
	if s.deleted(t, target) {
		t.Fatal("approve after deny ran the call")
	}
}

func TestPeopleDeleteWithoutApproval(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	own := s.post(t, s.person.UserID, "mine")
	if err := s.del(s.person, own); err != nil {
		t.Fatal(err)
	}
	if !s.deleted(t, own) {
		t.Fatal("own delete did not run")
	}
	if n, _ := s.st.Ent.PendingAction.Query().Count(ctx); n != 0 {
		t.Fatalf("pending actions = %d", n)
	}
	if n, _ := s.st.Ent.Message.Query().Where(message.CardType(approvalTypeURL)).Count(ctx); n != 0 {
		t.Fatalf("approval cards = %d", n)
	}
	theirs := s.post(t, s.admin.UserID, "not yours")
	codeOf(t, s.del(s.person, theirs), connect.CodePermissionDenied)
	if s.deleted(t, theirs) {
		t.Fatal("non admin deleted someone else's message")
	}
}

func TestBotServiceAccountWaitsForApproval(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u, _, secret, err := s.ids.CreateServiceAccount(ctx, s.admin, "Deploy Bot", user.KindBot, "deploy", nil, identity.Meta{})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	bot, err := s.ids.AuthenticateHTTP(req)
	if err != nil || bot.UserID != u.ID || bot.Kind != "bot" {
		t.Fatalf("bot principal = %+v, %v", bot, err)
	}
	target := s.post(t, bot.UserID, "bot wrote this")
	seq := approvalSeq(t, s.del(bot, target))
	if s.deleted(t, target) {
		t.Fatal("bot service account deleted without approval")
	}
	if _, err := s.interact(s.admin, seq, "approve"); err != nil {
		t.Fatal(err)
	}
	if !s.deleted(t, target) || s.pending(t, seq).State != pendingaction.StateExecuted {
		t.Fatal("approved bot delete did not run")
	}
}
