package identity

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	connect "connectrpc.com/connect/v2"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/credential"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/identity"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
)

const registrationSessionKey = "passkey.registration"

// waUser adapts a user and their passkeys to the WebAuthn library
type waUser struct {
	u     *ent.User
	name  string
	creds []*ent.Credential
}

func (w waUser) WebAuthnID() []byte          { return []byte(w.u.ID) }
func (w waUser) WebAuthnName() string        { return w.name }
func (w waUser) WebAuthnDisplayName() string { return w.u.DisplayName }
func (w waUser) WebAuthnCredentials() []webauthn.Credential {
	out := make([]webauthn.Credential, 0, len(w.creds))
	for _, c := range w.creds {
		transports := make([]protocol.AuthenticatorTransport, 0, len(c.Transports))
		for _, t := range c.Transports {
			transports = append(transports, protocol.AuthenticatorTransport(t))
		}
		out = append(out, webauthn.Credential{
			ID:              c.CredentialID,
			PublicKey:       c.PublicKey,
			AttestationType: c.AttestationType,
			Transport:       transports,
			Flags:           webauthn.CredentialFlags{BackupEligible: c.BackupEligible, BackupState: c.BackupState},
			Authenticator:   webauthn.Authenticator{AAGUID: c.Aaguid, SignCount: c.SignCount},
		})
	}
	return out
}

func (s *Service) waUser(ctx context.Context, userID string) (waUser, error) {
	u, err := s.ent.User.Get(ctx, userID)
	if err != nil {
		return waUser{}, err
	}
	creds, err := s.ent.Credential.Query().Where(credential.UserID(userID), credential.KindEQ(credential.KindPasskey)).All(ctx)
	if err != nil {
		return waUser{}, err
	}
	name := u.DisplayName
	if id, err := s.ent.Identity.Query().Where(identity.UserID(userID), identity.Provider("local")).Only(ctx); err == nil {
		name = id.Subject
	}
	return waUser{u: u, name: name, creds: creds}, nil
}

// relyingParty builds a WebAuthn instance for the origin the browser is using
func (s *Service) relyingParty(ctx context.Context) (*webauthn.WebAuthn, error) {
	origin := s.publicURL
	if origin == "" {
		if info, ok := connect.CallInfoForServerContext(ctx); ok {
			origin = info.RequestHeader().Get("Origin")
			if origin == "" {
				scheme := "http"
				if proto := info.RequestHeader().Get("X-Forwarded-Proto"); proto != "" {
					scheme = proto
				}
				origin = scheme + "://" + info.RequestHeader().Get("Host")
			}
		}
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("identity: passkeys need a request origin, got %q", origin)
	}
	name, err := s.InstanceName(ctx)
	if err != nil {
		return nil, err
	}
	return webauthn.New(&webauthn.Config{
		RPID:          u.Hostname(),
		RPDisplayName: name,
		RPOrigins:     []string{u.Scheme + "://" + u.Host},
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationPreferred,
		},
	})
}

// BeginPasskeyRegistration returns creation options for the signed-in user
func (s *Service) BeginPasskeyRegistration(ctx context.Context, p capability.Principal) ([]byte, error) {
	if !sessionLoaded(ctx) {
		return nil, ErrNoSession
	}
	rp, err := s.relyingParty(ctx)
	if err != nil {
		return nil, err
	}
	wu, err := s.waUser(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	creation, session, err := rp.BeginRegistration(wu, webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired))
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(session)
	if err != nil {
		return nil, err
	}
	s.sessions.Put(ctx, registrationSessionKey, string(raw))
	return json.Marshal(creation.Response)
}

