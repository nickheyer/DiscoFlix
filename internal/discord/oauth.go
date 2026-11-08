package discord

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/disgoorg/disgo/rest"
	"github.com/disgoorg/snowflake/v2"

	"github.com/nickheyer/DiscoFlix/internal/identity"
)

const oauthSessionKey = "discord.oauth"

// oauthState is what the browser session remembers between start and callback
type oauthState struct {
	State    string `json:"state"`
	Next     string `json:"next"`
	Link     bool   `json:"link"`
	Redirect string `json:"redirect"`
}

// redirectURI is the callback address, from the public URL or the request when none is configured
func (s *Service) redirectURI(r *http.Request) string {
	if u := s.RedirectURL(); u != "" {
		return u
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/auth/discord/callback"
}

// StartHandler begins Discord OAuth for sign-in, or for linking when the caller is signed in and asks for it
func (s *Service) StartHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appID, err := s.ApplicationID(r.Context())
		secret, hasSecret := s.Secrets.Get(SecretClientSecret)
		if err != nil || !hasSecret || secret == "" {
			http.Redirect(w, r, "/login?error=discord_unavailable", http.StatusFound)
			return
		}
		raw := make([]byte, 24)
		if _, err := rand.Read(raw); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		st := oauthState{State: base64.RawURLEncoding.EncodeToString(raw), Next: safeNext(r.URL.Query().Get("next")), Redirect: s.redirectURI(r)}
		if r.URL.Query().Get("link") == "1" {
			if _, err := s.Identity.AuthenticateHTTP(r); err != nil {
				http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
				return
			}
			st.Link = true
		}
		encoded, _ := json.Marshal(st)
		s.Identity.SessionPut(r.Context(), oauthSessionKey, string(encoded))
		q := url.Values{}
		q.Set("client_id", appID.String())
		q.Set("response_type", "code")
		q.Set("redirect_uri", st.Redirect)
		q.Set("scope", "identify")
		q.Set("state", st.State)
		q.Set("prompt", "none")
		http.Redirect(w, r, "https://discord.com/oauth2/authorize?"+q.Encode(), http.StatusFound)
	})
}

// CallbackHandler finishes OAuth, signing the Discord user in or linking them to the current user
func (s *Service) CallbackHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var st oauthState
		if raw := s.Identity.SessionPopString(ctx, oauthSessionKey); raw == "" || json.Unmarshal([]byte(raw), &st) != nil {
			http.Redirect(w, r, "/login?error=discord_state", http.StatusFound)
			return
		}
		fail := func(code string) {
			target := "/login?error=" + code
			if st.Link {
				target = "/settings/connections?error=" + code
			}
			http.Redirect(w, r, target, http.StatusFound)
		}
		if r.URL.Query().Get("state") != st.State || r.URL.Query().Get("code") == "" {
			fail("discord_state")
			return
		}
		appID, err := s.ApplicationID(ctx)
		if err != nil {
			fail("discord_unavailable")
			return
		}
		secret, _ := s.Secrets.Get(SecretClientSecret)
		oauth := rest.New(rest.NewClient(""))
		token, err := oauth.GetAccessToken(appID, secret, r.URL.Query().Get("code"), st.Redirect, rest.WithCtx(ctx))
		if err != nil {
			s.Log.Warn("discord token exchange", "error", err)
			fail("discord_exchange")
			return
		}
		me, err := oauth.GetCurrentUser(token.AccessToken, rest.WithCtx(ctx))
		if err != nil {
			fail("discord_profile")
			return
		}
		meta := identity.Meta{RemoteAddr: r.RemoteAddr, UserAgent: r.UserAgent()}
		if st.Link {
			p, err := s.Identity.AuthenticateHTTP(r)
			if err != nil {
				fail("signed_out")
				return
			}
			if _, _, err := s.Identity.LinkIdentity(ctx, p.UserID, Provider, me.ID.String(), me.EffectiveName(), meta); err != nil {
				s.Log.Warn("discord link", "error", err)
				fail("discord_link")
				return
			}
			if _, _, err := s.Identity.EnsureExternalUser(ctx, externalUser(me.User)); err != nil {
				s.Log.Warn("discord profile refresh", "error", err)
			}
			http.Redirect(w, r, nextOr(st.Next, "/settings/connections?linked=1"), http.StatusFound)
			return
		}
		u, err := s.Identity.UserByIdentity(ctx, Provider, me.ID.String())
		if errors.Is(err, identity.ErrUnknownUser) {
			if !s.memberOfMirroredGuild(me.ID) {
				fail("not_a_member")
				return
			}
			if u, _, err = s.Identity.EnsureExternalUser(ctx, externalUser(me.User)); err != nil {
				fail("discord_profile")
				return
			}
			s.adoptMemberships(ctx, me.ID)
		} else if err != nil {
			fail("discord_profile")
			return
		}
		if err := s.Identity.MarkVerified(ctx, Provider, me.ID.String()); err != nil {
			s.Log.Warn("mark verified", "error", err)
		}
		if err := s.Identity.LoginUser(ctx, u, Provider, meta); err != nil {
			if errors.Is(err, identity.ErrDisabled) {
				fail("disabled")
				return
			}
			fail("discord_login")
			return
		}
		http.Redirect(w, r, nextOr(st.Next, "/"), http.StatusFound)
	})
}

// memberOfMirroredGuild reports whether a Discord user belongs to any guild the bot mirrors
func (s *Service) memberOfMirroredGuild(id snowflake.ID) bool {
	client, err := s.Client()
	if err != nil {
		return false
	}
	for g := range client.Caches.Guilds() {
		if _, ok := client.Caches.Member(g.ID, id); ok {
			return true
		}
	}
	return false
}

// adoptMemberships mirrors the guild memberships of a Discord user who signed in before a sync saw them
func (s *Service) adoptMemberships(ctx context.Context, id snowflake.ID) {
	client, err := s.Client()
	if err != nil {
		return
	}
	for g := range client.Caches.Guilds() {
		if m, ok := client.Caches.Member(g.ID, id); ok {
			s.onMember(context.WithoutCancel(ctx), client, m)
		}
	}
}

func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") {
		return ""
	}
	return next
}

func nextOr(next, fallback string) string {
	if next == "" {
		return fallback
	}
	return next
}
