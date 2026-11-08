// Package app starts every subsystem in dependency order and stops them in reverse
package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"sync"
	"time"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/validate"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/gateway"
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

// Options configure one process
type Options struct {
	Config  config.Config
	Version string
	Commit  string
	// headless, tray, or window
	Mode string
	Web  fs.FS
	Log  *slog.Logger
}

// App holds every subsystem for the lifetime of the process
type App struct {
	opts     Options
	store    *store.Store
	authz    *authz.Service
	node     *realtime.Node
	tl       *timeline.Service
	ids      *identity.Service
	reg      *capability.Registry
	exts     *extension.Registry
	handler  http.Handler
	migrated store.MigrateReport
	token    *identity.ShellToken

	ready     chan struct{}
	mu        sync.Mutex
	addr      net.Addr
	closeOnce sync.Once
}

// New opens the stores, migrates, seeds the system space, and assembles the HTTP handler
func New(ctx context.Context, opts Options) (*App, error) {
	log := opts.Log
	cfg := opts.Config
	secrets, err := config.OpenSecrets(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	st, err := store.Open(ctx, cfg.DataDir, log)
	if err != nil {
		return nil, err
	}
	a := &App{opts: opts, store: st, ready: make(chan struct{})}
	if a.migrated, err = st.Migrate(ctx, opts.Version); err != nil {
		a.Close()
		return nil, err
	}
	if a.authz, err = authz.Open(ctx, cfg.DataDir, st.Ent, log); err != nil {
		a.Close()
		return nil, err
	}
	check := func(ctx context.Context, subject, relation, object string) (bool, error) {
		return a.authz.Check(ctx, subject, relation, object, nil)
	}
	if a.node, err = realtime.New(log, opts.Version, func(ctx context.Context, userID, channel string) (bool, error) {
		return authorizeChannel(ctx, check, userID, channel)
	}); err != nil {
		a.Close()
		return nil, err
	}
	a.tl = timeline.New(st.Ent, a.authz, a.node, log)
	if err := a.tl.EnsureSystem(ctx, "DiscoFlix"); err != nil {
		a.Close()
		return nil, err
	}
	if a.ids, err = identity.Open(ctx, cfg.DataDir, secrets, st.Ent, a.authz, a.tl, identity.Build{Version: opts.Version, Commit: opts.Commit}, secureCookies(cfg.PublicURL), log); err != nil {
		a.Close()
		return nil, err
	}
	a.ids.SetPublicURL(cfg.PublicURL)
	if name, err := a.ids.InstanceName(ctx); err == nil && name != "DiscoFlix" {
		if err := a.tl.RenameSystemSpace(ctx, name); err != nil {
			a.Close()
			return nil, err
		}
	}
	a.reg = capability.NewRegistry()
	for _, sd := range []protoreflect.ServiceDescriptor{
		capabilityv1.File_discoflix_capability_v1_capability_proto.Services().ByName("CapabilityService"),
		timelinev1.File_discoflix_timeline_v1_timeline_proto.Services().ByName("TimelineService"),
		identityv1.File_discoflix_identity_v1_identity_proto.Services().ByName("IdentityService"),
	} {
		if err := a.reg.AddService(sd); err != nil {
			a.Close()
			return nil, err
		}
	}
	a.exts = extension.NewRegistry()
	for _, card := range []proto.Message{&cardv1.SystemNotice{}, &cardv1.BootReport{}, &cardv1.SecurityEvent{}, &cardv1.UpdateEvent{}} {
		if err := a.exts.Register(extension.BuiltinCard(card)); err != nil {
			a.Close()
			return nil, err
		}
	}
	gate := capability.NewGate(check)
	tlHandler := timeline.NewHandler(a.tl, check, a.exts)
	gate.Resolve("message", tlHandler.ResolveMessage)
	if a.token, err = identity.NewShellToken(); err != nil {
		a.Close()
		return nil, err
	}
	a.handler = gateway.NewHandler(gateway.Deps{
		Interceptors: []connect.ServerInterceptor{validate.NewServerInterceptor(), capability.NewInterceptor(a.reg, a.ids, gate, log).Server()},
		Register: func(s *connect.Server) {
			capabilityv1connect.RegisterCapabilityServiceHandler(s, capability.NewHandler(a.reg))
			timelinev1connect.RegisterTimelineServiceHandler(s, tlHandler)
			identityv1connect.RegisterIdentityServiceHandler(s, identity.NewHandler(a.ids))
		},
		Session: a.ids.Middleware,
		Websocket: a.node.WebsocketHandler(func(r *http.Request) (string, error) {
			p, err := a.ids.AuthenticateHTTP(r)
			if errors.Is(err, capability.ErrNoCredentials) {
				return "", nil
			}
			if err != nil {
				return "", err
			}
			return p.UserID, nil
		}),
		ShellLogin: a.ids.ShellLoginHandler(a.token),
		IsAdmin: func(r *http.Request) bool {
			p, err := a.ids.AuthenticateHTTP(r)
			return err == nil && p.SystemAdmin
		},
		Health: func(ctx context.Context) error { return st.DB.PingContext(ctx) },
		Web:    opts.Web,
		Log:    log,
	})
	return a, nil
}

// authorizeChannel maps realtime channel names onto relationship checks
func authorizeChannel(ctx context.Context, check capability.CheckFunc, userID, channel string) (bool, error) {
	if channel == timeline.UserChannel(userID) {
		return true, nil
	}
	var spaceID, channelID string
	if n, _ := fmt.Sscanf(channel, "space:%36s:channel:%36s", &spaceID, &channelID); n == 2 {
		return check(ctx, "user:"+userID, "reader", "channel:"+channelID)
	}
	return false, nil
}

func secureCookies(publicURL string) bool {
	return len(publicURL) > 8 && publicURL[:8] == "https://"
}

// Run serves until ctx ends, posting the boot report once the listener is up
func (a *App) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := a.node.Run(); err != nil {
		return err
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = a.authz.Run(ctx) }()
	go func() { defer wg.Done(); _ = a.ids.Run(ctx) }()
	err := gateway.Serve(ctx, a.opts.Config.Addr, a.handler, a.opts.Log, func(addr net.Addr) {
		a.mu.Lock()
		a.addr = addr
		a.mu.Unlock()
		close(a.ready)
		a.postBootReport(ctx)
	})
	cancel()
	wg.Wait()
	shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	_ = a.node.Shutdown(shutdown)
	return err
}

