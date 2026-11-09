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
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/validate"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/nickheyer/DiscoFlix/internal/approval"
	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/catalog"
	"github.com/nickheyer/DiscoFlix/internal/catalog/artwork"
	"github.com/nickheyer/DiscoFlix/internal/catalog/datasets"
	"github.com/nickheyer/DiscoFlix/internal/catalog/match"
	"github.com/nickheyer/DiscoFlix/internal/catalog/snapshot"
	"github.com/nickheyer/DiscoFlix/internal/catalog/source/fanart"
	"github.com/nickheyer/DiscoFlix/internal/catalog/source/tmdb"
	"github.com/nickheyer/DiscoFlix/internal/catalog/source/trakt"
	"github.com/nickheyer/DiscoFlix/internal/catalog/source/tvdb"
	"github.com/nickheyer/DiscoFlix/internal/catalog/source/wikidata"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/credentials"
	"github.com/nickheyer/DiscoFlix/internal/discord"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/gateway"
	"github.com/nickheyer/DiscoFlix/internal/identity"
	"github.com/nickheyer/DiscoFlix/internal/outbound"
	"github.com/nickheyer/DiscoFlix/internal/presence"
	"github.com/nickheyer/DiscoFlix/internal/realtime"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	"github.com/nickheyer/DiscoFlix/internal/workflow"
	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1/capabilityv1connect"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	catalogv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/catalog/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/catalog/v1/catalogv1connect"
	discordv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/discord/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/discord/v1/discordv1connect"
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
	Web     fs.FS
	Log     *slog.Logger
}

// App holds every subsystem for the lifetime of the process
type App struct {
	opts      Options
	store     *store.Store
	authz     *authz.Service
	node      *realtime.Node
	tl        *timeline.Service
	ids       *identity.Service
	reg       *capability.Registry
	exts      *extension.Registry
	approvals *approval.Service
	discord   *discord.Service
	workflows *workflow.Service
	catalog   *catalog.Service
	handler   http.Handler
	migrated  store.MigrateReport
	token     *identity.ShellToken

	ready     chan struct{}
	mu        sync.Mutex
	addr      net.Addr
	server    *gateway.Server
	pending   []net.Listener
	mode      string
	closeOnce sync.Once
}

