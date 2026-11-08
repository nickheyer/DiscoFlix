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
	// session, apikey, or plugin
	Via         string
	SessionID   string
	SystemAdmin bool
}

// Subject renders the principal as an authorization subject such as user:<id>
func (p Principal) Subject() string { return "user:" + p.UserID }

type principalKey struct{}

// WithPrincipal attaches the caller to ctx
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the caller attached by the interceptor
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// ErrNoCredentials is returned by an Authenticator when the request carries nothing to check
var ErrNoCredentials = errors.New("capability: no credentials presented")
