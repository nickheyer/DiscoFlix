package identity

import (
	"context"
	"errors"
	"time"

	connect "connectrpc.com/connect/v2"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
	identityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1/identityv1connect"
)

// Handler serves IdentityService over Connect
type Handler struct {
	identityv1connect.UnimplementedIdentityServiceHandler
	svc *Service
}

// NewHandler wraps the service
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

func meta(ctx context.Context) Meta {
	info, ok := connect.CallInfoForServerContext(ctx)
	if !ok {
		return Meta{}
	}
	return Meta{RemoteAddr: info.PeerAddr, UserAgent: info.RequestHeader().Get("User-Agent")}
}

func principal(ctx context.Context) (capability.Principal, error) {
	p, ok := capability.PrincipalFrom(ctx)
	if !ok {
		return p, connect.NewError(connect.CodeUnauthenticated, "sign in to continue")
	}
	return p, nil
}

func mapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrInvalidCredentials):
		return connect.NewError(connect.CodeUnauthenticated, "invalid credentials")
	case errors.Is(err, ErrAlreadyBootstrapped):
		return connect.NewError(connect.CodeFailedPrecondition, "this server already has an administrator")
	case errors.Is(err, ErrNoSession):
		return connect.NewError(connect.CodeFailedPrecondition, "sessions need the HTTP transport")
	case errors.Is(err, ErrRateLimited):
		return connect.NewError(connect.CodeResourceExhausted, "too many attempts, wait a minute")
	case errors.Is(err, ErrNotFound):
		return connect.NewError(connect.CodeNotFound, "not found")
	case errors.Is(err, ErrLastAdmin):
		return connect.NewError(connect.CodeFailedPrecondition, err.Error())
	case errors.Is(err, ErrDisabled):
		return connect.NewError(connect.CodePermissionDenied, "account disabled")
	case errors.Is(err, ErrWeakPassword):
		return connect.NewError(connect.CodeInvalidArgument, "password must be at least 12 characters")
	case errors.Is(err, ErrLastIdentity):
		return connect.NewError(connect.CodeFailedPrecondition, "the last linked account cannot be removed")
	case errors.Is(err, ErrNoPublicURL):
		return connect.NewError(connect.CodeFailedPrecondition, "the server needs --public-url before it can build links")
	case errors.Is(err, ErrLinkExpired):
		return connect.NewError(connect.CodeNotFound, "this link code expired or was already used")
	case errors.Is(err, ErrNotExternal):
		return connect.NewError(connect.CodeFailedPrecondition, "only accounts that came from Discord can create link codes")
	case errors.Is(err, ErrMergeReverted):
		return connect.NewError(connect.CodeFailedPrecondition, "this merge was already reverted")
	case errors.Is(err, ErrUnknownUser):
		return connect.NewError(connect.CodeNotFound, "no user is linked to that account")
	}
	return err
}

func identityProto(id *ent.Identity) *identityv1.Identity {
	return &identityv1.Identity{Id: id.ID, Provider: id.Provider, Subject: id.Subject, Display: id.Display, VerifiedAt: stamp(id.VerifiedAt), LinkedAt: stamp(id.LinkedAt)}
}

var userKinds = map[user.Kind]identityv1.UserKind{
	user.KindPerson: identityv1.UserKind_USER_KIND_PERSON,
	user.KindBot:    identityv1.UserKind_USER_KIND_BOT,
	user.KindPlugin: identityv1.UserKind_USER_KIND_PLUGIN,
	user.KindAgent:  identityv1.UserKind_USER_KIND_AGENT,
}

var userStatuses = map[user.Status]identityv1.UserStatus{
	user.StatusActive:   identityv1.UserStatus_USER_STATUS_ACTIVE,
	user.StatusDisabled: identityv1.UserStatus_USER_STATUS_DISABLED,
}

