package discord

import (
	"context"
	"errors"
	"slices"
	"strings"

	"buf.build/gen/go/bufbuild/protovalidate/protocolbuffers/go/buf/validate"
	connect "connectrpc.com/connect/v2"
	dg "github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/events"
	"github.com/disgoorg/disgo/rest"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/nickheyer/DiscoFlix/internal/extension"
)

const maxOptions = 25

// registerCommands derives slash commands from the capability registry and publishes them globally
func (s *Service) registerCommands(ctx context.Context) {
	client, err := s.Client()
	if err != nil {
		return
	}
	appID, err := s.ApplicationID(ctx)
	if err != nil {
		s.Log.Error("register commands", "error", err)
		return
	}
	creates := s.commandCreates()
	if _, err := client.Rest.SetGlobalCommands(appID, creates, rest.WithCtx(ctx)); err != nil {
		s.Log.Error("register commands", "error", err)
		s.setState(StateConnected, "Connected, but registering slash commands failed: "+err.Error())
		return
	}
	names := make([]string, 0, len(creates))
	for _, c := range creates {
		names = append(names, "/"+c.CommandName())
	}
	s.mu.Lock()
	s.commands = names
	s.mu.Unlock()
}

// commandCreates builds one slash command per registry entry that declares a command name
func (s *Service) commandCreates() []dg.ApplicationCommandCreate {
	var out []dg.ApplicationCommandCreate
	for _, e := range s.Registry.Commands() {
		desc := e.Description
		if desc == "" {
			desc = e.Title
		}
		if desc == "" {
			desc = e.Method
		}
		out = append(out, dg.SlashCommandCreate{
			Name:             e.Command,
			Description:      clip(desc, 100),
			Options:          optionsFor(e.Input),
			IntegrationTypes: []dg.ApplicationIntegrationType{dg.ApplicationIntegrationTypeGuildInstall, dg.ApplicationIntegrationTypeUserInstall},
			Contexts:         []dg.InteractionContextType{dg.InteractionContextTypeGuild, dg.InteractionContextTypeBotDM, dg.InteractionContextTypePrivateChannel},
		})
	}
	return out
}

// optionsFor maps scalar request fields onto command options, required ones first as Discord demands
func optionsFor(md protoreflect.MessageDescriptor) []dg.ApplicationCommandOption {
	var required, optional []dg.ApplicationCommandOption
	fields := md.Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		if fd.IsList() || fd.IsMap() {
			continue
		}
		name := strings.ToLower(string(fd.Name()))
		desc := clip(humanize(string(fd.Name())), 100)
		req := isRequired(fd)
		var opt dg.ApplicationCommandOption
		switch fd.Kind() {
		case protoreflect.StringKind:
			opt = dg.ApplicationCommandOptionString{Name: name, Description: desc, Required: req}
		case protoreflect.Int32Kind, protoreflect.Int64Kind, protoreflect.Sint32Kind, protoreflect.Sint64Kind, protoreflect.Uint32Kind, protoreflect.Uint64Kind:
			opt = dg.ApplicationCommandOptionInt{Name: name, Description: desc, Required: req}
		case protoreflect.BoolKind:
			opt = dg.ApplicationCommandOptionBool{Name: name, Description: desc, Required: req}
		case protoreflect.DoubleKind, protoreflect.FloatKind:
			opt = dg.ApplicationCommandOptionFloat{Name: name, Description: desc, Required: req}
		case protoreflect.EnumKind:
			var choices []dg.ApplicationCommandOptionChoiceString
			values := fd.Enum().Values()
			rules := fieldRules(fd).GetEnum()
			for j := range values.Len() {
				ev := values.Get(j)
				if ev.Number() == 0 || !enumAllowed(rules, ev.Number()) {
					continue
				}
				label := enumLabel(fd, ev.Number())
				choices = append(choices, dg.ApplicationCommandOptionChoiceString{Name: label, Value: string(ev.Name())})
				if len(choices) == 25 {
					break
				}
			}
			opt = dg.ApplicationCommandOptionString{Name: name, Description: desc, Required: req, Choices: choices}
		default:
			continue
		}
		if req {
			required = append(required, opt)
		} else {
			optional = append(optional, opt)
		}
	}
	out := slices.Concat(required, optional)
	if len(out) > maxOptions {
		out = out[:maxOptions]
	}
	return out
}

// Reads the protovalidate rules so fields whose zero value fails validation become required options
func isRequired(fd protoreflect.FieldDescriptor) bool {
	rules := fieldRules(fd)
	if rules == nil {
		return false
	}
	if rules.GetRequired() {
		return true
	}
	switch {
	case rules.GetString() != nil:
		return rules.GetString().GetMinLen() > 0
	case rules.GetInt64() != nil:
		r := rules.GetInt64()
		return (r.HasGt() && r.GetGt() >= 0) || r.GetGte() > 0
	case rules.GetInt32() != nil:
		r := rules.GetInt32()
		return (r.HasGt() && r.GetGt() >= 0) || r.GetGte() > 0
	case rules.GetBytes() != nil:
		return rules.GetBytes().GetMinLen() > 0
	case rules.GetEnum() != nil:
		return !enumAllowed(rules.GetEnum(), 0)
	}
	return false
}

// Returns the protovalidate constraints declared on a descriptor, nil when it declares none
func fieldRules(fd protoreflect.FieldDescriptor) *validate.FieldRules {
	opts := fd.Options()
	if opts == nil {
		return nil
	}
	rules, _ := proto.GetExtension(opts, validate.E_Field).(*validate.FieldRules)
	return rules
}

