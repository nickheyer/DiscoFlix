// Package extension defines the points where built-in providers and plugins attach to the core
package extension

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"slices"
	"sort"
	"strings"
	"sync"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/nickheyer/DiscoFlix/internal/capability"
)

// Kind names one extension point of the host
type Kind string

const (
	KindCardSchema     Kind = "card-schema"
	KindNotifier       Kind = "notifier"
	KindIndexer        Kind = "indexer"
	KindDownloadClient Kind = "download-client"
	KindMetadataSource Kind = "metadata-source"
	KindAITool         Kind = "ai-tool"
	KindJob            Kind = "job"
)

// Descriptor identifies an extension and where it came from
type Descriptor struct {
	// Stable id such as discoflix.card.system-notice or acme.indexer.example
	ID string
	// Human name shown in the UI
	Name string
	// Semantic version of the implementation
	Version string
	Kind    Kind
	// builtin or plugin:<plugin id>
	Origin string
}

// Extension is anything the host can list, enable, and route work to
type Extension interface {
	Describe() Descriptor
}

// CardSchema declares one Card payload type the timeline accepts
type CardSchema interface {
	Extension
	// TypeURL is the google.protobuf.Any type URL of the payload
	TypeURL() string
	// Message returns an empty payload for decoding
	Message() proto.Message
}

// Notification is one outbound message for a Notifier
type Notification struct {
	Title    string
	Body     string
	URL      string
	Severity string
	UserID   string
}

// Notifier delivers notifications to one destination such as Discord, email, or push
type Notifier interface {
	Extension
	Notify(ctx context.Context, n Notification) error
}

// Registry holds every extension by id and kind
type Registry struct {
	mu   sync.RWMutex
	byID map[string]Extension
}

// NewRegistry returns an empty registry
func NewRegistry() *Registry { return &Registry{byID: map[string]Extension{}} }

// ErrDuplicate reports a second registration of the same id
var ErrDuplicate = errors.New("extension: duplicate id")

// Register adds an extension, validating its descriptor
func (r *Registry) Register(ext Extension) error {
	d := ext.Describe()
	if d.ID == "" || d.Kind == "" || d.Origin == "" {
		return fmt.Errorf("extension: descriptor needs id, kind, and origin: %+v", d)
	}
	if cs, ok := ext.(CardSchema); ok && (cs.TypeURL() == "" || cs.Message() == nil) {
		return fmt.Errorf("extension: card schema %s needs a type url and message", d.ID)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.byID[d.ID]; dup {
		return fmt.Errorf("%w: %s", ErrDuplicate, d.ID)
	}
	r.byID[d.ID] = ext
	return nil
}

// Get returns the extension registered under id
func (r *Registry) Get(id string) (Extension, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.byID[id]
	return e, ok
}

// All iterates every extension ordered by id
func (r *Registry) All() iter.Seq[Extension] {
	return func(yield func(Extension) bool) {
		r.mu.RLock()
		ids := make([]string, 0, len(r.byID))
		for id := range r.byID {
			ids = append(ids, id)
		}
		exts := make([]Extension, 0, len(ids))
		sort.Strings(ids)
		for _, id := range ids {
			exts = append(exts, r.byID[id])
		}
		r.mu.RUnlock()
		for _, e := range exts {
			if !yield(e) {
				return
			}
		}
	}
}

// Of returns every registered extension implementing T
func Of[T Extension](r *Registry) []T {
	var out []T
	for e := range r.All() {
		if t, ok := e.(T); ok {
			out = append(out, t)
		}
	}
	return out
}

// CardSchema finds the schema registered for a type URL
func (r *Registry) CardSchema(typeURL string) (CardSchema, bool) {
	for _, cs := range Of[CardSchema](r) {
		if cs.TypeURL() == typeURL {
			return cs, true
		}
	}
	return nil, false
}

// builtinCard registers a proto message as a core card schema
type builtinCard struct {
	msg proto.Message
}

func (b builtinCard) Describe() Descriptor {
	if b.msg == nil {
		return Descriptor{}
	}
	name := string(b.msg.ProtoReflect().Descriptor().Name())
	return Descriptor{ID: "discoflix.card." + kebab(name), Name: name, Version: "1", Kind: KindCardSchema, Origin: "builtin"}
}

func (b builtinCard) TypeURL() string {
	if b.msg == nil {
		return ""
	}
	return TypeURLOf(b.msg.ProtoReflect().Descriptor())
}

func (b builtinCard) Message() proto.Message {
	if b.msg == nil {
		return nil
	}
	return b.msg.ProtoReflect().New().Interface()
}

// BuiltinCard wraps a core proto message as a card schema extension
func BuiltinCard(msg proto.Message) CardSchema { return builtinCard{msg: msg} }

// kebab turns CamelCase into kebab-case
func kebab(s string) string {
	var b strings.Builder
	for i, r := range s {
		if i > 0 && r >= 'A' && r <= 'Z' {
			b.WriteByte('-')
		}
		b.WriteRune(r)
	}
	return strings.ToLower(b.String())
}

// TypeURLOf is the Any type URL for a message descriptor
func TypeURLOf(md protoreflect.MessageDescriptor) string {
	return "type.googleapis.com/" + string(md.FullName())
}

// Kinds lists the kinds the registry currently holds
func (r *Registry) Kinds() []Kind {
	seen := map[Kind]bool{}
	var out []Kind
	for e := range r.All() {
		k := e.Describe().Kind
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

// Interaction is one press or selection on a card made through any transport
type Interaction struct {
	Principal capability.Principal
	Seq       int64
	SpaceID   string
	ChannelID string
	Card      proto.Message
	Action    string
	Value     string
}

// Action is one control a card offers, rendered as a button by every transport
type Action struct {
	ID    string
	Label string
	// primary, success, danger, or secondary
	Style string
}

// CardActions lists the controls a card currently offers given its state
type CardActions interface {
	Actions(card proto.Message) []Action
}

// CardInteractor applies one interaction and returns the card's next state
type CardInteractor interface {
	CardSchema
	CardActions
	Interact(ctx context.Context, in Interaction) (proto.Message, error)
}
