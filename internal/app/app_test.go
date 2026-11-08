package app

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"

	"github.com/nickheyer/DiscoFlix/internal/config"
	identityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1/identityv1connect"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1/timelinev1connect"
)

func TestBootAndShellLogin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	dir := t.TempDir()
	a, err := New(ctx, Options{
		Config:  config.Config{DataDir: dir, Addr: "127.0.0.1:0"},
		Version: "0.0.0-test",
		Commit:  "abc",
		Mode:    "window",
		Web:     fstest.MapFS{"200.html": {Data: []byte("<html>app</html>")}},
		Log:     log,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	errc := make(chan error, 1)
	go func() { errc <- a.Run(ctx) }()
	select {
	case <-a.Ready():
	case err := <-errc:
		t.Fatal(err)
	case <-time.After(10 * time.Second):
		t.Fatal("server never became ready")
	}
	base := "http://" + a.Addr().String()
	res, err := http.Get(base + "/healthz")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("healthz = %v, %v", res, err)
	}

	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	client := connect.NewClient(connecthttp.NewTransport(hc, base))
	ids := identityv1connect.NewIdentityServiceClient(client)
	tl := timelinev1connect.NewTimelineServiceClient(client)

	shellURL := a.ShellURL()
	if !strings.HasPrefix(shellURL, base+"/shell/session?token=") {
		t.Fatalf("shell url = %s", shellURL)
	}
	res, err = hc.Get(shellURL)
	if err != nil || res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/setup" {
		t.Fatalf("shell before setup = %v, %v", res, err)
	}
	if res, _ := hc.Get(shellURL); res.StatusCode != http.StatusForbidden {
		t.Fatalf("token reuse = %d", res.StatusCode)
	}

	if _, err := ids.Bootstrap(ctx, &identityv1.BootstrapRequest{Username: "nick", DisplayName: "Nick", Password: "correct horse battery"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ids.Logout(ctx, &identityv1.LogoutRequest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := ids.GetMe(ctx, &identityv1.GetMeRequest{}); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("after logout = %v", err)
	}
	res, err = hc.Get(a.ShellURL())
	if err != nil || res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/" {
		t.Fatalf("shell login = %v, %v", res, err)
	}
	me, err := ids.GetMe(ctx, &identityv1.GetMeRequest{})
	if err != nil || me.GetUser().GetDisplayName() != "Nick" {
		t.Fatalf("me after shell login = %v, %v", me, err)
	}

	spaces, err := tl.ListSpaces(ctx, &timelinev1.ListSpacesRequest{})
	if err != nil || len(spaces.GetSpaces()) != 1 {
		t.Fatal(spaces, err)
	}
	chans, _ := tl.ListChannels(ctx, &timelinev1.ListChannelsRequest{SpaceId: spaces.GetSpaces()[0].GetId()})
	var auditID string
	for _, c := range chans.GetChannels() {
		if c.GetName() == "audit" {
			auditID = c.GetId()
		}
	}
	msgs, err := tl.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: auditID})
	if err != nil {
		t.Fatal(err)
	}
	var sawBoot bool
	for _, m := range msgs.GetMessages() {
		if m.GetCard().GetTypeUrl() == "type.googleapis.com/discoflix.card.v1.BootReport" && strings.Contains(m.GetContent(), "0.0.0-test") && strings.Contains(m.GetContent(), "window mode") {
			sawBoot = true
		}
	}
	if !sawBoot {
		t.Fatalf("boot report missing in %v", msgs.GetMessages())
	}
	cancel()
	select {
	case err := <-errc:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("shutdown hung")
	}
}
