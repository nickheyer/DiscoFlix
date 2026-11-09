// Package identity owns users, identities, credentials, sessions, and the audit of all of them
package identity

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	connect "connectrpc.com/connect/v2"
	"github.com/alexedwards/scs/v2"
	"github.com/sethvargo/go-limiter"
	"github.com/sethvargo/go-limiter/memorystore"
	"golang.org/x/crypto/argon2"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/config"
	"github.com/nickheyer/DiscoFlix/internal/store"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/credential"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/identity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

var (
	ErrInvalidCredentials  = errors.New("identity: invalid credentials")
	ErrAlreadyBootstrapped = errors.New("identity: already bootstrapped")
	ErrNoSession           = errors.New("identity: no session on this transport")
	ErrRateLimited         = errors.New("identity: too many attempts")
	ErrNotFound            = errors.New("identity: not found")
	ErrLastAdmin           = errors.New("identity: the last administrator cannot be demoted or disabled")
	ErrDisabled            = errors.New("identity: account disabled")
	ErrWeakPassword        = errors.New("identity: password must be at least 12 characters")
)

// Build identifies the running binary in server info and audit cards
type Build struct {
	Version string
	Commit  string
}

// Meta carries the caller's transport details into audit cards
type Meta struct {
	RemoteAddr string
	UserAgent  string
}

// Flusher applies staged authorization tuples after commit
type Flusher interface {
	Flush(ctx context.Context) error
}

// Service implements sign-in, credentials, sessions, and user administration
type Service struct {
	ent          *ent.Client
	settings     *store.Settings
	authz        Flusher
	tl           *timeline.Service
	sessions     *scs.SessionManager
	sessionStore *sessionStore
	pepper       []byte
	build        Build
	log          *slog.Logger
	loginLimit   limiter.Store
	ceremonies   *ceremonyStore
	links        *linkCodes
	publicURL    string
	linkBase     string

	mu           sync.RWMutex
	discordLogin bool
}

// Open prepares the session store, pepper, and limiter
func Open(ctx context.Context, dataDir string, secrets *config.Secrets, entc *ent.Client, flusher Flusher, tl *timeline.Service, build Build, secureCookies bool, log *slog.Logger) (*Service, error) {
	pepperHex, err := secrets.GetOrCreate("security.pepper", func() (string, error) {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		return hex.EncodeToString(b), nil
	})
	if err != nil {
		return nil, fmt.Errorf("identity: pepper: %w", err)
	}
	pepper, err := hex.DecodeString(pepperHex)
	if err != nil {
		return nil, fmt.Errorf("identity: pepper: %w", err)
	}
	st, err := openSessionStore(ctx, dataDir)
	if err != nil {
		return nil, err
	}
	lim, err := memorystore.New(&memorystore.Config{Tokens: 10, Interval: time.Minute})
	if err != nil {
		_ = st.db.Close()
		return nil, err
	}
	return &Service{
		ent:          entc,
		settings:     store.NewSettings(entc),
		authz:        flusher,
		tl:           tl,
		sessions:     newSessionManager(st, secureCookies),
		sessionStore: st,
		pepper:       pepper,
		build:        build,
		log:          log,
		loginLimit:   lim,
		ceremonies:   newCeremonyStore(),
		links:        newLinkCodes(),
	}, nil
}

// SetPublicURL fixes the origin used for passkeys and links when the server sits behind a proxy
func (s *Service) SetPublicURL(u string) { s.publicURL = strings.TrimRight(u, "/") }

// SetLinkBase sets the address used for links when no public URL is configured
func (s *Service) SetLinkBase(u string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.linkBase = strings.TrimRight(u, "/")
}

// SetDiscordLogin toggles whether server info advertises Discord sign-in
func (s *Service) SetDiscordLogin(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.discordLogin = enabled
}

// DiscordLogin reports whether Discord sign-in is configured
func (s *Service) DiscordLogin() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.discordLogin
}

// Close releases the session database and the limiter
func (s *Service) Close() error {
	_ = s.loginLimit.Close(context.Background())
	return s.sessionStore.db.Close()
}