// FinishPasskeyRegistration validates the attestation and stores the passkey
func (s *Service) FinishPasskeyRegistration(ctx context.Context, p capability.Principal, name string, credentialJSON []byte, meta Meta) (*ent.Credential, error) {
	if !sessionLoaded(ctx) {
		return nil, ErrNoSession
	}
	raw := s.sessions.PopString(ctx, registrationSessionKey)
	if raw == "" {
		return nil, errors.New("identity: no registration in progress")
	}
	var session webauthn.SessionData
	if err := json.Unmarshal([]byte(raw), &session); err != nil {
		return nil, err
	}
	rp, err := s.relyingParty(ctx)
	if err != nil {
		return nil, err
	}
	wu, err := s.waUser(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(credentialJSON)
	if err != nil {
		return nil, fmt.Errorf("identity: parse attestation: %w", err)
	}
	cred, err := rp.CreateCredential(wu, session, parsed)
	if err != nil {
		return nil, fmt.Errorf("identity: verify attestation: %w", err)
	}
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	row, err := s.ent.Credential.Create().
		SetUserID(p.UserID).
		SetKind(credential.KindPasskey).
		SetName(name).
		SetCredentialID(cred.ID).
		SetPublicKey(cred.PublicKey).
		SetAaguid(cred.Authenticator.AAGUID).
		SetAttestationType(cred.AttestationType).
		SetSignCount(cred.Authenticator.SignCount).
		SetTransports(transports).
		SetBackupEligible(cred.Flags.BackupEligible).
		SetBackupState(cred.Flags.BackupState).
		Save(ctx)
	if err != nil {
		return nil, err
	}
	s.audit(ctx, wu.u, "passkey_added", p.Via, meta, wu.u.DisplayName+" added the passkey "+name)
	return row, nil
}

// ListPasskeys returns the caller's passkeys
func (s *Service) ListPasskeys(ctx context.Context, p capability.Principal) ([]*ent.Credential, error) {
	return s.ent.Credential.Query().Where(credential.UserID(p.UserID), credential.KindEQ(credential.KindPasskey)).Order(ent.Asc(credential.FieldCreatedAt)).All(ctx)
}

// DeletePasskey removes one of the caller's passkeys
func (s *Service) DeletePasskey(ctx context.Context, p capability.Principal, id string, meta Meta) error {
	n, err := s.ent.Credential.Delete().Where(credential.ID(id), credential.UserID(p.UserID), credential.KindEQ(credential.KindPasskey)).Exec(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	if u, err := s.ent.User.Get(ctx, p.UserID); err == nil {
		s.audit(ctx, u, "passkey_removed", p.Via, meta, u.DisplayName+" removed a passkey")
	}
	return nil
}

// BeginPasskeyLogin returns discoverable assertion options bound to a ceremony token
func (s *Service) BeginPasskeyLogin(ctx context.Context) ([]byte, string, error) {
	rp, err := s.relyingParty(ctx)
	if err != nil {
		return nil, "", err
	}
	assertion, session, err := rp.BeginDiscoverableLogin()
	if err != nil {
		return nil, "", err
	}
	token, err := s.ceremonies.put(session)
	if err != nil {
		return nil, "", err
	}
	raw, err := json.Marshal(assertion.Response)
	if err != nil {
		return nil, "", err
	}
	return raw, token, nil
}

// FinishPasskeyLogin validates the assertion for the ceremony and starts a session
func (s *Service) FinishPasskeyLogin(ctx context.Context, ceremony string, credentialJSON []byte, meta Meta) (*ent.User, error) {
	if !sessionLoaded(ctx) {
		return nil, ErrNoSession
	}
	session, ok := s.ceremonies.take(ceremony)
	if !ok {
		return nil, ErrInvalidCredentials
	}
	rp, err := s.relyingParty(ctx)
	if err != nil {
		return nil, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(credentialJSON)
	if err != nil {
		return nil, fmt.Errorf("identity: parse assertion: %w", err)
	}
	var matched *ent.Credential
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		row, err := s.ent.Credential.Query().Where(credential.KindEQ(credential.KindPasskey), credential.CredentialID(rawID)).Only(ctx)
		if err != nil {
			return nil, ErrInvalidCredentials
		}
		if string(userHandle) != row.UserID {
			return nil, ErrInvalidCredentials
		}
		matched = row
		return s.waUser(ctx, row.UserID)
	}
	wu, cred, err := rp.ValidatePasskeyLogin(handler, session, parsed)
	if err != nil {
		return nil, ErrInvalidCredentials
	}
	u := wu.(waUser).u
	if u.Status != user.StatusActive {
		return nil, ErrDisabled
	}
	if err := s.ent.Credential.UpdateOneID(matched.ID).SetSignCount(cred.Authenticator.SignCount).SetBackupState(cred.Flags.BackupState).SetLastUsedAt(time.Now()).Exec(ctx); err != nil {
		return nil, err
	}
	if err := s.login(ctx, u, "passkey", meta); err != nil {
		return nil, err
	}
	s.audit(ctx, u, "login", "passkey", meta, u.DisplayName+" signed in with a passkey")
	return u, nil
}

// ceremonyStore holds login challenges between begin and finish calls
type ceremonyStore struct {
	mu    sync.Mutex
	items map[string]ceremony
}

type ceremony struct {
	session *webauthn.SessionData
	expires time.Time
}

func newCeremonyStore() *ceremonyStore { return &ceremonyStore{items: map[string]ceremony{}} }

func (c *ceremonyStore) put(session *webauthn.SessionData) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, v := range c.items {
		if v.expires.Before(now) {
			delete(c.items, k)
		}
	}
	c.items[token] = ceremony{session: session, expires: now.Add(5 * time.Minute)}
	return token, nil
}

func (c *ceremonyStore) take(token string) (webauthn.SessionData, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.items[strings.TrimSpace(token)]
	delete(c.items, token)
	if !ok || v.expires.Before(time.Now()) {
		return webauthn.SessionData{}, false
	}
	return *v.session, true
}
