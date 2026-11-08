// Package discord mirrors guilds into the timeline over the disgo gateway and renders cards as Components V2
package discord

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/disgoorg/disgo"
	"github.com/disgoorg/disgo/bot"
	"github.com/disgoorg/disgo/cache"
	dg "github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/events"
	dgw "github.com/disgoorg/disgo/gateway"
	"github.com/disgoorg/disgo/rest"
	"github.com/disgoorg/snowflake/v2"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/identity"
	"github.com/nickheyer/DiscoFlix/internal/presence"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	discordv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/discord/v1"
)

// Secret and setting keys the mirror owns
const (
	SecretBotToken     = "discord.bot_token"     //nolint:gosec // the name of a setting, not a credential
	SecretClientSecret = "discord.client_secret" //nolint:gosec // the name of a setting, not a credential
	secretWebhook      = "discord.webhook."
	SettingAppID       = "discord.application_id"
	Provider           = "discord"
)

// Connection states reported in status
const (
	StateDisconnected = "disconnected"
	StateConnecting   = "connecting"
	StateConnected    = "connected"
	StateFailed       = "failed"
)

// intents the mirror identifies with, three of them privileged in the developer portal
const intents = dgw.IntentGuilds | dgw.IntentGuildMembers | dgw.IntentGuildMessages | dgw.IntentGuildMessageReactions |
	dgw.IntentGuildMessageTyping | dgw.IntentGuildPresences | dgw.IntentMessageContent

// botPermissions is what the invite asks for so mirroring, webhooks, threads, and moderation deletes work
const botPermissions = dg.PermissionViewChannel | dg.PermissionSendMessages | dg.PermissionSendMessagesInThreads |
	dg.PermissionManageMessages | dg.PermissionManageWebhooks | dg.PermissionReadMessageHistory | dg.PermissionAddReactions |
	dg.PermissionCreatePublicThreads | dg.PermissionManageThreads | dg.PermissionEmbedLinks | dg.PermissionAttachFiles |
	dg.PermissionUseExternalEmojis

var (
	ErrNotConfigured = errors.New("discord: no bot token is configured")
	ErrDisconnected  = errors.New("discord: the gateway is not connected")
	ErrBadToken      = errors.New("discord: Discord rejected the bot token")
	ErrNoLogin       = errors.New("discord: Discord sign-in needs the application's client secret")
)

// Seed holds credentials from the environment or config file that fill the secrets store when it has none
type Seed struct {
	BotToken     string
	ClientSecret string
}

// Deps are the subsystems the mirror reads from and writes to
type Deps struct {
	Ent      *ent.Client
	Timeline *timeline.Service
	Identity *identity.Service
	Authz    *authz.Service
	Secrets  *config.Secrets
	Settings *store.Settings
	Invoker  *capability.Invoker
	Registry *capability.Registry
	Cards    *extension.Registry
	Presence *presence.Tracker
	Seed     Seed
	Log      *slog.Logger
}

// Service runs the gateway connection and both mirror directions
type Service struct {
	Deps

	mu          sync.RWMutex
	client      *bot.Client
	state       string
	lastErr     string
	appID       snowflake.ID
	botUser     dg.User
	connectedAt time.Time
	commands    []string
	stop        context.CancelFunc

	locks    sync.Map
	webhooks sync.Map
	kicks    chan struct{}
	dirtyMu  sync.Mutex
	dirty    map[string]struct{}
	retryAt  map[string]time.Time
	typingMu sync.Mutex
	typingAt map[snowflake.ID]time.Time
	noticeMu sync.Mutex
	notices  map[string]time.Time
	resyncMu sync.Mutex
	resyncs  map[snowflake.ID]*time.Timer
}

// New builds the mirror without connecting
func New(d Deps) *Service {
	s := &Service{
		Deps:     d,
		state:    StateDisconnected,
		kicks:    make(chan struct{}, 1),
		dirty:    map[string]struct{}{},
		retryAt:  map[string]time.Time{},
		typingAt: map[snowflake.ID]time.Time{},
		notices:  map[string]time.Time{},
		resyncs:  map[snowflake.ID]*time.Timer{},
	}
	d.Timeline.SetThreadCreator(s)
	d.Identity.SetDiscordLogin(s.loginConfigured())
	return s
}