// Reports whether the in and not_in constraints accept a value number
func enumAllowed(r *validate.EnumRules, n protoreflect.EnumNumber) bool {
	if in := r.GetIn(); len(in) > 0 && !slices.Contains(in, int32(n)) {
		return false
	}
	return !slices.Contains(r.GetNotIn(), int32(n))
}

// fill copies the interaction's options into the request message
func fill(input proto.Message, data dg.SlashCommandInteractionData) {
	m := input.ProtoReflect()
	fields := m.Descriptor().Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		name := strings.ToLower(string(fd.Name()))
		switch fd.Kind() {
		case protoreflect.StringKind:
			if v, ok := data.OptString(name); ok {
				m.Set(fd, protoreflect.ValueOfString(v))
			}
		case protoreflect.Int32Kind, protoreflect.Sint32Kind:
			if v, ok := data.OptInt(name); ok {
				m.Set(fd, protoreflect.ValueOfInt32(int32(v)))
			}
		case protoreflect.Int64Kind, protoreflect.Sint64Kind:
			if v, ok := data.OptInt(name); ok {
				m.Set(fd, protoreflect.ValueOfInt64(int64(v)))
			}
		case protoreflect.Uint32Kind:
			if v, ok := data.OptInt(name); ok && v >= 0 {
				m.Set(fd, protoreflect.ValueOfUint32(uint32(v)))
			}
		case protoreflect.Uint64Kind:
			if v, ok := data.OptInt(name); ok && v >= 0 {
				m.Set(fd, protoreflect.ValueOfUint64(uint64(v)))
			}
		case protoreflect.BoolKind:
			if v, ok := data.OptBool(name); ok {
				m.Set(fd, protoreflect.ValueOfBool(v))
			}
		case protoreflect.DoubleKind:
			if v, ok := data.OptFloat(name); ok {
				m.Set(fd, protoreflect.ValueOfFloat64(v))
			}
		case protoreflect.FloatKind:
			if v, ok := data.OptFloat(name); ok {
				m.Set(fd, protoreflect.ValueOfFloat32(float32(v)))
			}
		case protoreflect.EnumKind:
			if v, ok := data.OptString(name); ok {
				if ev := fd.Enum().Values().ByName(protoreflect.Name(v)); ev != nil {
					m.Set(fd, protoreflect.ValueOfEnum(ev.Number()))
				}
			}
		}
	}
}

// onCommand runs a slash command through the capability invoker as the Discord user and replies privately
func (s *Service) onCommand(ctx context.Context, e *events.ApplicationCommandInteractionCreate) {
	data, ok := e.Data.(dg.SlashCommandInteractionData)
	if !ok {
		return
	}
	entry, ok := s.Registry.ByCommand(data.CommandName())
	if !ok {
		_ = e.CreateMessage(dg.MessageCreate{Content: "This command is no longer registered.", Flags: dg.MessageFlagEphemeral})
		return
	}
	if err := e.DeferCreateMessage(true); err != nil {
		s.Log.Warn("defer command", "command", data.CommandName(), "error", err)
		return
	}
	reply := func(text string) {
		client, err := s.Client()
		if err != nil {
			return
		}
		if _, err := client.Rest.UpdateInteractionResponse(e.ApplicationID(), e.Token(), dg.MessageUpdate{Content: &text}, rest.WithCtx(ctx)); err != nil {
			s.Log.Warn("reply to command", "command", data.CommandName(), "error", err)
		}
	}
	p, err := s.principalFor(ctx, e.User())
	if err != nil {
		reply("Could not resolve your DiscoFlix account: " + err.Error())
		return
	}
	input, _, err := s.Invoker.NewInput(entry.Procedure)
	if err != nil {
		reply(err.Error())
		return
	}
	fill(input, data)
	out, err := s.Invoker.Invoke(ctx, p, entry.Procedure, input)
	if err != nil {
		reply("⚠️ " + errorText(err))
		return
	}
	if card, cs, ok := s.cardOutput(out); ok {
		client, err := s.Client()
		if err != nil {
			return
		}
		update := dg.NewMessageUpdateV2(s.renderCard(0, card, cs))
		if _, err := client.Rest.UpdateInteractionResponse(e.ApplicationID(), e.Token(), update, rest.WithCtx(ctx)); err != nil {
			s.Log.Warn("reply with card", "command", data.CommandName(), "error", err)
			reply(renderReply(out))
		}
		return
	}
	reply(renderReply(out))
}

// cardOutput finds the first field of a command result that is a registered card, so the reply renders it
func (s *Service) cardOutput(out proto.Message) (proto.Message, extension.CardSchema, bool) {
	m := out.ProtoReflect()
	fields := m.Descriptor().Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		if fd.Kind() != protoreflect.MessageKind || fd.IsList() || fd.IsMap() || !m.Has(fd) {
			continue
		}
		cs, ok := s.Cards.CardSchema(extension.TypeURLOf(fd.Message()))
		if !ok {
			continue
		}
		return m.Get(fd).Message().Interface(), cs, true
	}
	return nil, nil, false
}

// errorText strips the Connect code prefix so Discord users read the sentence the server wrote
func errorText(err error) string {
	if ce, ok := errors.AsType[*connect.Error](err); ok {
		return ce.Message()
	}
	return err.Error()
}
