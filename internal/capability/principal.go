// Package capability turns proto service descriptors into one registry that every transport derives from
package capability

import (
	"context"
	"errors"
)

// Principal is the authenticated caller of a capability
type Principal struct {
	UserID      string
	DisplayName string
	// person, bot, plugin, or agent
	Kind string
	// session, apikey, discord, approval, or plugin
	Via         string
	SessionID   string
	SystemAdmin bool
}

// Subject renders the principal as an authorization subject such as user:<id>
func (p Principal) Subject() string { return "user:" + p.UserID }

// Automation reports whether the caller is software rather than a person
func (p Principal) Automation() bool {
	return p.Kind == "agent" || p.Kind == "plugin" || p.Kind == "bot"
}

// Origin names the transport a write made by this principal is attributed to
func (p Principal) Origin() string {
	switch p.Via {
	case "session", "shell":
		return "web"
	case "apikey":
		return "api"
	case "":
		return "system"
	}
	return p.Via
}

type principalKey struct{}

type trustedKey struct{}

type approvedKey struct{}

// WithPrincipal attaches the caller to ctx
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the caller attached by the interceptor
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// WithTrusted marks an in-process call as already authenticated, HTTP requests can never carry this
func WithTrusted(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, trustedKey{}, p)
}

func trustedFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(trustedKey{}).(Principal)
	return p, ok
}

// WithApproved marks a destructive in-process call as decided by an approval card
func WithApproved(ctx context.Context) context.Context {
	return context.WithValue(ctx, approvedKey{}, true)
}

func approvedFrom(ctx context.Context) bool {
	v, _ := ctx.Value(approvedKey{}).(bool)
	return v
}

// ErrNoCredentials is returned by an Authenticator when the request carries nothing to check
var ErrNoCredentials = errors.New("capability: no credentials presented")
