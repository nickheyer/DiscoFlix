package capability

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connectinprocess"

	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1/capabilityv1connect"
	identityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1/identityv1connect"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1/timelinev1connect"
)

type fakeAuth struct{ p *Principal }

func (f fakeAuth) Authenticate(context.Context, *connect.CallInfo) (Principal, error) {
	if f.p == nil {
		return Principal{}, ErrNoCredentials
	}
	return *f.p, nil
}

type fakeTimeline struct {
	timelinev1connect.UnimplementedTimelineServiceHandler
}

func (fakeTimeline) ListMessages(context.Context, *timelinev1.ListMessagesRequest) (*timelinev1.ListMessagesResponse, error) {
	return &timelinev1.ListMessagesResponse{}, nil
}

type fakeIdentity struct {
	identityv1connect.UnimplementedIdentityServiceHandler
}

func (fakeIdentity) GetServerInfo(context.Context, *identityv1.GetServerInfoRequest) (*identityv1.GetServerInfoResponse, error) {
	return &identityv1.GetServerInfoResponse{Version: "test"}, nil
}

func newRegistry(t *testing.T) *Registry {
	t.Helper()
	reg := NewRegistry()
	for _, sd := range []interface{ FullName() string }{} {
		_ = sd
	}
	if err := reg.AddService(capabilityv1.File_discoflix_capability_v1_capability_proto.Services().ByName("CapabilityService")); err != nil {
		t.Fatal(err)
	}
	if err := reg.AddService(timelinev1.File_discoflix_timeline_v1_timeline_proto.Services().ByName("TimelineService")); err != nil {
		t.Fatal(err)
	}
	if err := reg.AddService(identityv1.File_discoflix_identity_v1_identity_proto.Services().ByName("IdentityService")); err != nil {
		t.Fatal(err)
	}
	return reg
}

func TestRegistryCoversEveryMethod(t *testing.T) {
	reg := newRegistry(t)
	if reg.Len() != 1+14+25 {
		t.Fatalf("registered %d capabilities", reg.Len())
	}
	e, ok := reg.Get("/discoflix.timeline.v1.TimelineService/PostMessage")
	if !ok || e.Object.GetType() != "channel" || e.Relation() != "writer" || e.Command != "" || len(e.InputSchema) == 0 {
		t.Fatalf("post message entry = %+v", e)
	}
	if e, _ := reg.Get("/discoflix.identity.v1.IdentityService/GetMe"); e.Relation() != "session_self" || e.Command != "whoami" {
		t.Fatalf("get me entry = %+v", e)
	}
	if e, ok := reg.ByCommand("link"); !ok || e.Method != "CreateLinkCode" || len(reg.Commands()) != 3 {
		t.Fatalf("commands = %v", reg.Commands())
	}
}

func TestInterceptorGates(t *testing.T) {
	reg := newRegistry(t)
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	calls := map[string]bool{}
	gate := NewGate(func(_ context.Context, subject, relation, object string) (bool, error) {
		calls[subject+" "+relation+" "+object] = true
		return subject == "user:admin" || (relation == "reader" && object == "channel:open"), nil
	})
	build := func(p *Principal) (capabilityv1connect.CapabilityServiceClient, timelinev1connect.TimelineServiceClient, identityv1connect.IdentityServiceClient) {
		srv := connect.NewServer(NewInterceptor(reg, fakeAuth{p}, gate, log).Server())
		capabilityv1connect.RegisterCapabilityServiceHandler(srv, NewHandler(reg))
		timelinev1connect.RegisterTimelineServiceHandler(srv, fakeTimeline{})
		identityv1connect.RegisterIdentityServiceHandler(srv, fakeIdentity{})
		client := connect.NewClient(connectinprocess.New(srv))
		return capabilityv1connect.NewCapabilityServiceClient(client), timelinev1connect.NewTimelineServiceClient(client), identityv1connect.NewIdentityServiceClient(client)
	}
	ctx := context.Background()

	capAnon, tlAnon, idAnon := build(nil)
	if _, err := idAnon.GetServerInfo(ctx, &identityv1.GetServerInfoRequest{}); err != nil {
		t.Fatalf("public method rejected: %v", err)
	}
	if _, err := capAnon.ListCapabilities(ctx, &capabilityv1.ListCapabilitiesRequest{}); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("anonymous list = %v", err)
	}
	if _, err := tlAnon.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: "open"}); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("anonymous object call = %v", err)
	}

	member := &Principal{UserID: "member", Kind: "person", Via: "session"}
	capM, tlM, _ := build(member)
	if _, err := capM.ListCapabilities(ctx, &capabilityv1.ListCapabilitiesRequest{}); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member list = %v", err)
	}
	if _, err := tlM.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: "open"}); err != nil {
		t.Fatalf("member open channel = %v", err)
	}
	if _, err := tlM.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: "closed"}); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member closed channel = %v", err)
	}
	if _, err := tlM.ListMessages(ctx, &timelinev1.ListMessagesRequest{}); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("missing object id = %v", err)
	}
	if !calls["user:member reader channel:open"] {
		t.Fatalf("object check not performed: %v", calls)
	}

	admin := &Principal{UserID: "admin", Kind: "person", Via: "session"}
	capA, _, _ := build(admin)
	res, err := capA.ListCapabilities(ctx, &capabilityv1.ListCapabilitiesRequest{})
	if err != nil || len(res.GetCapabilities()) != reg.Len() {
		t.Fatalf("admin list = %v, %d", err, len(res.GetCapabilities()))
	}

	agent := &Principal{UserID: "admin", Kind: "agent", Via: "plugin"}
	_, tlAg, _ := build(agent)
	_, err = tlAg.DeleteMessage(ctx, &timelinev1.DeleteMessageRequest{Seq: 1})
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("agent destructive = %v", err)
	}
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Message() != "destructive capabilities require an approval card" {
		t.Fatalf("agent destructive message = %v", err)
	}
}
