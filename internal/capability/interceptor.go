package capability

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"

	connect "connectrpc.com/connect/v2"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
)

// Authenticator resolves the caller from the transport, returning ErrNoCredentials when nothing is presented
type Authenticator interface {
	Authenticate(ctx context.Context, info *connect.CallInfo) (Principal, error)
}

// Authorizer decides whether a principal may invoke an entry on an object
type Authorizer interface {
	Authorize(ctx context.Context, p Principal, e *Entry, objectID string) (bool, error)
}

// Approver turns a destructive call by automation into an approval card and reports its seq
type Approver interface {
	Request(ctx context.Context, p Principal, e *Entry, input proto.Message) (int64, error)
}

// CheckFunc answers one relationship check against the authorization store
type CheckFunc func(ctx context.Context, subject, relation, object string) (bool, error)

// ObjectResolver authorizes one object type by its own rule instead of a direct tuple check
type ObjectResolver func(ctx context.Context, p Principal, e *Entry, objectID string) (bool, error)

// Gate authorizes entries through the store, with per-type resolvers for derived objects
type Gate struct {
	check     CheckFunc
	mu        sync.RWMutex
	resolvers map[string]ObjectResolver
}

// NewGate builds an Authorizer over a relationship check
func NewGate(check CheckFunc) *Gate {
	return &Gate{check: check, resolvers: map[string]ObjectResolver{}}
}

// Resolve installs a resolver for one object type
func (g *Gate) Resolve(objectType string, fn ObjectResolver) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.resolvers[objectType] = fn
}

// SystemObject is the object every scope without an object is checked against
const SystemObject = "system:main"

func (g *Gate) Authorize(ctx context.Context, p Principal, e *Entry, objectID string) (bool, error) {
	if e.Object == nil {
		return g.check(ctx, p.Subject(), e.Relation(), SystemObject)
	}
	g.mu.RLock()
	fn, ok := g.resolvers[e.Object.GetType()]
	g.mu.RUnlock()
	if ok {
		return fn(ctx, p, e, objectID)
	}
	return g.check(ctx, p.Subject(), e.Relation(), e.Object.GetType()+":"+objectID)
}

// Interceptor authenticates and authorizes every registered procedure before its handler runs
type Interceptor struct {
	reg   *Registry
	auth  Authenticator
	authz Authorizer
	log   *slog.Logger

	mu       sync.RWMutex
	approver Approver
}

// NewInterceptor wires the registry to the authentication and authorization backends
func NewInterceptor(reg *Registry, auth Authenticator, authz Authorizer, log *slog.Logger) *Interceptor {
	return &Interceptor{reg: reg, auth: auth, authz: authz, log: log}
}

// SetApprover routes destructive automation calls to approval cards instead of refusing them
func (i *Interceptor) SetApprover(a Approver) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.approver = a
}

func (i *Interceptor) approverFor() Approver {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.approver
}

