package app

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"
	"google.golang.org/protobuf/proto"

	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/credentials"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	identityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1/identityv1connect"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1/timelinev1connect"
)

// linkCredentials stands in for the linker so the app boots in tests, restoring the empty build values afterwards
func linkCredentials(t *testing.T) {
	t.Helper()
	saved := []string{credentials.TMDB, credentials.TVDB, credentials.Trakt, credentials.Fanart}
	t.Cleanup(func() {
		credentials.TMDB, credentials.TVDB, credentials.Trakt, credentials.Fanart = saved[0], saved[1], saved[2], saved[3]
	})
	credentials.TMDB, credentials.TVDB, credentials.Trakt, credentials.Fanart = "tmdb-test", "tvdb-test", "trakt-test", "fanart-test"
}

func TestNewRefusesABinaryLinkedWithoutCredentials(t *testing.T) {
	linkCredentials(t)
	credentials.TVDB, credentials.Fanart = "", ""
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	dir := t.TempDir()
	_, err := New(context.Background(), Options{Config: config.Config{DataDir: dir, Addr: "127.0.0.1:0"}, Version: "0.0.0-test", Commit: "abc", Web: fstest.MapFS{}, Log: log})
	if err == nil || !strings.Contains(err.Error(), "TVDB_API_KEY, FATV_PROJECT_API_KEY") {
		t.Fatalf("err = %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("refused boot still wrote %v", entries)
	}
}

func TestBootAndShellLogin(t *testing.T) {
	linkCredentials(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	dir := t.TempDir()
	a, err := New(ctx, Options{
		Config:  config.Config{DataDir: dir, Addr: "127.0.0.1:0"},
		Version: "0.0.0-test",
		Commit:  "abc",
		Web:     fstest.MapFS{"200.html": {Data: []byte("<html>app</html>")}},
		Log:     log,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	errc := make(chan error, 1)
	if _, err := a.Listen(ctx, "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	go func() { errc <- a.Run(ctx, "web") }()
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
	var auditID, generalID string
	for _, c := range chans.GetChannels() {
		switch c.GetName() {
		case "audit":
			auditID = c.GetId()
		case "general":
			generalID = c.GetId()
		}
	}
	msgs, err := tl.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: auditID})
	if err != nil {
		t.Fatal(err)
	}
	var sawBoot bool
	for _, m := range msgs.GetMessages() {
		if m.GetCard().GetTypeUrl() == "type.googleapis.com/discoflix.card.v1.BootReport" && strings.Contains(m.GetContent(), "0.0.0-test") && strings.Contains(m.GetContent(), "web mode") {
			sawBoot = true
			var report cardv1.BootReport
			if err := proto.Unmarshal(m.GetCard().GetValue(), &report); err != nil {
				t.Fatal(err)
			}
			if report.GetAddress() != a.Addr().String() || report.GetUrl() == "" || !strings.HasSuffix(report.GetUrl(), ":"+strconv.Itoa(a.Addr().(*net.TCPAddr).Port)) || !strings.Contains(m.GetContent(), "serving "+report.GetUrl()) {
				t.Fatalf("boot report address = %q url = %q content = %q", report.GetAddress(), report.GetUrl(), m.GetContent())
			}
		}
	}
	if !sawBoot {
		t.Fatalf("boot report missing in %v", msgs.GetMessages())
	}
	general, err := tl.ListMessages(ctx, &timelinev1.ListMessagesRequest{ChannelId: generalID})
	if err != nil {
		t.Fatal(err)
	}
	var welcomed bool
	for _, m := range general.GetMessages() {
		if m.GetCard().GetTypeUrl() != "type.googleapis.com/discoflix.card.v1.SystemNotice" {
			continue
		}
		var notice cardv1.SystemNotice
		if err := proto.Unmarshal(m.GetCard().GetValue(), &notice); err != nil {
			t.Fatal(err)
		}
		if notice.GetTitle() == "Welcome to DiscoFlix" && strings.Contains(notice.GetBody(), "listening at http://") && strings.Contains(notice.GetBody(), "Settings > Discord") {
			welcomed = true
		}
	}
	if !welcomed {
		t.Fatalf("welcome notice missing in %v", general.GetMessages())
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
