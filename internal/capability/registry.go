package capability

import (
	"embed"
	"encoding/json"
	"fmt"
	"iter"
	"regexp"
	"slices"
	"strings"
	"sync"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"

	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
)

//go:embed jsonschema/*.jsonschema.bundle.json
var schemaFS embed.FS

// Entry is one capability derived from a proto method and its capability option
type Entry struct {
	Procedure string
	Name      string
	Service   string
	Method    string
	Scope     string
	Effect    capabilityv1.Effect
	Object    *capabilityv1.ObjectRef
	// Discord slash command name, empty keeps the entry off Discord
	Command         string
	Public          bool
	Title           string
	Description     string
	Input           protoreflect.MessageDescriptor
	Output          protoreflect.MessageDescriptor
	ServerStreaming bool
	ClientStreaming bool
	InputSchema     json.RawMessage
	OutputSchema    json.RawMessage
}

// Relation maps a scope to the authorization relation name checked for it
func (e *Entry) Relation() string { return Relation(e.Scope) }

// Relation converts dotted scope names into relation identifiers
func Relation(scope string) string { return strings.ReplaceAll(scope, ".", "_") }

// Registry holds every capability keyed by procedure path
type Registry struct {
	mu        sync.RWMutex
	byProc    map[string]*Entry
	byCommand map[string]*Entry
	ordered   []*Entry
}

// NewRegistry returns an empty registry
func NewRegistry() *Registry {
	return &Registry{byProc: map[string]*Entry{}, byCommand: map[string]*Entry{}}
}

var commandName = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// AddService registers every method of the service, failing when a method lacks a capability option
func (r *Registry) AddService(sd protoreflect.ServiceDescriptor) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	methods := sd.Methods()
	for i := range methods.Len() {
		md := methods.Get(i)
		opts, _ := md.Options().(*descriptorpb.MethodOptions)
		cap, _ := proto.GetExtension(opts, capabilityv1.E_Capability).(*capabilityv1.Capability)
		if cap == nil || cap.GetScope() == "" {
			return fmt.Errorf("capability: %s.%s has no capability option", sd.FullName(), md.Name())
		}
		if cap.GetEffect() == capabilityv1.Effect_EFFECT_UNSPECIFIED {
			return fmt.Errorf("capability: %s.%s has no effect", sd.FullName(), md.Name())
		}
		if obj := cap.GetObject(); obj != nil {
			if obj.GetType() == "" || obj.GetField() == "" {
				return fmt.Errorf("capability: %s.%s object needs type and field", sd.FullName(), md.Name())
			}
			if md.Input().Fields().ByName(protoreflect.Name(obj.GetField())) == nil {
				return fmt.Errorf("capability: %s.%s object field %q missing on %s", sd.FullName(), md.Name(), obj.GetField(), md.Input().FullName())
			}
		}
		if cmd := cap.GetCommand(); cmd != "" {
			if !commandName.MatchString(cmd) {
				return fmt.Errorf("capability: %s.%s command %q is not a valid Discord command name", sd.FullName(), md.Name(), cmd)
			}
			if md.IsStreamingServer() || md.IsStreamingClient() {
				return fmt.Errorf("capability: %s.%s streams and cannot be a command", sd.FullName(), md.Name())
			}
			if other, dup := r.byCommand[cmd]; dup {
				return fmt.Errorf("capability: command %q used by %s and %s", cmd, other.Procedure, md.FullName())
			}
		}
		e := &Entry{
			Procedure:       "/" + string(sd.FullName()) + "/" + string(md.Name()),
			Name:            string(sd.FullName()) + "." + string(md.Name()),
			Service:         string(sd.FullName()),
			Method:          string(md.Name()),
			Scope:           cap.GetScope(),
			Effect:          cap.GetEffect(),
			Object:          cap.GetObject(),
			Command:         cap.GetCommand(),
			Public:          cap.GetPublic(),
			Title:           cap.GetTitle(),
			Description:     cap.GetDescription(),
			Input:           md.Input(),
			Output:          md.Output(),
			ServerStreaming: md.IsStreamingServer(),
			ClientStreaming: md.IsStreamingClient(),
		}
		var err error
		if e.InputSchema, err = schemaFor(md.Input().FullName()); err != nil {
			return err
		}
		if e.OutputSchema, err = schemaFor(md.Output().FullName()); err != nil {
			return err
		}
		if _, dup := r.byProc[e.Procedure]; dup {
			return fmt.Errorf("capability: %s registered twice", e.Procedure)
		}
		r.byProc[e.Procedure] = e
		if e.Command != "" {
			r.byCommand[e.Command] = e
		}
		r.ordered = append(r.ordered, e)
	}
	slices.SortFunc(r.ordered, func(a, b *Entry) int { return strings.Compare(a.Procedure, b.Procedure) })
	return nil
}

func schemaFor(name protoreflect.FullName) (json.RawMessage, error) {
	data, err := schemaFS.ReadFile("jsonschema/" + string(name) + ".jsonschema.bundle.json")
	if err != nil {
		return nil, fmt.Errorf("capability: schema for %s: %w", name, err)
	}
	return json.RawMessage(data), nil
}

// Get returns the entry registered for a procedure path
func (r *Registry) Get(procedure string) (*Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.byProc[procedure]
	return e, ok
}

// ByCommand returns the entry registered under a Discord command name
func (r *Registry) ByCommand(name string) (*Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.byCommand[name]
	return e, ok
}

// Commands returns every entry exposed as a Discord command, in command name order
func (r *Registry) Commands() []*Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Entry, 0, len(r.byCommand))
	for _, e := range r.byCommand {
		out = append(out, e)
	}
	slices.SortFunc(out, func(a, b *Entry) int { return strings.Compare(a.Command, b.Command) })
	return out
}

// All iterates entries in procedure order
func (r *Registry) All() iter.Seq[*Entry] {
	return func(yield func(*Entry) bool) {
		r.mu.RLock()
		entries := slices.Clone(r.ordered)
		r.mu.RUnlock()
		for _, e := range entries {
			if !yield(e) {
				return
			}
		}
	}
}

// Len reports the number of registered capabilities
func (r *Registry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.ordered)
}