// Server returns the Connect v2 server interceptor
func (i *Interceptor) Server() connect.ServerInterceptor {
	return func(next connect.ServerFunc) connect.ServerFunc {
		return func(ctx context.Context, spec connect.Spec, stream connect.ServerStream) error {
			e, ok := i.reg.Get(spec.Procedure)
			if !ok {
				return connect.NewError(connect.CodeInternal, "capability not registered: "+spec.Procedure)
			}
			p, err := i.authenticate(ctx)
			switch {
			case err == nil:
				ctx = WithPrincipal(ctx, p)
			case errors.Is(err, ErrNoCredentials):
				if !e.Public {
					return connect.NewError(connect.CodeUnauthenticated, "sign in to continue")
				}
			default:
				return connect.NewError(connect.CodeUnauthenticated, err.Error())
			}
			if e.Public {
				return next(ctx, spec, stream)
			}
			needsApproval := e.Effect == capabilityv1.Effect_EFFECT_DESTRUCTIVE && p.Automation() && !approvedFrom(ctx)
			if needsApproval && i.approverFor() == nil {
				return connect.NewError(connect.CodePermissionDenied, "destructive capabilities require an approval card")
			}
			if e.Object == nil {
				allowed, err := i.authz.Authorize(ctx, p, e, "")
				if err != nil {
					i.log.Error("authorization check failed", "procedure", spec.Procedure, "error", err)
					return connect.NewError(connect.CodeInternal, "authorization check failed")
				}
				if !allowed {
					return connect.NewError(connect.CodePermissionDenied, "not allowed: "+e.Scope)
				}
				if !needsApproval {
					return next(ctx, spec, stream)
				}
			}
			return next(ctx, spec, &gatedStream{ServerStream: stream, check: func(msg any) error {
				pm, ok := msg.(proto.Message)
				if !ok {
					return connect.NewError(connect.CodeInternal, "request is not a proto message")
				}
				if e.Object != nil {
					if err := i.checkObject(ctx, p, e, pm); err != nil {
						return err
					}
				}
				if needsApproval {
					return i.requestApproval(ctx, p, e, pm)
				}
				return nil
			}})
		}
	}
}

// authenticate prefers a trusted in-process principal and otherwise asks the transport authenticator
func (i *Interceptor) authenticate(ctx context.Context) (Principal, error) {
	if p, ok := trustedFrom(ctx); ok {
		return p, nil
	}
	info, _ := connect.CallInfoForServerContext(ctx)
	return i.auth.Authenticate(ctx, info)
}

// requestApproval posts the approval card and tells the caller where to watch for the decision
func (i *Interceptor) requestApproval(ctx context.Context, p Principal, e *Entry, msg proto.Message) error {
	seq, err := i.approverFor().Request(ctx, p, e, proto.Clone(msg))
	if err != nil {
		i.log.Error("approval request failed", "procedure", e.Procedure, "error", err)
		return connect.NewError(connect.CodeInternal, "approval request failed: "+err.Error())
	}
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Sprintf("approval required: card %d awaits a decision", seq))
}

// checkObject pulls the object id out of the request message and authorizes it
func (i *Interceptor) checkObject(ctx context.Context, p Principal, e *Entry, pm proto.Message) error {
	id, err := ObjectID(pm, e.Object.GetField())
	if err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err.Error())
	}
	allowed, err := i.authz.Authorize(ctx, p, e, id)
	if err != nil {
		i.log.Error("authorization check failed", "procedure", e.Procedure, "object", e.Object.GetType()+":"+id, "error", err)
		return connect.NewError(connect.CodeInternal, "authorization check failed")
	}
	if !allowed {
		return connect.NewError(connect.CodePermissionDenied, fmt.Sprintf("not allowed: %s on %s", e.Scope, e.Object.GetType()))
	}
	return nil
}

// ObjectID reads the string or integer field that names the authorization object
func ObjectID(msg proto.Message, field string) (string, error) {
	m := msg.ProtoReflect()
	fd := m.Descriptor().Fields().ByName(protoreflect.Name(field))
	if fd == nil {
		return "", fmt.Errorf("field %s missing", field)
	}
	v := m.Get(fd)
	switch fd.Kind() {
	case protoreflect.StringKind:
		if v.String() == "" {
			return "", fmt.Errorf("%s is required", field)
		}
		return v.String(), nil
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind, protoreflect.Int32Kind:
		if v.Int() == 0 {
			return "", fmt.Errorf("%s is required", field)
		}
		return strconv.FormatInt(v.Int(), 10), nil
	}
	return "", fmt.Errorf("field %s has unsupported kind %s", field, fd.Kind())
}

// gatedStream authorizes the first received request message before the handler sees it
type gatedStream struct {
	connect.ServerStream
	once  sync.Once
	check func(any) error
	err   error
}

func (g *gatedStream) Receive(msg any) error {
	if err := g.ServerStream.Receive(msg); err != nil {
		return err
	}
	g.once.Do(func() { g.err = g.check(msg) })
	return g.err
}