func (s *Service) loginConfigured() bool {
	return s.tokenPresent() && s.secretPresent()
}

// Start stores seeded credentials the secrets file lacks, then connects when a token is stored
func (s *Service) Start(ctx context.Context) {
	token, secret := pendingSeed(s.tokenPresent(), s.secretPresent(), s.Seed)
	if token != "" || secret != "" {
		go s.applySeed(ctx, token, secret)
		return
	}
	if !s.tokenPresent() {
		return
	}
	go s.connect(ctx)
}

// pendingSeed picks the seeded values that fill an empty slot, a seed never replaces a stored credential
func pendingSeed(haveToken, haveSecret bool, seed Seed) (token, secret string) {
	if !haveToken {
		token = strings.TrimSpace(seed.BotToken)
	}
	if !haveSecret && (haveToken || token != "") {
		secret = strings.TrimSpace(seed.ClientSecret)
	}
	return token, secret
}

// applySeed validates and stores seeded credentials through Configure, reporting a rejected token in status and the audit channel
func (s *Service) applySeed(ctx context.Context, token, secret string) {
	if err := s.Configure(ctx, token, secret); err != nil {
		text := "The bot token from DISCOFLIX_DISCORD_BOT_TOKEN was rejected: " + err.Error()
		s.setState(StateFailed, text)
		s.audit(ctx, "seed", "Discord seed rejected", text, cardv1.Severity_SEVERITY_ERROR)
		return
	}
	s.Log.Info("discord credentials seeded from the environment", "token", token != "", "client_secret", secret != "")
}

func (s *Service) secretPresent() bool {
	v, ok := s.Secrets.Get(SecretClientSecret)
	return ok && v != ""
}

// Run drives outbound mirroring from timeline events and a periodic full pass until ctx ends
func (s *Service) Run(ctx context.Context) error {
	sub := s.Timeline.Subscribe()
	defer sub.Close()
	t := time.NewTicker(45 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.disconnect()
			return nil
		case ev, open := <-sub.C:
			if !open {
				sub = s.Timeline.Subscribe()
				s.markAllDirty(ctx)
				continue
			}
			s.onTimelineEvent(ctx, ev)
		case <-s.kicks:
			s.flushDirty(ctx)
		case <-t.C:
			s.markAllDirty(ctx)
			s.flushDirty(ctx)
		}
	}
}

func (s *Service) setState(state, errText string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state = state
	s.lastErr = errText
	if state == StateConnected {
		s.connectedAt = time.Now()
	}
}

// connect opens the gateway with every listener attached, reporting portal problems in status
func (s *Service) connect(ctx context.Context) {
	token, ok := s.Secrets.Get(SecretBotToken)
	if !ok || token == "" {
		s.setState(StateDisconnected, "")
		return
	}
	s.disconnect()
	runCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.stop = cancel
	s.state = StateConnecting
	s.lastErr = ""
	s.mu.Unlock()
	client, err := disgo.New(token,
		bot.WithLogger(s.Log.With("component", "disgo")),
		bot.WithGatewayConfigOpts(
			dgw.WithIntents(intents),
			dgw.WithCloseHandler(func(_ dgw.Gateway, err error, reconnect bool) {
				if reconnect {
					s.setState(StateConnecting, err.Error())
					return
				}
				s.setState(StateFailed, explainClose(err))
			}),
		),
		bot.WithCacheConfigOpts(cache.WithCaches(cache.FlagsAll)),
		bot.WithMemberChunkingFilter(bot.MemberChunkingFilterAll),
		bot.WithEventListeners(s.listeners(runCtx)),
	)
	if err != nil {
		cancel()
		s.setState(StateFailed, err.Error())
		return
	}
	s.mu.Lock()
	s.client = client
	s.mu.Unlock()
	if err := client.OpenGateway(runCtx); err != nil {
		cancel()
		s.setState(StateFailed, explainClose(err))
		return
	}
}

