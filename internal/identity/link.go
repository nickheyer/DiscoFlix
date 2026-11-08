package identity

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/authz"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/credential"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/identity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/membership"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/usermerge"
	"github.com/nickheyer/DiscoFlix/internal/timeline"
)

var (
	ErrLastIdentity  = errors.New("identity: the last linked account cannot be removed")
	ErrNoPublicURL   = errors.New("identity: set --public-url so links can be built")
	ErrLinkExpired   = errors.New("identity: link code expired or already used")
	ErrNotExternal   = errors.New("identity: this account has no Discord identity to link")
	ErrMergeReverted = errors.New("identity: merge already reverted")
	ErrUnknownUser   = errors.New("identity: no DiscoFlix user is linked to this account")
)

// ExternalUser is a person or bot seen on a remote transport
type ExternalUser struct {
	Provider    string
	Subject     string
	DisplayName string
	AvatarURL   string
	Bot         bool
}

// UserByIdentity resolves the user behind a provider subject, following merges to the survivor
func (s *Service) UserByIdentity(ctx context.Context, provider, subject string) (*ent.User, error) {
	id, err := s.ent.Identity.Query().Where(identity.Provider(provider), identity.Subject(subject)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrUnknownUser
	}
	if err != nil {
		return nil, err
	}
	return s.resolve(ctx, id.UserID)
}

// resolve loads a user and follows merged_into to the surviving row
func (s *Service) resolve(ctx context.Context, id string) (*ent.User, error) {
	for range 8 {
		u, err := s.ent.User.Get(ctx, id)
		if ent.IsNotFound(err) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if u.MergedIntoID == "" {
			return u, nil
		}
		id = u.MergedIntoID
	}
	return nil, fmt.Errorf("identity: merge chain for %s is too deep", id)
}