func userProto(u *ent.User) *identityv1.User {
	out := &identityv1.User{
		Id:          u.ID,
		DisplayName: u.DisplayName,
		AvatarUrl:   u.AvatarURL,
		AccentColor: u.AccentColor,
		Kind:        userKinds[u.Kind],
		Status:      userStatuses[u.Status],
		SystemAdmin: u.SystemAdmin,
		CreatedAt:   timestamppb.New(u.CreatedAt),
	}
	if u.LastSeenAt != nil {
		out.LastSeenAt = timestamppb.New(*u.LastSeenAt)
	}
	return out
}

func stamp(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

func (h *Handler) GetServerInfo(ctx context.Context, _ *identityv1.GetServerInfoRequest) (*identityv1.GetServerInfoResponse, error) {
	required, err := h.svc.SetupRequired(ctx)
	if err != nil {
		return nil, err
	}
	name, err := h.svc.InstanceName(ctx)
	if err != nil {
		return nil, err
	}
	return &identityv1.GetServerInfoResponse{
		Version:       h.svc.build.Version,
		Commit:        h.svc.build.Commit,
		SetupRequired: required,
		PasswordLogin: true,
		PasskeyLogin:  true,
		InstanceName:  name,
		DiscordLogin:  h.svc.DiscordLogin(),
	}, nil
}

func (h *Handler) Bootstrap(ctx context.Context, req *identityv1.BootstrapRequest) (*identityv1.BootstrapResponse, error) {
	u, err := h.svc.Bootstrap(ctx, BootstrapInput{Username: req.GetUsername(), DisplayName: req.GetDisplayName(), Password: req.GetPassword(), InstanceName: req.GetInstanceName()}, meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.BootstrapResponse{User: userProto(u)}, nil
}

func (h *Handler) LoginWithPassword(ctx context.Context, req *identityv1.LoginWithPasswordRequest) (*identityv1.LoginWithPasswordResponse, error) {
	u, err := h.svc.LoginWithPassword(ctx, req.GetUsername(), req.GetPassword(), meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.LoginWithPasswordResponse{User: userProto(u)}, nil
}

func (h *Handler) BeginPasskeyLogin(ctx context.Context, _ *identityv1.BeginPasskeyLoginRequest) (*identityv1.BeginPasskeyLoginResponse, error) {
	options, ceremony, err := h.svc.BeginPasskeyLogin(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.BeginPasskeyLoginResponse{OptionsJson: options, Ceremony: ceremony}, nil
}

func (h *Handler) FinishPasskeyLogin(ctx context.Context, req *identityv1.FinishPasskeyLoginRequest) (*identityv1.FinishPasskeyLoginResponse, error) {
	u, err := h.svc.FinishPasskeyLogin(ctx, req.GetCeremony(), req.GetCredentialJson(), meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.FinishPasskeyLoginResponse{User: userProto(u)}, nil
}

func (h *Handler) Logout(ctx context.Context, _ *identityv1.LogoutRequest) (*identityv1.LogoutResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.Logout(ctx, p, meta(ctx)); err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.LogoutResponse{}, nil
}

func (h *Handler) GetMe(ctx context.Context, _ *identityv1.GetMeRequest) (*identityv1.GetMeResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	u, err := h.svc.GetUser(ctx, p.UserID)
	if err != nil {
		return nil, mapErr(err)
	}
	ids, err := h.svc.Identities(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	mems, err := h.svc.Memberships(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	res := &identityv1.GetMeResponse{User: userProto(u)}
	for _, id := range ids {
		res.Identities = append(res.Identities, identityProto(id))
	}
	for _, m := range mems {
		res.Memberships = append(res.Memberships, &identityv1.Membership{SpaceId: m.SpaceID, Roles: m.Roles})
	}
	return res, nil
}

func (h *Handler) ChangePassword(ctx context.Context, req *identityv1.ChangePasswordRequest) (*identityv1.ChangePasswordResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.ChangePassword(ctx, p, req.GetCurrentPassword(), req.GetNewPassword(), meta(ctx)); err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.ChangePasswordResponse{}, nil
}

func (h *Handler) BeginPasskeyRegistration(ctx context.Context, _ *identityv1.BeginPasskeyRegistrationRequest) (*identityv1.BeginPasskeyRegistrationResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	options, err := h.svc.BeginPasskeyRegistration(ctx, p)
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.BeginPasskeyRegistrationResponse{OptionsJson: options}, nil
}

func passkeyProto(c *ent.Credential) *identityv1.Passkey {
	return &identityv1.Passkey{Id: c.ID, Name: c.Name, CreatedAt: timestamppb.New(c.CreatedAt), LastUsedAt: stamp(c.LastUsedAt), BackupEligible: c.BackupEligible}
}

func (h *Handler) FinishPasskeyRegistration(ctx context.Context, req *identityv1.FinishPasskeyRegistrationRequest) (*identityv1.FinishPasskeyRegistrationResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	c, err := h.svc.FinishPasskeyRegistration(ctx, p, req.GetName(), req.GetCredentialJson(), meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.FinishPasskeyRegistrationResponse{Passkey: passkeyProto(c)}, nil
}

func (h *Handler) ListPasskeys(ctx context.Context, _ *identityv1.ListPasskeysRequest) (*identityv1.ListPasskeysResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := h.svc.ListPasskeys(ctx, p)
	if err != nil {
		return nil, err
	}
	res := &identityv1.ListPasskeysResponse{}
	for _, c := range rows {
		res.Passkeys = append(res.Passkeys, passkeyProto(c))
	}
	return res, nil
}

func (h *Handler) DeletePasskey(ctx context.Context, req *identityv1.DeletePasskeyRequest) (*identityv1.DeletePasskeyResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.DeletePasskey(ctx, p, req.GetId(), meta(ctx)); err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.DeletePasskeyResponse{}, nil
}

func apiKeyProto(c *ent.Credential) *identityv1.ApiKey {
	return &identityv1.ApiKey{Id: c.ID, Name: c.Name, Prefix: "dfx_" + c.Prefix, CreatedAt: timestamppb.New(c.CreatedAt), LastUsedAt: stamp(c.LastUsedAt), ExpiresAt: stamp(c.ExpiresAt)}
}

func (h *Handler) ListApiKeys(ctx context.Context, _ *identityv1.ListApiKeysRequest) (*identityv1.ListApiKeysResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := h.svc.ListAPIKeys(ctx, p)
	if err != nil {
		return nil, err
	}
	res := &identityv1.ListApiKeysResponse{}
	for _, c := range rows {
		res.ApiKeys = append(res.ApiKeys, apiKeyProto(c))
	}
	return res, nil
}

func (h *Handler) CreateApiKey(ctx context.Context, req *identityv1.CreateApiKeyRequest) (*identityv1.CreateApiKeyResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	var expires *time.Time
	if req.GetExpiresAt() != nil {
		t := req.GetExpiresAt().AsTime()
		expires = &t
	}
	secret, c, err := h.svc.CreateAPIKey(ctx, p, req.GetName(), expires, meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.CreateApiKeyResponse{ApiKey: apiKeyProto(c), Secret: secret}, nil
}

func (h *Handler) RevokeApiKey(ctx context.Context, req *identityv1.RevokeApiKeyRequest) (*identityv1.RevokeApiKeyResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.RevokeAPIKey(ctx, p, req.GetId(), meta(ctx)); err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.RevokeApiKeyResponse{}, nil
}

func (h *Handler) ListSessions(ctx context.Context, _ *identityv1.ListSessionsRequest) (*identityv1.ListSessionsResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := h.svc.ListSessions(ctx, p)
	if err != nil {
		return nil, err
	}
	res := &identityv1.ListSessionsResponse{}
	for _, s := range rows {
		res.Sessions = append(res.Sessions, &identityv1.Session{Id: s.ID, UserAgent: s.UserAgent, RemoteAddr: s.RemoteAddr, CreatedAt: timestamppb.New(s.CreatedAt), ExpiresAt: timestamppb.New(s.ExpiresAt), Current: s.Current})
	}
	return res, nil
}

func (h *Handler) RevokeSession(ctx context.Context, req *identityv1.RevokeSessionRequest) (*identityv1.RevokeSessionResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.RevokeSession(ctx, p, req.GetId(), meta(ctx)); err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.RevokeSessionResponse{}, nil
}

func (h *Handler) ListUsers(ctx context.Context, _ *identityv1.ListUsersRequest) (*identityv1.ListUsersResponse, error) {
	rows, err := h.svc.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	res := &identityv1.ListUsersResponse{}
	for _, u := range rows {
		res.Users = append(res.Users, userProto(u))
	}
	return res, nil
}

func (h *Handler) UpdateUser(ctx context.Context, req *identityv1.UpdateUserRequest) (*identityv1.UpdateUserResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	status := user.StatusActive
	if req.GetStatus() == identityv1.UserStatus_USER_STATUS_DISABLED {
		status = user.StatusDisabled
	}
	u, err := h.svc.UpdateUser(ctx, p, req.GetId(), UserUpdate{DisplayName: req.GetDisplayName(), Status: status, SystemAdmin: req.GetSystemAdmin()}, meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.UpdateUserResponse{User: userProto(u)}, nil
}

func (h *Handler) UnlinkIdentity(ctx context.Context, req *identityv1.UnlinkIdentityRequest) (*identityv1.UnlinkIdentityResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.UnlinkIdentity(ctx, p, req.GetId(), meta(ctx)); err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.UnlinkIdentityResponse{}, nil
}

func (h *Handler) CreateLinkCode(ctx context.Context, _ *identityv1.CreateLinkCodeRequest) (*identityv1.CreateLinkCodeResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	url, expires, err := h.svc.CreateLinkCode(ctx, p)
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.CreateLinkCodeResponse{Url: url, ExpiresAt: timestamppb.New(expires)}, nil
}

func (h *Handler) FinishLinkCode(ctx context.Context, req *identityv1.FinishLinkCodeRequest) (*identityv1.FinishLinkCodeResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	id, merged, err := h.svc.FinishLinkCode(ctx, p, req.GetCode(), meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.FinishLinkCodeResponse{Identity: identityProto(id), Merged: merged}, nil
}

func (h *Handler) CreateServiceAccount(ctx context.Context, req *identityv1.CreateServiceAccountRequest) (*identityv1.CreateServiceAccountResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	kind := user.KindAgent
	if req.GetKind() == identityv1.UserKind_USER_KIND_BOT {
		kind = user.KindBot
	}
	var expires *time.Time
	if req.GetExpiresAt() != nil {
		t := req.GetExpiresAt().AsTime()
		expires = &t
	}
	u, cred, secret, err := h.svc.CreateServiceAccount(ctx, p, req.GetDisplayName(), kind, req.GetKeyName(), expires, meta(ctx))
	if err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.CreateServiceAccountResponse{User: userProto(u), ApiKey: apiKeyProto(cred), Secret: secret}, nil
}

func (h *Handler) ListUserMerges(ctx context.Context, _ *identityv1.ListUserMergesRequest) (*identityv1.ListUserMergesResponse, error) {
	rows, err := h.svc.ListMerges(ctx)
	if err != nil {
		return nil, err
	}
	res := &identityv1.ListUserMergesResponse{}
	for _, m := range rows {
		from, err := h.svc.ent.User.Get(ctx, m.FromUserID)
		if err != nil {
			return nil, err
		}
		into, err := h.svc.ent.User.Get(ctx, m.IntoUserID)
		if err != nil {
			return nil, err
		}
		res.Merges = append(res.Merges, &identityv1.UserMerge{Id: m.ID, FromUser: userProto(from), IntoUser: userProto(into), CreatedAt: timestamppb.New(m.CreatedAt), RevertedAt: stamp(m.RevertedAt)})
	}
	return res, nil
}

func (h *Handler) RevertUserMerge(ctx context.Context, req *identityv1.RevertUserMergeRequest) (*identityv1.RevertUserMergeResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.RevertMerge(ctx, p, req.GetId(), meta(ctx)); err != nil {
		return nil, mapErr(err)
	}
	return &identityv1.RevertUserMergeResponse{}, nil
}