// explainClose turns gateway close reasons into instructions an administrator can act on
func explainClose(err error) string {
	text := err.Error()
	switch {
	case strings.Contains(text, "4014"):
		return "Discord refused the privileged intents. Enable Server Members Intent, Presence Intent, and Message Content Intent for the bot in the Discord developer portal, then reconnect."
	case strings.Contains(text, "4004"):
		return "Discord rejected the bot token. Reset the token in the developer portal and configure it again."
	case strings.Contains(text, "4013"):
		return "Discord reported invalid intents, which means this build asked for something the API no longer offers."
	}
	return text
}

func (s *Service) disconnect() {
	s.mu.Lock()
	client, stop := s.client, s.stop
	s.client, s.stop = nil, nil
	s.state = StateDisconnected
	s.connectedAt = time.Time{}
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
	if client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client.Close(ctx)
	}
}

// Configure validates and stores credentials, then reconnects
func (s *Service) Configure(ctx context.Context, botToken, clientSecret string) error {
	botToken = strings.TrimSpace(botToken)
	clientSecret = strings.TrimSpace(clientSecret)
	if botToken == "" {
		if _, ok := s.Secrets.Get(SecretBotToken); !ok {
			return ErrNotConfigured
		}
	}
	if botToken != "" {
		app, err := rest.New(rest.NewClient(botToken)).GetBotApplicationInfo(rest.WithCtx(ctx))
		if err != nil {
			return fmt.Errorf("%w: %w", ErrBadToken, err)
		}
		if err := s.Secrets.Set(SecretBotToken, botToken); err != nil {
			return err
		}
		if err := s.Settings.Set(ctx, SettingAppID, app.ID.String()); err != nil {
			return err
		}
		s.mu.Lock()
		s.appID = app.ID
		s.mu.Unlock()
	}
	if clientSecret != "" {
		if err := s.Secrets.Set(SecretClientSecret, clientSecret); err != nil {
			return err
		}
	}
	s.Identity.SetDiscordLogin(s.loginConfigured())
	go s.connect(context.WithoutCancel(ctx))
	return nil
}

// Forget drops the stored credentials and closes the gateway, mirrored history stays
func (s *Service) Forget(ctx context.Context) error {
	s.disconnect()
	if err := s.Secrets.Set(SecretBotToken, ""); err != nil {
		return err
	}
	if err := s.Secrets.Set(SecretClientSecret, ""); err != nil {
		return err
	}
	s.Identity.SetDiscordLogin(false)
	_, err := s.Timeline.PostSystem(ctx, "audit", "Discord was disconnected and its credentials forgotten", &cardv1.SystemNotice{Title: "Discord disconnected", Body: "The bot token and client secret were removed. Mirrored history stays readable.", Severity: cardv1.Severity_SEVERITY_WARNING})
	return err
}

func (s *Service) tokenPresent() bool {
	v, ok := s.Secrets.Get(SecretBotToken)
	return ok && v != ""
}

// Client returns the connected gateway client or ErrDisconnected
func (s *Service) Client() (*bot.Client, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.client == nil || s.state != StateConnected {
		return nil, ErrDisconnected
	}
	return s.client, nil
}

// ApplicationID returns the application id learned from the token
func (s *Service) ApplicationID(ctx context.Context) (snowflake.ID, error) {
	s.mu.RLock()
	id := s.appID
	s.mu.RUnlock()
	if id != 0 {
		return id, nil
	}
	raw, err := s.Settings.GetString(ctx, SettingAppID, "")
	if err != nil || raw == "" {
		return 0, ErrNotConfigured
	}
	parsed, err := snowflake.Parse(raw)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	s.appID = parsed
	s.mu.Unlock()
	return parsed, nil
}

// RedirectURL is the OAuth2 redirect the developer portal must list
func (s *Service) RedirectURL() string {
	base := s.Identity.LinkBase()
	if base == "" {
		return ""
	}
	return base + "/auth/discord/callback"
}

// InviteURL adds the bot to a guild with the permissions the mirror needs
func (s *Service) InviteURL(ctx context.Context) string {
	id, err := s.ApplicationID(ctx)
	if err != nil {
		return ""
	}
	q := url.Values{}
	q.Set("client_id", id.String())
	q.Set("scope", "bot applications.commands")
	q.Set("permissions", strconv.FormatInt(int64(botPermissions), 10))
	return "https://discord.com/oauth2/authorize?" + q.Encode()
}