// Middleware loads and saves the cookie session around every request
func (s *Service) Middleware(next http.Handler) http.Handler {
	return s.sessions.LoadAndSave(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionLoadedKey{}, true)))
	}))
}

// Run sweeps expired sessions until ctx ends
func (s *Service) Run(ctx context.Context) error {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if err := s.sessionStore.cleanup(ctx); err != nil {
			s.log.Warn("session cleanup failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// SetupRequired reports whether no person has been created yet
func (s *Service) SetupRequired(ctx context.Context) (bool, error) {
	exists, err := s.ent.User.Query().Where(user.KindEQ(user.KindPerson)).Exist(ctx)
	return !exists, err
}

// InstanceName returns the configured display name of this server
func (s *Service) InstanceName(ctx context.Context) (string, error) {
	return s.settings.GetString(ctx, "instance.name", "DiscoFlix")
}

// Build returns version information
func (s *Service) Build() Build { return s.build }

// Authenticate resolves an API key header or the cookie session into a principal
func (s *Service) Authenticate(ctx context.Context, info *connect.CallInfo) (capability.Principal, error) {
	if info != nil {
		if key := apiKeyFrom(info.RequestHeader().Get("Authorization"), info.RequestHeader().Get("X-Api-Key")); key != "" {
			return s.authenticateAPIKey(ctx, key)
		}
	}
	return s.authenticateSession(ctx)
}

// AuthenticateHTTP resolves the principal of a plain HTTP request such as a WebSocket upgrade
func (s *Service) AuthenticateHTTP(r *http.Request) (capability.Principal, error) {
	if key := apiKeyFrom(r.Header.Get("Authorization"), r.Header.Get("X-Api-Key")); key != "" {
		return s.authenticateAPIKey(r.Context(), key)
	}
	return s.authenticateSession(r.Context())
}

func apiKeyFrom(authorization, header string) string {
	if header != "" {
		return header
	}
	if rest, ok := strings.CutPrefix(authorization, "Bearer "); ok && strings.HasPrefix(rest, "dfx_") {
		return rest
	}
	return ""
}

func (s *Service) authenticateSession(ctx context.Context) (capability.Principal, error) {
	if !sessionLoaded(ctx) {
		return capability.Principal{}, capability.ErrNoCredentials
	}
	uid := s.sessions.GetString(ctx, "user_id")
	if uid == "" {
		return capability.Principal{}, capability.ErrNoCredentials
	}
	u, err := s.resolve(ctx, uid)
	if errors.Is(err, ErrNotFound) {
		_ = s.sessions.Destroy(ctx)
		return capability.Principal{}, capability.ErrNoCredentials
	}
	if err != nil {
		return capability.Principal{}, err
	}
	if u.Status != user.StatusActive {
		_ = s.sessions.Destroy(ctx)
		return capability.Principal{}, ErrDisabled
	}
	return principalFor(u, "session", hashToken(s.sessions.Token(ctx))), nil
}

func (s *Service) authenticateAPIKey(ctx context.Context, key string) (capability.Principal, error) {
	kid, secret, ok := splitAPIKey(key)
	if !ok {
		return capability.Principal{}, ErrInvalidCredentials
	}
	cred, err := s.ent.Credential.Query().Where(credential.KindEQ(credential.KindApikey), credential.Prefix(kid)).Only(ctx)
	if ent.IsNotFound(err) {
		return capability.Principal{}, ErrInvalidCredentials
	}
	if err != nil {
		return capability.Principal{}, err
	}
	if subtle.ConstantTimeCompare(cred.SecretHash, s.mac(secret)) != 1 {
		return capability.Principal{}, ErrInvalidCredentials
	}
	if cred.ExpiresAt != nil && cred.ExpiresAt.Before(time.Now()) {
		return capability.Principal{}, ErrInvalidCredentials
	}
	u, err := s.resolve(ctx, cred.UserID)
	if err != nil {
		return capability.Principal{}, err
	}
	if u.Status != user.StatusActive {
		return capability.Principal{}, ErrDisabled
	}
	if cred.LastUsedAt == nil || time.Since(*cred.LastUsedAt) > time.Minute {
		_ = s.ent.Credential.UpdateOneID(cred.ID).SetLastUsedAt(time.Now()).Exec(ctx)
	}
	return principalFor(u, "apikey", cred.ID), nil
}

func principalFor(u *ent.User, via, sessionID string) capability.Principal {
	return capability.Principal{UserID: u.ID, DisplayName: u.DisplayName, Kind: string(u.Kind), Via: via, SessionID: sessionID, SystemAdmin: u.SystemAdmin}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (s *Service) mac(secret string) []byte {
	m := hmac.New(sha256.New, s.pepper)
	m.Write([]byte(secret))
	return m.Sum(nil)
}

// BootstrapInput creates the first administrator
type BootstrapInput struct {
	Username     string
	DisplayName  string
	Password     string
	InstanceName string
}

// Bootstrap creates the first administrator, joins them to the system space, and signs them in
func (s *Service) Bootstrap(ctx context.Context, in BootstrapInput, meta Meta) (*ent.User, error) {
	if !sessionLoaded(ctx) {
		return nil, ErrNoSession
	}
	required, err := s.SetupRequired(ctx)
	if err != nil {
		return nil, err
	}
	if !required {
		return nil, ErrAlreadyBootstrapped
	}
	if len(in.Password) < 12 {
		return nil, ErrWeakPassword
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		return nil, err
	}
	username := strings.ToLower(strings.TrimSpace(in.Username))
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	u, err := tx.User.Create().SetDisplayName(in.DisplayName).SetKind(user.KindPerson).SetSystemAdmin(true).Save(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if _, err := tx.Identity.Create().SetUserID(u.ID).SetProvider("local").SetSubject(username).SetDisplay(username).SetVerifiedAt(now).SetLinkedAt(now).Save(ctx); err != nil {
		return nil, err
	}
	if _, err := tx.Credential.Create().SetUserID(u.ID).SetKind(credential.KindPassword).SetSecretHash(hash).Save(ctx); err != nil {
		return nil, err
	}
	if err := authz.Stage(ctx, tx, authz.Write(authz.SystemObject, "admin", "user:"+u.ID), authz.Write(authz.SystemObject, "member", "user:"+u.ID)); err != nil {
		return nil, err
	}
	if err := timeline.Join(ctx, tx, u.ID, s.tl.SystemSpaceID(), "admin"); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if err := s.authz.Flush(ctx); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(in.InstanceName)
	if name == "" {
		name = "DiscoFlix"
	}
	if err := s.settings.Set(ctx, "instance.name", name); err != nil {
		return nil, err
	}
	if err := s.tl.RenameSystemSpace(ctx, name); err != nil {
		return nil, err
	}
	if err := s.login(ctx, u, "password", meta); err != nil {
		return nil, err
	}
	s.audit(ctx, u, "bootstrap", "password", meta, u.DisplayName+" created this server and became its first administrator")
	s.welcome(ctx, name)
	return u, nil
}

// welcome posts one notice to #general telling the first administrator where the server is and what to set up next
func (s *Service) welcome(ctx context.Context, name string) {
	var b strings.Builder
	if base := s.LinkBase(); base != "" {
		fmt.Fprintf(&b, "This server is listening at %s. Open that address in any browser on your network to sign in. The desktop window shows the same site.\n\n", base)
	}
	b.WriteString("Next steps\n")
	b.WriteString("1. Settings > Discord connects your bot so this space mirrors your guild.\n")
	b.WriteString("2. Settings > Catalog holds the metadata snapshot, bulk datasets, and provider keys.\n")
	b.WriteString("3. #audit records every boot, sign-in, and update.")
	if _, err := s.tl.PostSystem(ctx, "general", "Welcome to "+name, &cardv1.SystemNotice{Title: "Welcome to " + name, Body: b.String(), Severity: cardv1.Severity_SEVERITY_SUCCESS}); err != nil {
		s.log.Error("welcome post failed", "error", err)
	}
}

// LoginWithPassword verifies a local identity and starts a session
func (s *Service) LoginWithPassword(ctx context.Context, username, password string, meta Meta) (*ent.User, error) {
	if !sessionLoaded(ctx) {
		return nil, ErrNoSession
	}
	if _, _, _, ok, err := s.loginLimit.Take(ctx, "login:"+meta.RemoteAddr); err != nil || !ok {
		if err != nil {
			return nil, err
		}
		return nil, ErrRateLimited
	}
	id, err := s.ent.Identity.Query().Where(identity.Provider("local"), identity.Subject(strings.ToLower(strings.TrimSpace(username)))).WithUser().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, err
	}
	cred, err := s.ent.Credential.Query().Where(credential.UserID(id.UserID), credential.KindEQ(credential.KindPassword)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, err
	}
	if !verifyPassword(cred.SecretHash, password) {
		return nil, ErrInvalidCredentials
	}
	u := id.Edges.User
	if u.Status != user.StatusActive {
		return nil, ErrDisabled
	}
	if err := s.login(ctx, u, "password", meta); err != nil {
		return nil, err
	}
	s.audit(ctx, u, "login", "password", meta, u.DisplayName+" signed in with a password")
	return u, nil
}

// login binds the session to the user with a fresh token
func (s *Service) login(ctx context.Context, u *ent.User, via string, meta Meta) error {
	if err := s.sessions.RenewToken(ctx); err != nil {
		return err
	}
	s.sessions.Put(ctx, "user_id", u.ID)
	s.sessions.Put(ctx, "via", via)
	s.sessions.Put(ctx, "created_at", time.Now())
	s.sessions.Put(ctx, "user_agent", meta.UserAgent)
	s.sessions.Put(ctx, "remote_addr", meta.RemoteAddr)
	return s.ent.User.UpdateOneID(u.ID).SetLastSeenAt(time.Now()).Exec(ctx)
}

// Logout destroys the current session
func (s *Service) Logout(ctx context.Context, p capability.Principal, meta Meta) error {
	if !sessionLoaded(ctx) {
		return ErrNoSession
	}
	if err := s.sessions.Destroy(ctx); err != nil {
		return err
	}
	if u, err := s.ent.User.Get(ctx, p.UserID); err == nil {
		s.audit(ctx, u, "logout", p.Via, meta, u.DisplayName+" signed out")
	}
	return nil
}

// GetUser loads one user, following merges to the survivor
func (s *Service) GetUser(ctx context.Context, id string) (*ent.User, error) {
	return s.resolve(ctx, id)
}

// Identities lists the linked identities of a user
func (s *Service) Identities(ctx context.Context, userID string) ([]*ent.Identity, error) {
	return s.ent.Identity.Query().Where(identity.UserID(userID)).Order(ent.Asc(identity.FieldCreatedAt)).All(ctx)
}

// Memberships lists the space memberships of a user
func (s *Service) Memberships(ctx context.Context, userID string) ([]*ent.Membership, error) {
	return s.ent.User.Query().Where(user.ID(userID)).QueryMemberships().All(ctx)
}

// ChangePassword verifies the current password and stores a new hash
func (s *Service) ChangePassword(ctx context.Context, p capability.Principal, current, next string, meta Meta) error {
	if len(next) < 12 {
		return ErrWeakPassword
	}
	cred, err := s.ent.Credential.Query().Where(credential.UserID(p.UserID), credential.KindEQ(credential.KindPassword)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrInvalidCredentials
	}
	if err != nil {
		return err
	}
	if !verifyPassword(cred.SecretHash, current) {
		return ErrInvalidCredentials
	}
	hash, err := hashPassword(next)
	if err != nil {
		return err
	}
	if err := s.ent.Credential.UpdateOneID(cred.ID).SetSecretHash(hash).Exec(ctx); err != nil {
		return err
	}
	if u, err := s.ent.User.Get(ctx, p.UserID); err == nil {
		s.audit(ctx, u, "password_changed", p.Via, meta, u.DisplayName+" changed their password")
	}
	return nil
}

// SessionInfo describes one stored session of a user
type SessionInfo struct {
	ID         string
	UserAgent  string
	RemoteAddr string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	Current    bool
}

// ListSessions decodes every live session belonging to the user
func (s *Service) ListSessions(ctx context.Context, p capability.Principal) ([]SessionInfo, error) {
	all, err := s.sessionStore.All()
	if err != nil {
		return nil, err
	}
	var out []SessionInfo
	for token, data := range all {
		deadline, values, err := scs.GobCodec{}.Decode(data)
		if err != nil {
			continue
		}
		if uid, _ := values["user_id"].(string); uid != p.UserID {
			continue
		}
		created, _ := values["created_at"].(time.Time)
		ua, _ := values["user_agent"].(string)
		addr, _ := values["remote_addr"].(string)
		out = append(out, SessionInfo{ID: token, UserAgent: ua, RemoteAddr: addr, CreatedAt: created, ExpiresAt: deadline, Current: token == p.SessionID})
	}
	return out, nil
}

// RevokeSession deletes one of the caller's sessions by id
func (s *Service) RevokeSession(ctx context.Context, p capability.Principal, id string, meta Meta) error {
	data, found, err := s.sessionStore.Find(id)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	_, values, err := scs.GobCodec{}.Decode(data)
	if err != nil {
		return err
	}
	if uid, _ := values["user_id"].(string); uid != p.UserID {
		return ErrNotFound
	}
	if err := s.sessionStore.Delete(id); err != nil {
		return err
	}
	if u, err := s.ent.User.Get(ctx, p.UserID); err == nil {
		s.audit(ctx, u, "session_revoked", p.Via, meta, u.DisplayName+" revoked a session")
	}
	return nil
}

// CreateAPIKey mints a key shown once and stores its keyed hash
func (s *Service) CreateAPIKey(ctx context.Context, p capability.Principal, name string, expires *time.Time, meta Meta) (string, *ent.Credential, error) {
	kidRaw := make([]byte, 5)
	secretRaw := make([]byte, 32)
	if _, err := rand.Read(kidRaw); err != nil {
		return "", nil, err
	}
	if _, err := rand.Read(secretRaw); err != nil {
		return "", nil, err
	}
	kid := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(kidRaw))
	secret := base64.RawURLEncoding.EncodeToString(secretRaw)
	create := s.ent.Credential.Create().SetUserID(p.UserID).SetKind(credential.KindApikey).SetName(name).SetPrefix(kid).SetSecretHash(s.mac(secret))
	if expires != nil {
		create.SetExpiresAt(*expires)
	}
	cred, err := create.Save(ctx)
	if err != nil {
		return "", nil, err
	}
	if u, err := s.ent.User.Get(ctx, p.UserID); err == nil {
		s.audit(ctx, u, "apikey_created", p.Via, meta, u.DisplayName+" created the API key "+name)
	}
	return "dfx_" + kid + "_" + secret, cred, nil
}

func splitAPIKey(key string) (kid, secret string, ok bool) {
	rest, ok := strings.CutPrefix(key, "dfx_")
	if !ok {
		return "", "", false
	}
	kid, secret, ok = strings.Cut(rest, "_")
	return kid, secret, ok && kid != "" && secret != ""
}

// ListAPIKeys returns the caller's keys without secrets
func (s *Service) ListAPIKeys(ctx context.Context, p capability.Principal) ([]*ent.Credential, error) {
	return s.ent.Credential.Query().Where(credential.UserID(p.UserID), credential.KindEQ(credential.KindApikey)).Order(ent.Asc(credential.FieldCreatedAt)).All(ctx)
}

// RevokeAPIKey deletes one of the caller's keys
func (s *Service) RevokeAPIKey(ctx context.Context, p capability.Principal, id string, meta Meta) error {
	n, err := s.ent.Credential.Delete().Where(credential.ID(id), credential.UserID(p.UserID), credential.KindEQ(credential.KindApikey)).Exec(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	if u, err := s.ent.User.Get(ctx, p.UserID); err == nil {
		s.audit(ctx, u, "apikey_revoked", p.Via, meta, u.DisplayName+" revoked an API key")
	}
	return nil
}

// ListUsers returns every user that is not hidden behind a merge, ordered by creation
func (s *Service) ListUsers(ctx context.Context) ([]*ent.User, error) {
	return s.ent.User.Query().Where(user.MergedIntoIDIsNil()).Order(ent.Asc(user.FieldCreatedAt)).All(ctx)
}

// UserUpdate carries administrator edits
type UserUpdate struct {
	DisplayName string
	Status      user.Status
	SystemAdmin bool
}

// UpdateUser applies administrator edits and keeps the admin tuples in step
func (s *Service) UpdateUser(ctx context.Context, actor capability.Principal, id string, in UserUpdate, meta Meta) (*ent.User, error) {
	u, err := s.GetUser(ctx, id)
	if err != nil {
		return nil, err
	}
	losingAdmin := u.SystemAdmin && (!in.SystemAdmin || in.Status == user.StatusDisabled)
	if losingAdmin {
		admins, err := s.ent.User.Query().Where(user.SystemAdmin(true), user.StatusEQ(user.StatusActive), user.IDNEQ(u.ID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		if admins == 0 {
			return nil, ErrLastAdmin
		}
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	upd := tx.User.UpdateOneID(u.ID).SetStatus(in.Status).SetSystemAdmin(in.SystemAdmin)
	if in.DisplayName != "" {
		upd.SetDisplayName(in.DisplayName)
	}
	updated, err := upd.Save(ctx)
	if err != nil {
		return nil, err
	}
	var ops []authz.Op
	switch {
	case in.SystemAdmin && !u.SystemAdmin:
		ops = append(ops, authz.Write(authz.SystemObject, "admin", "user:"+u.ID))
	case !in.SystemAdmin && u.SystemAdmin:
		ops = append(ops, authz.Delete(authz.SystemObject, "admin", "user:"+u.ID))
	}
	switch {
	case in.Status == user.StatusDisabled && u.Status == user.StatusActive:
		ops = append(ops, authz.Delete(authz.SystemObject, "member", "user:"+u.ID))
	case in.Status == user.StatusActive && u.Status == user.StatusDisabled:
		ops = append(ops, authz.Write(authz.SystemObject, "member", "user:"+u.ID))
	}
	if len(ops) > 0 {
		if err := authz.Stage(ctx, tx, ops...); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if err := s.authz.Flush(ctx); err != nil {
		return nil, err
	}
	if in.Status == user.StatusDisabled {
		s.revokeAllSessions(u.ID)
	}
	if actorUser, err := s.ent.User.Get(ctx, actor.UserID); err == nil {
		s.audit(ctx, actorUser, "user_updated", actor.Via, meta, actorUser.DisplayName+" updated "+updated.DisplayName)
	}
	return updated, nil
}

func (s *Service) revokeAllSessions(userID string) {
	all, err := s.sessionStore.All()
	if err != nil {
		return
	}
	for token, data := range all {
		if _, values, err := (scs.GobCodec{}).Decode(data); err == nil {
			if uid, _ := values["user_id"].(string); uid == userID {
				_ = s.sessionStore.Delete(token)
			}
		}
	}
}

// audit posts a security card to the system audit channel
func (s *Service) audit(ctx context.Context, u *ent.User, action, via string, meta Meta, content string) {
	_, err := s.tl.PostSystem(ctx, "audit", content, &cardv1.SecurityEvent{UserId: u.ID, Action: action, Via: via, RemoteAddr: meta.RemoteAddr, UserAgent: meta.UserAgent})
	if err != nil {
		s.log.Error("audit post failed", "action", action, "error", err)
	}
}

const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
)

// hashPassword produces a PHC formatted argon2id string
func hashPassword(password string) ([]byte, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return []byte(fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))), nil
}

// verifyPassword checks a password against a PHC argon2id string in constant time
func verifyPassword(encoded []byte, password string) bool {
	parts := strings.Split(string(encoded), "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}