// EnsureExternalUser returns the user for a remote account, creating one that is a system member on first sight
func (s *Service) EnsureExternalUser(ctx context.Context, in ExternalUser) (*ent.User, bool, error) {
	u, err := s.UserByIdentity(ctx, in.Provider, in.Subject)
	if err == nil {
		return u, false, s.refreshProfile(ctx, u, in)
	}
	if !errors.Is(err, ErrUnknownUser) {
		return nil, false, err
	}
	kind := user.KindPerson
	if in.Bot {
		kind = user.KindBot
	}
	name := strings.TrimSpace(in.DisplayName)
	if name == "" {
		name = in.Subject
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	u, err = tx.User.Create().SetDisplayName(truncate(name, 64)).SetKind(kind).SetAvatarURL(in.AvatarURL).Save(ctx)
	if err != nil {
		return nil, false, err
	}
	if _, err := tx.Identity.Create().SetUserID(u.ID).SetProvider(in.Provider).SetSubject(in.Subject).SetDisplay(name).SetLinkedAt(time.Now()).Save(ctx); err != nil {
		return nil, false, err
	}
	if err := authz.Stage(ctx, tx, authz.Write(authz.SystemObject, "member", "user:"+u.ID)); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return u, true, s.authz.Flush(ctx)
}

// refreshProfile follows the remote name and avatar while the remote account is the user's only identity
func (s *Service) refreshProfile(ctx context.Context, u *ent.User, in ExternalUser) error {
	name := truncate(strings.TrimSpace(in.DisplayName), 64)
	if name == "" {
		name = u.DisplayName
	}
	if u.DisplayName == name && u.AvatarURL == in.AvatarURL {
		return nil
	}
	n, err := s.ent.Identity.Query().Where(identity.UserID(u.ID)).Count(ctx)
	if err != nil {
		return err
	}
	upd := s.ent.User.UpdateOneID(u.ID)
	if n <= 1 {
		upd.SetDisplayName(name)
	}
	upd.SetAvatarURL(in.AvatarURL)
	if err := upd.Exec(ctx); err != nil {
		return err
	}
	if n <= 1 {
		u.DisplayName = name
	}
	u.AvatarURL = in.AvatarURL
	return nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// LoginUser starts a session for a user authenticated by an external provider
func (s *Service) LoginUser(ctx context.Context, u *ent.User, via string, meta Meta) error {
	if !sessionLoaded(ctx) {
		return ErrNoSession
	}
	if u.Status != user.StatusActive {
		return ErrDisabled
	}
	if err := s.login(ctx, u, via, meta); err != nil {
		return err
	}
	s.audit(ctx, u, "login", via, meta, u.DisplayName+" signed in with "+via)
	return nil
}

// MarkVerified records that the user proved control of the identity through the provider
func (s *Service) MarkVerified(ctx context.Context, provider, subject string) error {
	return s.ent.Identity.Update().Where(identity.Provider(provider), identity.Subject(subject)).SetVerifiedAt(time.Now()).Exec(ctx)
}

// LinkIdentity attaches a proven provider subject to a user, merging the user that already held it
func (s *Service) LinkIdentity(ctx context.Context, userID, provider, subject, display string, meta Meta) (*ent.Identity, bool, error) {
	target, err := s.resolve(ctx, userID)
	if err != nil {
		return nil, false, err
	}
	existing, err := s.ent.Identity.Query().Where(identity.Provider(provider), identity.Subject(subject)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, false, err
	}
	now := time.Now()
	if existing == nil {
		id, err := s.ent.Identity.Create().SetUserID(target.ID).SetProvider(provider).SetSubject(subject).SetDisplay(display).SetVerifiedAt(now).SetLinkedAt(now).Save(ctx)
		if err != nil {
			return nil, false, err
		}
		s.audit(ctx, target, "identity_linked", provider, meta, target.DisplayName+" linked their "+provider+" account "+display)
		return id, false, nil
	}
	owner, err := s.resolve(ctx, existing.UserID)
	if err != nil {
		return nil, false, err
	}
	if owner.ID == target.ID {
		id, err := s.ent.Identity.UpdateOneID(existing.ID).SetVerifiedAt(now).SetDisplay(display).Save(ctx)
		return id, false, err
	}
	if err := s.merge(ctx, owner, target); err != nil {
		return nil, false, err
	}
	id, err := s.ent.Identity.UpdateOneID(existing.ID).SetVerifiedAt(now).SetDisplay(display).Save(ctx)
	if err != nil {
		return nil, false, err
	}
	s.audit(ctx, target, "identity_linked", provider, meta, target.DisplayName+" linked their "+provider+" account "+display+", merging "+owner.DisplayName)
	return id, true, nil
}

// merge moves from's identities, credentials, and memberships onto into and hides from behind merged_into
func (s *Service) merge(ctx context.Context, from, into *ent.User) error {
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	identityIDs, err := tx.Identity.Query().Where(identity.UserID(from.ID)).IDs(ctx)
	if err != nil {
		return err
	}
	if err := tx.Identity.Update().Where(identity.UserID(from.ID)).SetUserID(into.ID).Exec(ctx); err != nil {
		return err
	}
	credentialIDs, err := tx.Credential.Query().Where(credential.UserID(from.ID)).IDs(ctx)
	if err != nil {
		return err
	}
	if err := tx.Credential.Update().Where(credential.UserID(from.ID)).SetUserID(into.ID).Exec(ctx); err != nil {
		return err
	}
	fromMembers, err := tx.Membership.Query().Where(membership.UserID(from.ID)).All(ctx)
	if err != nil {
		return err
	}
	intoSpaces, err := tx.Membership.Query().Where(membership.UserID(into.ID)).Select(membership.FieldSpaceID).Strings(ctx)
	if err != nil {
		return err
	}
	var added []string
	var ops []authz.Op
	for _, m := range fromMembers {
		if slices.Contains(intoSpaces, m.SpaceID) {
			continue
		}
		if _, err := tx.Membership.Create().SetUserID(into.ID).SetSpaceID(m.SpaceID).SetRoles(m.Roles).SetNickname(m.Nickname).SetAdmin(m.Admin).Save(ctx); err != nil {
			return err
		}
		added = append(added, m.SpaceID)
		ops = append(ops, authz.Write("space:"+m.SpaceID, "member", "user:"+into.ID))
		if m.Admin {
			ops = append(ops, authz.Write("space:"+m.SpaceID, "admin", "user:"+into.ID))
		}
	}
	if len(ops) > 0 {
		if err := authz.Stage(ctx, tx, ops...); err != nil {
			return err
		}
	}
	if err := tx.User.UpdateOneID(from.ID).SetMergedIntoID(into.ID).Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.UserMerge.Create().SetFromUserID(from.ID).SetIntoUserID(into.ID).SetIdentityIds(identityIDs).SetCredentialIds(credentialIDs).SetAddedSpaceIds(nonNil(added)).Save(ctx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.revokeAllSessions(from.ID)
	return s.authz.Flush(ctx)
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ListMerges returns every merge, newest first
func (s *Service) ListMerges(ctx context.Context) ([]*ent.UserMerge, error) {
	return s.ent.UserMerge.Query().Order(ent.Desc(usermerge.FieldCreatedAt)).All(ctx)
}

// RevertMerge gives a merged user back its identities, credentials, and the memberships the survivor gained
func (s *Service) RevertMerge(ctx context.Context, actor capability.Principal, id string, meta Meta) error {
	m, err := s.ent.UserMerge.Get(ctx, id)
	if ent.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if m.RevertedAt != nil {
		return ErrMergeReverted
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if len(m.IdentityIds) > 0 {
		if err := tx.Identity.Update().Where(identity.IDIn(m.IdentityIds...)).SetUserID(m.FromUserID).Exec(ctx); err != nil {
			return err
		}
	}
	if len(m.CredentialIds) > 0 {
		if err := tx.Credential.Update().Where(credential.IDIn(m.CredentialIds...)).SetUserID(m.FromUserID).Exec(ctx); err != nil {
			return err
		}
	}
	var ops []authz.Op
	for _, spaceID := range m.AddedSpaceIds {
		if _, err := tx.Membership.Delete().Where(membership.UserID(m.IntoUserID), membership.SpaceID(spaceID)).Exec(ctx); err != nil {
			return err
		}
		ops = append(ops, authz.Delete("space:"+spaceID, "member", "user:"+m.IntoUserID), authz.Delete("space:"+spaceID, "admin", "user:"+m.IntoUserID))
	}
	if len(ops) > 0 {
		if err := authz.Stage(ctx, tx, ops...); err != nil {
			return err
		}
	}
	if err := tx.User.UpdateOneID(m.FromUserID).ClearMergedIntoID().Exec(ctx); err != nil {
		return err
	}
	if err := tx.UserMerge.UpdateOneID(m.ID).SetRevertedAt(time.Now()).Exec(ctx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := s.authz.Flush(ctx); err != nil {
		return err
	}
	s.revokeAllSessions(m.IntoUserID)
	if actorUser, err := s.ent.User.Get(ctx, actor.UserID); err == nil {
		s.audit(ctx, actorUser, "merge_reverted", actor.Via, meta, actorUser.DisplayName+" split two merged users")
	}
	return nil
}

// UnlinkIdentity detaches one of the caller's identities, keeping at least one
func (s *Service) UnlinkIdentity(ctx context.Context, p capability.Principal, id string, meta Meta) error {
	ids, err := s.ent.Identity.Query().Where(identity.UserID(p.UserID)).All(ctx)
	if err != nil {
		return err
	}
	idx := slices.IndexFunc(ids, func(i *ent.Identity) bool { return i.ID == id })
	if idx < 0 {
		return ErrNotFound
	}
	if len(ids) <= 1 {
		return ErrLastIdentity
	}
	if err := s.ent.Identity.DeleteOneID(id).Exec(ctx); err != nil {
		return err
	}
	if u, err := s.ent.User.Get(ctx, p.UserID); err == nil {
		s.audit(ctx, u, "identity_unlinked", ids[idx].Provider, meta, u.DisplayName+" unlinked their "+ids[idx].Provider+" account "+ids[idx].Display)
	}
	return nil
}

// linkCodes holds one-time codes minted from Discord and redeemed from a signed-in browser
type linkCodes struct {
	mu    sync.Mutex
	items map[string]linkCode
}

type linkCode struct {
	userID  string
	expires time.Time
}

const linkCodeTTL = 10 * time.Minute

func newLinkCodes() *linkCodes { return &linkCodes{items: map[string]linkCode{}} }

func (c *linkCodes) put(userID string) (string, time.Time, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	code := base64.RawURLEncoding.EncodeToString(raw)
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, v := range c.items {
		if v.expires.Before(now) {
			delete(c.items, k)
		}
	}
	expires := now.Add(linkCodeTTL)
	c.items[code] = linkCode{userID: userID, expires: expires}
	return code, expires, nil
}

func (c *linkCodes) take(code string) (string, bool) {
	code = strings.TrimSpace(code)
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.items[code]
	delete(c.items, code)
	if !ok || v.expires.Before(time.Now()) {
		return "", false
	}
	return v.userID, true
}

// LinkURL returns the browser address that redeems a link code
func (s *Service) LinkURL(code string) (string, error) {
	base := s.PublicURL()
	if base == "" {
		s.mu.RLock()
		base = s.linkBase
		s.mu.RUnlock()
	}
	if base == "" {
		return "", ErrNoPublicURL
	}
	return base + "/link/" + code, nil
}

// PublicURL returns the origin users reach this server at, empty when not configured
func (s *Service) PublicURL() string { return s.publicURL }

// LinkBase returns the configured public URL or the address guessed at boot
func (s *Service) LinkBase() string {
	if s.publicURL != "" {
		return s.publicURL
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.linkBase
}

// CreateLinkCode mints a one-time code for the calling Discord user to claim from a browser
func (s *Service) CreateLinkCode(ctx context.Context, p capability.Principal) (string, time.Time, error) {
	has, err := s.ent.Identity.Query().Where(identity.UserID(p.UserID), identity.Provider("discord")).Exist(ctx)
	if err != nil {
		return "", time.Time{}, err
	}
	if !has {
		return "", time.Time{}, ErrNotExternal
	}
	if _, err := s.LinkURL("x"); err != nil {
		return "", time.Time{}, err
	}
	code, expires, err := s.links.put(p.UserID)
	if err != nil {
		return "", time.Time{}, err
	}
	url, err := s.LinkURL(code)
	return url, expires, err
}

// FinishLinkCode attaches the Discord identity behind a code to the signed-in caller
func (s *Service) FinishLinkCode(ctx context.Context, p capability.Principal, code string, meta Meta) (*ent.Identity, bool, error) {
	discordUserID, ok := s.links.take(code)
	if !ok {
		return nil, false, ErrLinkExpired
	}
	id, err := s.ent.Identity.Query().Where(identity.UserID(discordUserID), identity.Provider("discord")).First(ctx)
	if ent.IsNotFound(err) {
		return nil, false, ErrNotExternal
	}
	if err != nil {
		return nil, false, err
	}
	return s.LinkIdentity(ctx, p.UserID, id.Provider, id.Subject, id.Display, meta)
}

// CreateServiceAccount makes a bot or agent user that holds an API key and whose destructive calls wait for approval
func (s *Service) CreateServiceAccount(ctx context.Context, actor capability.Principal, displayName string, kind user.Kind, keyName string, expires *time.Time, meta Meta) (*ent.User, *ent.Credential, string, error) {
	if kind != user.KindBot && kind != user.KindAgent {
		return nil, nil, "", fmt.Errorf("identity: service accounts are bots or agents, not %s", kind)
	}
	tx, err := s.ent.Tx(ctx)
	if err != nil {
		return nil, nil, "", err
	}
	defer func() { _ = tx.Rollback() }()
	u, err := tx.User.Create().SetDisplayName(displayName).SetKind(kind).Save(ctx)
	if err != nil {
		return nil, nil, "", err
	}
	if err := authz.Stage(ctx, tx, authz.Write(authz.SystemObject, "member", "user:"+u.ID)); err != nil {
		return nil, nil, "", err
	}
	if err := timeline.Join(ctx, tx, u.ID, s.tl.SystemSpaceID()); err != nil {
		return nil, nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, "", err
	}
	if err := s.authz.Flush(ctx); err != nil {
		return nil, nil, "", err
	}
	secret, cred, err := s.CreateAPIKey(ctx, capability.Principal{UserID: u.ID, DisplayName: u.DisplayName, Kind: string(kind), Via: actor.Via}, keyName, expires, meta)
	if err != nil {
		return nil, nil, "", err
	}
	if actorUser, err := s.ent.User.Get(ctx, actor.UserID); err == nil {
		s.audit(ctx, actorUser, "service_account_created", actor.Via, meta, actorUser.DisplayName+" created the "+string(kind)+" "+displayName)
	}
	return u, cred, secret, nil
}