// Status reports the connection, bot identity, guilds, and commands for the admin page
func (s *Service) Status(ctx context.Context) *discordv1.DiscordStatus {
	s.mu.RLock()
	st := &discordv1.DiscordStatus{
		Configured:   s.tokenPresent(),
		State:        s.state,
		Error:        s.lastErr,
		BotUsername:  s.botUser.Username,
		LoginEnabled: s.loginConfigured(),
		Commands:     append([]string(nil), s.commands...),
	}
	if s.botUser.ID != 0 {
		st.BotAvatarUrl = s.botUser.EffectiveAvatarURL(dg.WithSize(128))
	}
	if !s.connectedAt.IsZero() {
		st.ConnectedAt = stamp(s.connectedAt)
	}
	client := s.client
	s.mu.RUnlock()
	if id, err := s.ApplicationID(ctx); err == nil {
		st.ApplicationId = id.String()
	}
	st.InviteUrl = s.InviteURL(ctx)
	st.RedirectUrl = s.RedirectURL()
	if !st.GetConfigured() {
		st.State = StateDisconnected
	}
	if client == nil {
		return st
	}
	for g := range client.Caches.Guilds() {
		gs := &discordv1.DiscordGuild{Id: g.ID.String(), Name: g.Name, MemberCount: int32(g.MemberCount), Available: !client.Caches.IsGuildUnavailable(g.ID)}
		if icon := g.IconURL(dg.WithSize(128)); icon != nil {
			gs.IconUrl = *icon
		}
		if sp, err := s.Timeline.SpaceByExternalID(ctx, "guild", g.ID.String()); err == nil {
			gs.SpaceId = sp.ID
			gs.ApprovalsChannelId = sp.ApprovalsChannelID
		}
		st.Guilds = append(st.Guilds, gs)
	}
	return st
}

