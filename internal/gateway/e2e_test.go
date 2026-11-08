package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"
	"connectrpc.com/validate"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/anypb"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/identity"
	"github.com/nickheyer/DiscoFlix/internal/realtime"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1/capabilityv1connect"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	identityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1/identityv1connect"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1/timelinev1connect"
)

type clients struct {
	http     *http.Client
	base     string
	capab    capabilityv1connect.CapabilityServiceClient
	identity identityv1connect.IdentityServiceClient
	timeline timelinev1connect.TimelineServiceClient
}

func newStack(t *testing.T) (*httptest.Server, *timeline.Service) {
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
	node, err := realtime.New(log, "test", func(ctx context.Context, userID, channel string) (bool, error) {
		return true, nil
	}, realtime.Hooks{})
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
	gate := capability.NewGate(check)
	cards := extension.NewRegistry()
	if err := cards.Register(extension.BuiltinCard(&cardv1.SystemNotice{})); err != nil {
		t.Fatal(err)
	}
	tlHandler := timeline.NewHandler(tl, check, cards)
	gate.Resolve("message", tlHandler.ResolveMessage)
	server := connect.NewServer(validate.NewServerInterceptor(), capability.NewInterceptor(reg, ids, gate, log).Server())
	capabilityv1connect.RegisterCapabilityServiceHandler(server, capability.NewHandler(reg))
	timelinev1connect.RegisterTimelineServiceHandler(server, tlHandler)
	identityv1connect.RegisterIdentityServiceHandler(server, identity.NewHandler(ids))
	handler := NewHandler(Deps{
		Server:  server,
		Session: ids.Middleware,
		Websocket: node.WebsocketHandler(func(r *http.Request) (string, error) {
			p, err := ids.AuthenticateHTTP(r)
			if errors.Is(err, capability.ErrNoCredentials) {
				return "", nil
			}
			if err != nil {
				return "", err
			}
			return p.UserID, nil
		}),
		ShellLogin: ids.ShellLoginHandler(nil),
		IsAdmin: func(r *http.Request) bool {
			p, err := ids.AuthenticateHTTP(r)
			return err == nil && p.SystemAdmin
		},
		Health: func(context.Context) error { return nil },
		Web: fstest.MapFS{
			"200.html":               {Data: []byte("<html>app</html>")},
			"_app/immutable/a.js":    {Data: []byte("js")},
			"_app/immutable/a.js.br": {Data: []byte("br")},
			"favicon.svg":            {Data: []byte("<svg/>")},
			"manifest.webmanifest":   {Data: []byte("{}")},
		},
		Log: log,
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv, tl
}

func newClients(t *testing.T, srv *httptest.Server) *clients {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar}
	client := connect.NewClient(connecthttp.NewTransport(hc, srv.URL))
	return &clients{
		http: hc, base: srv.URL,
		capab:    capabilityv1connect.NewCapabilityServiceClient(client),
		identity: identityv1connect.NewIdentityServiceClient(client),
		timeline: timelinev1connect.NewTimelineServiceClient(client),
	}
}

func TestEndToEnd(t *testing.T) {
	srv, tl := newStack(t)
	ctx := context.Background()
	c := newClients(t, srv)

	info, err := c.identity.GetServerInfo(ctx, &identityv1.GetServerInfoRequest{})
	if err != nil || !info.GetSetupRequired() {
		t.Fatalf("server info = %v, %v", info, err)
	}
	if _, err := c.identity.GetMe(ctx, &identityv1.GetMeRequest{}); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("anonymous GetMe = %v", err)
	}
	if _, err := c.identity.Bootstrap(ctx, &identityv1.BootstrapRequest{Username: "nick", DisplayName: "Nick", Password: "short", InstanceName: "Heyer Home"}); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("weak password = %v", err)
	}
	if _, err := c.identity.Bootstrap(ctx, &identityv1.BootstrapRequest{Username: "Nick!", DisplayName: "Nick", Password: "correct horse battery"}); connect.CodeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), "username") {
		t.Fatalf("username pattern = %v", err)
	}
	if _, err := c.identity.LoginWithPassword(ctx, &identityv1.LoginWithPasswordRequest{}); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty login = %v", err)
	}
	boot, err := c.identity.Bootstrap(ctx, &identityv1.BootstrapRequest{Username: "nick", DisplayName: "Nick", Password: "correct horse battery", InstanceName: "Heyer Home"})
	if err != nil || !boot.GetUser().GetSystemAdmin() {
		t.Fatalf("bootstrap = %v, %v", boot, err)
	}
	if _, err := c.identity.Bootstrap(ctx, &identityv1.BootstrapRequest{Username: "someone", DisplayName: "Someone", Password: "correct horse battery"}); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("second bootstrap = %v", err)
	}
	me, err := c.identity.GetMe(ctx, &identityv1.GetMeRequest{})
	if err != nil || me.GetUser().GetId() != boot.GetUser().GetId() || len(me.GetIdentities()) != 1 || len(me.GetMemberships()) != 1 {
		t.Fatalf("me = %v, %v", me, err)
	}
	info, _ = c.identity.GetServerInfo(ctx, &identityv1.GetServerInfoRequest{})
	if info.GetSetupRequired() || info.GetInstanceName() != "Heyer Home" {
		t.Fatalf("info after bootstrap = %v", info)
	}

	spaces, err := c.timeline.ListSpaces(ctx, &timelinev1.ListSpacesRequest{})
	if err != nil || len(spaces.GetSpaces()) != 1 || spaces.GetSpaces()[0].GetName() != "Heyer Home" {
		t.Fatalf("spaces = %v, %v", spaces, err)
	}
	chans, err := c.timeline.ListChannels(ctx, &timelinev1.ListChannelsRequest{SpaceId: tl.SystemSpaceID()})
	if err != nil || len(chans.GetChannels()) != len(timeline.SystemChannels) {
		t.Fatalf("channels = %v, %v", chans, err)
	}
	audit, err := c.timeline.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: tl.SystemChannelID("audit")})
	if err != nil || len(audit.GetMessages()) != 1 || !strings.Contains(audit.GetMessages()[0].GetContent(), "first administrator") {
		t.Fatalf("audit = %v, %v", audit, err)
	}
	posted, err := c.timeline.PostMessage(ctx, &timelinev1.PostMessageRequest{ChannelId: tl.SystemChannelID("general"), Content: "hello from the console"})
	if err != nil || posted.GetMessage().GetAuthor().GetDisplayName() != "Nick" {
		t.Fatalf("post = %v, %v", posted, err)
	}
	if _, err := c.timeline.EditMessage(ctx, &timelinev1.EditMessageRequest{Seq: posted.GetMessage().GetSeq(), Content: "edited"}); err != nil {
		t.Fatalf("edit = %v", err)
	}
	notice, _ := anypb.New(&cardv1.SystemNotice{Title: "hi", Body: "there"})
	if _, err := c.timeline.PostMessage(ctx, &timelinev1.PostMessageRequest{ChannelId: tl.SystemChannelID("general"), Card: notice}); err != nil {
		t.Fatalf("post known card = %v", err)
	}
	if _, err := c.timeline.PostMessage(ctx, &timelinev1.PostMessageRequest{ChannelId: tl.SystemChannelID("general"), Card: &anypb.Any{TypeUrl: "type.googleapis.com/acme.Unknown"}}); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("post unknown card = %v", err)
	}
	read, err := c.timeline.MarkRead(ctx, &timelinev1.MarkReadRequest{ChannelId: tl.SystemChannelID("general")})
	if err != nil || read.GetChannel().GetUnread() != 0 {
		t.Fatalf("mark read = %v, %v", read, err)
	}

	caps, err := c.capab.ListCapabilities(ctx, &capabilityv1.ListCapabilitiesRequest{})
	if err != nil || len(caps.GetCapabilities()) != 1+14+25 {
		t.Fatalf("capabilities = %d, %v", len(caps.GetCapabilities()), err)
	}

	key, err := c.identity.CreateApiKey(ctx, &identityv1.CreateApiKeyRequest{Name: "cli"})
	if err != nil || !strings.HasPrefix(key.GetSecret(), "dfx_") {
		t.Fatalf("api key = %v, %v", key, err)
	}
	keyClient := identityv1connect.NewIdentityServiceClient(connect.NewClient(connecthttp.NewTransport(http.DefaultClient, srv.URL), func(next connect.ClientFunc) connect.ClientFunc {
		return func(ctx context.Context, spec connect.Spec) (connect.ClientStream, error) {
			ctx, info := connect.NewClientContext(ctx)
			info.RequestHeader().Set("Authorization", "Bearer "+key.GetSecret())
			return next(ctx, spec)
		}
	}))
	viaKey, err := keyClient.GetMe(ctx, &identityv1.GetMeRequest{})
	if err != nil || viaKey.GetUser().GetId() != me.GetUser().GetId() {
		t.Fatalf("api key me = %v, %v", viaKey, err)
	}
	keys, _ := c.identity.ListApiKeys(ctx, &identityv1.ListApiKeysRequest{})
	if len(keys.GetApiKeys()) != 1 {
		t.Fatalf("keys = %v", keys)
	}
	if _, err := c.identity.RevokeApiKey(ctx, &identityv1.RevokeApiKeyRequest{Id: keys.GetApiKeys()[0].GetId()}); err != nil {
		t.Fatal(err)
	}
	if _, err := keyClient.GetMe(ctx, &identityv1.GetMeRequest{}); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("revoked key = %v", err)
	}

	sessions, err := c.identity.ListSessions(ctx, &identityv1.ListSessionsRequest{})
	if err != nil || len(sessions.GetSessions()) != 1 || !sessions.GetSessions()[0].GetCurrent() {
		t.Fatalf("sessions = %v, %v", sessions, err)
	}
	if _, err := c.identity.Logout(ctx, &identityv1.LogoutRequest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.identity.GetMe(ctx, &identityv1.GetMeRequest{}); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("after logout = %v", err)
	}
	if _, err := c.identity.LoginWithPassword(ctx, &identityv1.LoginWithPasswordRequest{Username: "nick", Password: "wrong password here"}); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("wrong password = %v", err)
	}
	if _, err := c.identity.LoginWithPassword(ctx, &identityv1.LoginWithPasswordRequest{Username: "NICK", Password: "correct horse battery"}); err != nil {
		t.Fatalf("login = %v", err)
	}
	if _, err := c.identity.ChangePassword(ctx, &identityv1.ChangePasswordRequest{CurrentPassword: "correct horse battery", NewPassword: "a brand new passphrase"}); err != nil {
		t.Fatal(err)
	}

	users, err := c.identity.ListUsers(ctx, &identityv1.ListUsersRequest{})
	if err != nil || len(users.GetUsers()) != 2 {
		t.Fatalf("users = %v, %v", users, err)
	}
	if _, err := c.identity.UpdateUser(ctx, &identityv1.UpdateUserRequest{Id: me.GetUser().GetId(), Status: identityv1.UserStatus_USER_STATUS_ACTIVE, SystemAdmin: false}); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("demote last admin = %v", err)
	}

	audit, _ = c.timeline.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: tl.SystemChannelID("audit")})
	actions := map[string]bool{}
	for _, m := range audit.GetMessages() {
		actions[m.GetCard().GetTypeUrl()] = true
	}
	if len(audit.GetMessages()) != 6 || !actions["type.googleapis.com/discoflix.card.v1.SecurityEvent"] {
		t.Fatalf("audit trail = %d messages, %v", len(audit.GetMessages()), actions)
	}

	// static assets and fallback
	res, err := c.http.Get(srv.URL + "/s/abc/c/def")
	if err != nil || res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("spa fallback = %v, %v", res, err)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/_app/immutable/a.js", nil)
	req.Header.Set("Accept-Encoding", "br")
	res, _ = c.http.Do(req)
	if res.Header.Get("Content-Encoding") != "br" || !strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("immutable asset headers = %v", res.Header)
	}
	res, _ = c.http.Get(srv.URL + "/manifest.webmanifest")
	if res.Header.Get("Content-Type") != "application/manifest+json" {
		t.Fatalf("manifest content type = %s", res.Header.Get("Content-Type"))
	}
	res, _ = c.http.Get(srv.URL + "/discoflix.nope.v1.Nope/Call")
	if res.StatusCode != 404 {
		t.Fatalf("unknown procedure = %d", res.StatusCode)
	}
	res, _ = c.http.Get(srv.URL + "/healthz")
	if res.StatusCode != 200 {
		t.Fatalf("healthz = %d", res.StatusCode)
	}
	res, _ = http.Get(srv.URL + "/metrics")
	if res.StatusCode != 403 {
		t.Fatalf("anonymous metrics = %d", res.StatusCode)
	}
	res, _ = c.http.Get(srv.URL + "/metrics")
	if res.StatusCode != 200 {
		t.Fatalf("admin metrics = %d", res.StatusCode)
	}
}