func (a *App) postBootReport(ctx context.Context) {
	report := &cardv1.BootReport{
		Version:           a.opts.Version,
		Commit:            a.opts.Commit,
		GoVersion:         runtime.Version(),
		Os:                runtime.GOOS,
		Arch:              runtime.GOARCH,
		Mode:              a.opts.Mode,
		MigrationsApplied: int32(a.migrated.Applied),
		DataDir:           a.opts.Config.DataDir,
	}
	content := fmt.Sprintf("DiscoFlix %s started in %s mode on %s/%s", a.opts.Version, a.opts.Mode, runtime.GOOS, runtime.GOARCH)
	if a.migrated.Applied > 0 {
		content += fmt.Sprintf(", applied %d migrations", a.migrated.Applied)
	}
	if _, err := a.tl.PostSystem(ctx, "audit", content, report); err != nil {
		a.opts.Log.Error("boot report failed", "error", err)
	}
}

// Ready closes once the HTTP listener is bound
func (a *App) Ready() <-chan struct{} { return a.ready }

// Addr returns the bound listener address once Ready is closed
func (a *App) Addr() net.Addr {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.addr
}

// ShellURL is the loopback URL the desktop window opens, carrying a fresh single-use token
func (a *App) ShellURL() string {
	addr := a.Addr()
	port := ""
	if tcp, ok := addr.(*net.TCPAddr); ok {
		port = fmt.Sprint(tcp.Port)
	}
	return fmt.Sprintf("http://127.0.0.1:%s/shell/session?token=%s", port, a.token.Rotate())
}

// Close releases every subsystem
func (a *App) Close() {
	a.closeOnce.Do(func() {
		if a.ids != nil {
			_ = a.ids.Close()
		}
		if a.authz != nil {
			a.authz.Close()
		}
		if a.store != nil {
			_ = a.store.Close()
		}
	})
}