// listeners wires every gateway event the mirror consumes
func (s *Service) listeners(ctx context.Context) *events.ListenerAdapter {
	return &events.ListenerAdapter{
		OnReady: func(e *events.Ready) {
			s.mu.Lock()
			s.botUser = e.User.User
			s.appID = e.Application.ID
			s.mu.Unlock()
			s.setState(StateConnected, "")
			go s.registerCommands(ctx)
			s.Log.Info("discord connected", "bot", e.User.Username, "guilds", len(e.Guilds))
		},
		OnResumed: func(*events.Resumed) {
			s.setState(StateConnected, "")
			s.markAllDirty(ctx)
			s.kick()
		},
		OnGuildReady:         func(e *events.GuildReady) { go s.syncGuild(ctx, e.Client(), e.GuildID) },
		OnGuildJoin:          func(e *events.GuildJoin) { go s.syncGuild(ctx, e.Client(), e.GuildID) },
		OnGuildUpdate:        func(e *events.GuildUpdate) { go s.syncGuildHeader(ctx, e.Client(), e.GuildID) },
		OnGuildLeave:         func(e *events.GuildLeave) { s.onGuildLeave(ctx, e) },
		OnGuildChannelCreate: func(e *events.GuildChannelCreate) { s.onChannel(ctx, e.Client(), e.Channel) },
		OnGuildChannelUpdate: func(e *events.GuildChannelUpdate) { s.onChannel(ctx, e.Client(), e.Channel) },
		OnGuildChannelDelete: func(e *events.GuildChannelDelete) { s.onChannelDelete(ctx, e.ChannelID) },
		OnThreadCreate:       func(e *events.ThreadCreate) { s.onThread(ctx, e.Client(), e.Thread) },
		OnThreadUpdate:       func(e *events.ThreadUpdate) { s.onThread(ctx, e.Client(), e.Thread) },
		OnThreadShow:         func(e *events.ThreadShow) { s.onThread(ctx, e.Client(), e.Thread) },
		OnThreadDelete:       func(e *events.ThreadDelete) { s.onChannelDelete(ctx, e.ThreadID) },
		OnThreadHide:         func(e *events.ThreadHide) { s.onChannelDelete(ctx, e.ThreadID) },
		OnRoleCreate:         func(e *events.RoleCreate) { s.scheduleResync(ctx, e.Client(), e.GuildID) },
		OnRoleUpdate:         func(e *events.RoleUpdate) { s.scheduleResync(ctx, e.Client(), e.GuildID) },
		OnRoleDelete:         func(e *events.RoleDelete) { s.scheduleResync(ctx, e.Client(), e.GuildID) },
		OnGuildMemberJoin:    func(e *events.GuildMemberJoin) { s.onMember(ctx, e.Client(), e.Member) },
		OnGuildMemberUpdate:  func(e *events.GuildMemberUpdate) { s.onMember(ctx, e.Client(), e.Member) },
		OnGuildMemberLeave:   func(e *events.GuildMemberLeave) { s.onMemberLeave(ctx, e) },
		OnUserUpdate:         func(e *events.UserUpdate) { s.onUserUpdate(ctx, e.User) },
		OnGuildMessageCreate: func(e *events.GuildMessageCreate) { s.onMessage(ctx, e.Client(), e.Message) },
		OnGuildMessageUpdate: func(e *events.GuildMessageUpdate) { s.onMessageUpdate(ctx, e.Client(), e.Message) },
		OnGuildMessageDelete: func(e *events.GuildMessageDelete) { s.onMessageDelete(ctx, e.MessageID) },
		OnGuildMessageReactionAdd: func(e *events.GuildMessageReactionAdd) {
			s.onReaction(ctx, e.Client(), e.GenericGuildMessageReaction, true)
		},
		OnGuildMessageReactionRemove: func(e *events.GuildMessageReactionRemove) {
			s.onReaction(ctx, e.Client(), e.GenericGuildMessageReaction, false)
		},
		OnGuildMessageReactionRemoveEmoji: func(e *events.GuildMessageReactionRemoveEmoji) {
			s.onReactionsCleared(ctx, e.MessageID, e.Emoji.Reaction())
		},
		OnGuildMessageReactionRemoveAll: func(e *events.GuildMessageReactionRemoveAll) {
			s.onReactionsCleared(ctx, e.MessageID, "")
		},
		OnGuildMemberTypingStart:        func(e *events.GuildMemberTypingStart) { s.onTyping(ctx, e) },
		OnPresenceUpdate:                func(e *events.PresenceUpdate) { s.onPresence(ctx, e.Presence) },
		OnApplicationCommandInteraction: func(e *events.ApplicationCommandInteractionCreate) { go s.onCommand(ctx, e) },
		OnComponentInteraction:          func(e *events.ComponentInteractionCreate) { go s.onComponent(ctx, e) },
	}
}

// guildLock serializes structural changes for one guild so concurrent events never create duplicate rows
func (s *Service) guildLock(id snowflake.ID) *sync.Mutex {
	v, _ := s.locks.LoadOrStore(id, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// audit posts a notice to the system audit channel, at most once per key per hour
func (s *Service) audit(ctx context.Context, key, title, body string, severity cardv1.Severity) {
	s.noticeMu.Lock()
	last, seen := s.notices[key]
	if seen && time.Since(last) < time.Hour {
		s.noticeMu.Unlock()
		return
	}
	s.notices[key] = time.Now()
	s.noticeMu.Unlock()
	if _, err := s.Timeline.PostSystem(ctx, "audit", title, &cardv1.SystemNotice{Title: title, Body: body, Severity: severity}); err != nil {
		s.Log.Error("audit notice failed", "title", title, "error", err)
	}
}

// principalFor resolves the DiscoFlix principal behind a Discord user, creating the user on first contact
func (s *Service) principalFor(ctx context.Context, u dg.User) (capability.Principal, error) {
	user, _, err := s.Identity.EnsureExternalUser(ctx, externalUser(u))
	if err != nil {
		return capability.Principal{}, err
	}
	return capability.Principal{UserID: user.ID, DisplayName: user.DisplayName, Kind: string(user.Kind), Via: Provider, SystemAdmin: user.SystemAdmin}, nil
}

func externalUser(u dg.User) identity.ExternalUser {
	return identity.ExternalUser{Provider: Provider, Subject: u.ID.String(), DisplayName: u.EffectiveName(), AvatarURL: u.EffectiveAvatarURL(dg.WithSize(256)), Bot: u.Bot || u.System}
}