// New opens the stores, migrates, seeds the system space, and assembles the HTTP handler
func New(ctx context.Context, opts Options) (*App, error) {
	if missing := credentials.Missing(); len(missing) > 0 {
		return nil, fmt.Errorf("app: this binary was linked without %s, build with task or make so .env fills the linker flags", strings.Join(missing, ", "))
	}
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
	var tracker *presence.Tracker
	if a.node, err = realtime.New(log, opts.Version, func(ctx context.Context, userID, channel string) (bool, error) {
		return authorizeChannel(ctx, check, userID, channel)
	}, realtime.Hooks{
		OnConnect:    func(userID string) { tracker.Connect(userID) },
		OnDisconnect: func(userID string) { tracker.Disconnect(userID) },
	}); err != nil {
		a.Close()
		return nil, err
	}
	a.tl = timeline.New(st.Ent, a.authz, a.node, log)
	tracker = presence.New(a.tl.PresenceChanged)
	a.tl.SetPresence(tracker)
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
		discordv1.File_discoflix_discord_v1_discord_proto.Services().ByName("DiscordService"),
		catalogv1.File_discoflix_catalog_v1_catalog_proto.Services().ByName("CatalogService"),
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
	interceptor := capability.NewInterceptor(a.reg, a.ids, gate, log)
	srv := connect.NewServer(validate.NewServerInterceptor(), interceptor.Server())
	invoker := capability.NewInvoker(a.reg, srv)
	a.approvals = approval.New(st.Ent, a.tl, invoker, check, log)
	interceptor.SetApprover(a.approvals)
	if err := a.exts.Register(a.approvals.Card()); err != nil {
		a.Close()
		return nil, err
	}
	if a.workflows, err = workflow.Open(ctx, cfg.DataDir, log); err != nil {
		a.Close()
		return nil, err
	}
	client := outbound.New(catalog.NewRecorder(st.Ent), "DiscoFlix/"+opts.Version+" (+https://github.com/nickheyer/DiscoFlix)", log.With("component", "outbound"))
	snapshots, err := snapshot.New(cfg.DataDir, client, log.With("component", "snapshot"))
	if err != nil {
		a.Close()
		return nil, err
	}
	bulk := datasets.New(st.DB, st.Ent, client, cfg.DataDir, log.With("component", "datasets"))
	matcher := match.New()
	sources := append([]catalog.Source{snapshots, tmdb.New(client, credentials.TMDB), tvdb.New(client, credentials.TVDB), trakt.New(client, credentials.Trakt), fanart.New(client, credentials.Fanart), wikidata.New(client)}, bulk.Sources()...)
	art := artwork.New(cfg.DataDir, client, st.Ent, log.With("component", "artwork"))
	if a.catalog, err = catalog.New(ctx, catalog.Deps{
		Ent:        st.Ent,
		DB:         st.DB,
		Timeline:   a.tl,
		Check:      check,
		Settings:   store.NewSettings(st.Ent),
		Workflows:  a.workflows,
		Outbound:   client,
		Extensions: a.exts,
		Scorer:     matcher,
		Trainer:    matcher,
		Artworks:   art,
		Snapshots:  snapshots,
		Datasets:   bulk,
		Sources:    sources,
		LinkBase:   a.ids.LinkBase,
		Log:        log.With("component", "catalog"),
	}); err != nil {
		a.Close()
		return nil, err
	}
	a.discord = discord.New(discord.Deps{
		Ent:      st.Ent,
		Timeline: a.tl,
		Identity: a.ids,
		Authz:    a.authz,
		Secrets:  secrets,
		Settings: store.NewSettings(st.Ent),
		Invoker:  invoker,
		Registry: a.reg,
		Cards:    a.exts,
		Presence: tracker,
		Seed:     discord.Seed{BotToken: cfg.DiscordBotToken, ClientSecret: cfg.DiscordClientSecret},
		Log:      log.With("component", "discord"),
	})
	capabilityv1connect.RegisterCapabilityServiceHandler(srv, capability.NewHandler(a.reg))
	timelinev1connect.RegisterTimelineServiceHandler(srv, tlHandler)
	identityv1connect.RegisterIdentityServiceHandler(srv, identity.NewHandler(a.ids))
	discordv1connect.RegisterDiscordServiceHandler(srv, discord.NewHandler(a.discord))
	catalogv1connect.RegisterCatalogServiceHandler(srv, catalog.NewHandler(a.catalog))
	if a.token, err = identity.NewShellToken(); err != nil {
		a.Close()
		return nil, err
	}
	a.handler = gateway.NewHandler(gateway.Deps{
		Server:  srv,
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
		Routes: map[string]http.Handler{
			"GET /auth/discord/start":       a.discord.StartHandler(),
			"GET /auth/discord/callback":    a.discord.CallbackHandler(),
			"GET /blobs/":                   art.Handler(),
			"GET /catalog/snapshot/version": snapshots.Handler(),
			"GET /catalog/snapshot/rsync":   snapshots.Handler(),
		},
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
	spaceID, channelID, ok := timeline.ParseName(channel)
	switch {
	case !ok:
		return false, nil
	case channelID != "":
		return check(ctx, "user:"+userID, "reader", "channel:"+channelID)
	default:
		return check(ctx, "user:"+userID, "member", "space:"+spaceID)
	}
}

func secureCookies(publicURL string) bool {
	return len(publicURL) > 8 && publicURL[:8] == "https://"
}

// Listen binds addr for requests, serving it at once when Run is already serving
func (a *App) Listen(ctx context.Context, addr string) (net.Addr, error) {
	ln, err := gateway.Listen(ctx, addr)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.addr == nil {
		a.addr = ln.Addr()
	}
	if a.server != nil {
		a.server.Serve(ln)
	} else {
		a.pending = append(a.pending, ln)
	}
	a.opts.Log.Info("http listening", "addr", ln.Addr().String())
	return ln.Addr(), nil
}

// Setting decodes the value saved in the app under key, reporting false when unset
func (a *App) Setting(ctx context.Context, key string, out any) (bool, error) {
	return store.NewSettings(a.store.Ent).Get(ctx, key, out)
}

// Run starts every subsystem, serves the bound listeners, posts the boot report, and waits until ctx ends
func (a *App) Run(ctx context.Context, mode string) error {
	a.mu.Lock()
	bound := len(a.pending)
	a.mu.Unlock()
	if bound == 0 {
		return errors.New("app: Listen must bind an address before Run")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := a.node.Run(); err != nil {
		return err
	}
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); _ = a.authz.Run(ctx) }()
	go func() { defer wg.Done(); _ = a.ids.Run(ctx) }()
	go func() { defer wg.Done(); _ = a.discord.Run(ctx) }()
	a.mu.Lock()
	a.mode = mode
	a.server = gateway.NewServer(a.handler, a.opts.Log)
	for _, ln := range a.pending {
		a.server.Serve(ln)
	}
	a.pending = nil
	a.mu.Unlock()
	if a.opts.Config.PublicURL == "" {
		a.ids.SetLinkBase(defaultBase(a.Addr()))
	}
	a.opts.Log.Info("serving", "url", a.baseURL(), "addr", a.Addr().String(), "mode", mode)
	close(a.ready)
	a.postBootReport(ctx)
	a.discord.Start(ctx)
	if err := a.catalog.Start(ctx); err != nil {
		a.opts.Log.Error("catalog start failed", "error", err)
		a.postCatalogFailure(ctx, err)
	}
	err := a.server.Wait(ctx)
	cancel()
	wg.Wait()
	shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	_ = a.node.Shutdown(shutdown)
	return err
}

// defaultBase guesses the address people on the LAN reach this server at when no public URL is configured
func defaultBase(addr net.Addr) string {
	host, _ := os.Hostname()
	if host == "" {
		host = "localhost"
	}
	port := ""
	if tcp, ok := addr.(*net.TCPAddr); ok {
		port = strconv.Itoa(tcp.Port)
		if tcp.IP != nil && !tcp.IP.IsUnspecified() {
			host = tcp.IP.String()
		}
	}
	return "http://" + net.JoinHostPort(host, port)
}

// baseURL is the address people open in a browser, the configured public URL or the host and port bound at boot
func (a *App) baseURL() string {
	if a.opts.Config.PublicURL != "" {
		return strings.TrimRight(a.opts.Config.PublicURL, "/")
	}
	return defaultBase(a.Addr())
}

func (a *App) postBootReport(ctx context.Context) {
	report := &cardv1.BootReport{
		Version:           a.opts.Version,
		Commit:            a.opts.Commit,
		GoVersion:         runtime.Version(),
		Os:                runtime.GOOS,
		Arch:              runtime.GOARCH,
		Mode:              a.mode,
		MigrationsApplied: int32(a.migrated.Applied),
		DataDir:           a.opts.Config.DataDir,
		Address:           a.Addr().String(),
		Url:               a.baseURL(),
	}
	content := fmt.Sprintf("DiscoFlix %s started in %s mode on %s/%s, serving %s", a.opts.Version, a.mode, runtime.GOOS, runtime.GOARCH, report.Url)
	if a.migrated.Applied > 0 {
		content += fmt.Sprintf(", applied %d migrations", a.migrated.Applied)
	}
	if _, err := a.tl.PostSystem(ctx, "audit", content, report); err != nil {
		a.opts.Log.Error("boot report failed", "error", err)
	}
}

// postCatalogFailure tells #audit that durable catalog work is not running and why
func (a *App) postCatalogFailure(ctx context.Context, err error) {
	if _, perr := a.tl.PostSystem(ctx, "audit", "The catalog workflow runtime failed to start", &cardv1.SystemNotice{Title: "Catalog workflows stopped", Body: "Snapshot updates, dataset imports, and entity refreshes are not running: " + err.Error(), Severity: cardv1.Severity_SEVERITY_ERROR}); perr != nil {
		a.opts.Log.Error("catalog failure notice failed", "error", perr)
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

// ShellURL is the URL the desktop window opens, on loopback unless the server is bound to one other address, carrying a fresh single-use token
func (a *App) ShellURL() string {
	host, port := "127.0.0.1", ""
	if tcp, ok := a.Addr().(*net.TCPAddr); ok {
		port = strconv.Itoa(tcp.Port)
		if tcp.IP != nil && !tcp.IP.IsUnspecified() && !tcp.IP.IsLoopback() {
			host = tcp.IP.String()
		}
	}
	return "http://" + net.JoinHostPort(host, port) + "/shell/session?token=" + a.token.Rotate()
}

// Close releases every subsystem
func (a *App) Close() {
	a.closeOnce.Do(func() {
		for _, ln := range a.pending {
			_ = ln.Close()
		}
		if a.workflows != nil {
			_ = a.workflows.Close()
		}
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
