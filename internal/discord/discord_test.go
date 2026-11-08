package discord

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"buf.build/gen/go/bufbuild/protovalidate/protocolbuffers/go/buf/validate"
	"buf.build/go/protovalidate"
	connect "connectrpc.com/connect/v2"
	dg "github.com/disgoorg/disgo/discord"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/approval"
	"github.com/nickheyer/DiscoFlix/internal/capability"
	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/presence"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/channel"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/message"
	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
	discordv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/discord/v1"
	identityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/identity/v1"
	timelinev1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/timeline/v1"
)

func newRegistry(t *testing.T) *capability.Registry {
	t.Helper()
	reg := capability.NewRegistry()
	for _, sd := range []protoreflect.ServiceDescriptor{
		capabilityv1.File_discoflix_capability_v1_capability_proto.Services().ByName("CapabilityService"),
		timelinev1.File_discoflix_timeline_v1_timeline_proto.Services().ByName("TimelineService"),
		identityv1.File_discoflix_identity_v1_identity_proto.Services().ByName("IdentityService"),
		discordv1.File_discoflix_discord_v1_discord_proto.Services().ByName("DiscordService"),
	} {
		if err := reg.AddService(sd); err != nil {
			t.Fatal(err)
		}
	}
	return reg
}

func TestDescribe(t *testing.T) {
	for _, c := range []struct {
		m    dg.Message
		kind message.Kind
		text string
	}{
		{dg.Message{Type: dg.MessageTypeDefault, Content: "hello"}, message.KindUser, "hello"},
		{dg.Message{Type: dg.MessageTypeReply, Content: "replying"}, message.KindUser, "replying"},
		{dg.Message{Type: dg.MessageTypeDefault, Embeds: []dg.Embed{{Title: "Only an embed"}}}, message.KindUser, "**Only an embed**"},
		{dg.Message{Type: dg.MessageTypeUserJoin}, message.KindSystem, "joined the server"},
		{dg.Message{Type: dg.MessageTypeChannelPinnedMessage}, message.KindSystem, "pinned a message to this channel"},
		{dg.Message{Type: dg.MessageTypeThreadCreated, Content: "plans"}, message.KindSystem, "started a thread: plans"},
		{dg.Message{Type: dg.MessageTypeChannelNameChange, Content: "lounge"}, message.KindSystem, "changed the channel name to lounge"},
		{dg.Message{Type: dg.MessageTypeRecipientAdd}, message.KindSystem, "system message of type 1"},
		{dg.Message{Type: dg.MessageTypeCall, Content: "rang"}, message.KindSystem, "rang"},
	} {
		kind, text := describe(c.m)
		if kind != c.kind || text != c.text {
			t.Errorf("describe type %d = %s %q, want %s %q", c.m.Type, kind, text, c.kind, c.text)
		}
	}
}

func TestContentOf(t *testing.T) {
	rich := dg.Message{
		Embeds:       []dg.Embed{{Title: "Trailer", Description: "Out now", URL: "https://example.com/t"}, {Description: "second embed"}},
		StickerItems: []dg.MessageSticker{{Name: "wave"}, {Name: "party"}},
	}
	if got, want := contentOf(rich), "**Trailer**\nOut now\nhttps://example.com/t\nsecond embed\n[sticker: wave]\n[sticker: party]"; got != want {
		t.Fatalf("embeds and stickers = %q, want %q", got, want)
	}
	rich.Content = "text wins"
	if got := contentOf(rich); got != "text wins" {
		t.Fatalf("content with embeds = %q", got)
	}
	if got := contentOf(dg.Message{}); got != "" {
		t.Fatalf("empty message = %q", got)
	}
}

func TestWebhookUsername(t *testing.T) {
	for in, want := range map[string]string{
		"  Clyde Bot ":   "C1yde Bot",
		"my discord pal": "my disc0rd pal",
		"Discord Mod":    "Disc0rd Mod",
		"CLYDE fan":      "C1YDE fan",
		"DisCord":        "DisC0rd",
		"clydeDISCORD":   "c1ydeDISC0RD",
		"Nick":           "Nick",
		"":               "Member",
		"   ":            "Member",
	} {
		got := webhookUsername(in)
		if got != want {
			t.Errorf("username %q = %q, want %q", in, got, want)
		}
		lower := strings.ToLower(got)
		if strings.Contains(lower, "clyde") || strings.Contains(lower, "discord") {
			t.Errorf("username %q kept a reserved word in %q", in, got)
		}
	}
	long := strings.Repeat("é", 100)
	if got := webhookUsername(long); len([]rune(got)) != 80 || got != strings.Repeat("é", 80) {
		t.Fatalf("long name = %d runes", len([]rune(got)))
	}
	exact := strings.Repeat("a", 80)
	if got := webhookUsername(exact); got != exact {
		t.Fatalf("80 rune name changed to %q", got)
	}
}

func TestStatusOf(t *testing.T) {
	for in, want := range map[dg.OnlineStatus]presence.Status{
		dg.OnlineStatusOnline:    presence.Online,
		dg.OnlineStatusIdle:      presence.Idle,
		dg.OnlineStatusDND:       presence.DND,
		dg.OnlineStatusOffline:   presence.Offline,
		dg.OnlineStatusInvisible: presence.Offline,
		"":                       presence.Offline,
	} {
		if got := statusOf(in); got != want {
			t.Errorf("status %q = %s, want %s", in, got, want)
		}
	}
}

func TestExplainClose(t *testing.T) {
	intents := explainClose(errors.New("websocket: close 4014: Disallowed intent(s)."))
	if !strings.Contains(intents, "Enable Server Members Intent, Presence Intent, and Message Content Intent") || !strings.Contains(intents, "developer portal") {
		t.Fatalf("4014 = %q", intents)
	}
	if got := explainClose(errors.New("websocket: close 4004: Authentication failed.")); !strings.HasPrefix(got, "Discord rejected the bot token") {
		t.Fatalf("4004 = %q", got)
	}
	if got := explainClose(errors.New("websocket: close 4013: Invalid intent(s).")); !strings.Contains(got, "invalid intents") {
		t.Fatalf("4013 = %q", got)
	}
	if got := explainClose(errors.New("connection reset")); got != "connection reset" {
		t.Fatalf("other close = %q", got)
	}
}

// Summarizes one slash command parameter as name, type, required flag, and choices
func describeOption(t *testing.T, o dg.ApplicationCommandOption) string {
	t.Helper()
	switch v := o.(type) {
	case dg.ApplicationCommandOptionString:
		var choices []string
		for _, c := range v.Choices {
			choices = append(choices, c.Name+"="+c.Value)
		}
		return fmt.Sprintf("%s string %t %v", v.Name, v.Required, choices)
	case dg.ApplicationCommandOptionInt:
		return fmt.Sprintf("%s int %t", v.Name, v.Required)
	case dg.ApplicationCommandOptionBool:
		return fmt.Sprintf("%s bool %t", v.Name, v.Required)
	case dg.ApplicationCommandOptionFloat:
		return fmt.Sprintf("%s float %t", v.Name, v.Required)
	}
	t.Fatalf("unexpected option type %T", o)
	return ""
}

func describeOptions(t *testing.T, opts []dg.ApplicationCommandOption) []string {
	t.Helper()
	out := make([]string, len(opts))
	for i, o := range opts {
		out[i] = describeOption(t, o)
	}
	return out
}

func TestOptionsForServiceAccount(t *testing.T) {
	md := identityv1.File_discoflix_identity_v1_identity_proto.Messages().ByName("CreateServiceAccountRequest")
	got := describeOptions(t, optionsFor(md))
	want := []string{
		"display_name string true []",
		"kind string true [bot=USER_KIND_BOT agent=USER_KIND_AGENT]",
		"key_name string true []",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("options = %q, want %q", got, want)
	}
	if opt := optionsFor(md)[0].(dg.ApplicationCommandOptionString); opt.Description != "Display name" {
		t.Fatalf("description = %q", opt.Description)
	}
}

// Builds a descriptor declaring optional fields before required ones, with an enum limited by not_in
func probeMessage(t *testing.T) protoreflect.MessageDescriptor {
	t.Helper()
	withRules := func(r *validate.FieldRules) *descriptorpb.FieldOptions {
		opts := &descriptorpb.FieldOptions{}
		proto.SetExtension(opts, validate.E_Field, r)
		return opts
	}
	field := func(name string, n int32, typ descriptorpb.FieldDescriptorProto_Type, opts *descriptorpb.FieldOptions) *descriptorpb.FieldDescriptorProto {
		return &descriptorpb.FieldDescriptorProto{Name: new(name), JsonName: new(name), Number: new(n), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(), Type: typ.Enum(), Options: opts}
	}
	kind := field("kind", 5, descriptorpb.FieldDescriptorProto_TYPE_ENUM, withRules(validate.FieldRules_builder{Enum: validate.EnumRules_builder{NotIn: []int32{0, 3}}.Build()}.Build()))
	kind.TypeName = new(".discoflix.identity.v1.UserKind")
	tags := field("tags", 4, descriptorpb.FieldDescriptorProto_TYPE_STRING, nil)
	tags.Label = descriptorpb.FieldDescriptorProto_LABEL_REPEATED.Enum()
	fdp := &descriptorpb.FileDescriptorProto{
		Name:       new("discoflix/probe/v1/probe.proto"),
		Package:    new("discoflix.probe.v1"),
		Syntax:     new("proto3"),
		Dependency: []string{identityv1.File_discoflix_identity_v1_identity_proto.Path()},
		MessageType: []*descriptorpb.DescriptorProto{{
			Name: new("Probe"),
			Field: []*descriptorpb.FieldDescriptorProto{
				field("note", 1, descriptorpb.FieldDescriptorProto_TYPE_STRING, nil),
				field("count", 2, descriptorpb.FieldDescriptorProto_TYPE_INT64, withRules(validate.FieldRules_builder{Int64: validate.Int64Rules_builder{Gt: new(int64(0))}.Build()}.Build())),
				field("title", 3, descriptorpb.FieldDescriptorProto_TYPE_STRING, withRules(validate.FieldRules_builder{String: validate.StringRules_builder{MinLen: new(uint64(1))}.Build()}.Build())),
				tags,
				kind,
				field("flag", 6, descriptorpb.FieldDescriptorProto_TYPE_BOOL, nil),
				field("ratio", 7, descriptorpb.FieldDescriptorProto_TYPE_DOUBLE, nil),
				field("page", 8, descriptorpb.FieldDescriptorProto_TYPE_INT32, withRules(validate.FieldRules_builder{Int32: validate.Int32Rules_builder{Gte: new(int32(0))}.Build()}.Build())),
			},
		}},
	}
	fd, err := protodesc.NewFile(fdp, protoregistry.GlobalFiles)
	if err != nil {
		t.Fatal(err)
	}
	return fd.Messages().ByName("Probe")
}

func TestOptionsPutRequiredFirst(t *testing.T) {
	got := describeOptions(t, optionsFor(probeMessage(t)))
	want := []string{
		"count int true",
		"title string true []",
		"kind string true [person=USER_KIND_PERSON bot=USER_KIND_BOT agent=USER_KIND_AGENT]",
		"note string false []",
		"flag bool false",
		"ratio float false",
		"page int false",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("options = %q, want %q", got, want)
	}
}

func TestIsRequired(t *testing.T) {
	sa := identityv1.File_discoflix_identity_v1_identity_proto.Messages().ByName("CreateServiceAccountRequest").Fields()
	tl := timelinev1.File_discoflix_timeline_v1_timeline_proto.Messages()
	for _, c := range []struct {
		fd   protoreflect.FieldDescriptor
		want bool
	}{
		{sa.ByName("display_name"), true},
		{sa.ByName("kind"), true},
		{sa.ByName("expires_at"), false},
		{tl.ByName("DeleteMessageRequest").Fields().ByName("seq"), true},
		{tl.ByName("ListMessagesRequest").Fields().ByName("limit"), false},
		{tl.ByName("ListMessagesRequest").Fields().ByName("before_seq"), false},
		{tl.ByName("PostMessageRequest").Fields().ByName("content"), false},
	} {
		if got := isRequired(c.fd); got != c.want {
			t.Errorf("required %s = %t, want %t", c.fd.FullName(), got, c.want)
		}
	}
}

// Every option marked optional must validate when omitted and every required one must fail
func TestIsRequiredMatchesValidator(t *testing.T) {
	reg := newRegistry(t)
	checked := 0
	for e := range reg.All() {
		mt, err := protoregistry.GlobalTypes.FindMessageByName(e.Input.FullName())
		if err != nil {
			t.Fatal(err)
		}
		violated := map[string]bool{}
		var verr *protovalidate.ValidationError
		if err := protovalidate.Validate(mt.New().Interface()); errors.As(err, &verr) {
			for _, v := range verr.Violations {
				if elems := v.Proto.GetField().GetElements(); len(elems) > 0 {
					violated[elems[0].GetFieldName()] = true
				}
			}
		} else if err != nil {
			t.Fatal(err)
		}
		fields := e.Input.Fields()
		for i := range fields.Len() {
			fd := fields.Get(i)
			if fd.IsList() || fd.IsMap() || fd.Kind() == protoreflect.MessageKind {
				continue
			}
			checked++
			if got, want := isRequired(fd), violated[string(fd.Name())]; got != want {
				t.Errorf("required %s = %t, validator rejects zero = %t", fd.FullName(), got, want)
			}
		}
	}
	if checked < 20 {
		t.Fatalf("only %d fields checked", checked)
	}
}

func TestCommandCreates(t *testing.T) {
	reg := newRegistry(t)
	s := &Service{Registry: reg}
	creates := s.commandCreates()
	var names []string
	for _, c := range creates {
		cmd, ok := c.(dg.SlashCommandCreate)
		if !ok {
			t.Fatalf("command type %T", c)
		}
		names = append(names, cmd.Name)
		e, _ := reg.ByCommand(cmd.Name)
		if cmd.Description == "" || len([]rune(cmd.Description)) > 100 || cmd.Description != e.Description {
			t.Errorf("%s description = %q", cmd.Name, cmd.Description)
		}
		if !slices.Equal(cmd.IntegrationTypes, []dg.ApplicationIntegrationType{dg.ApplicationIntegrationTypeGuildInstall, dg.ApplicationIntegrationTypeUserInstall}) {
			t.Errorf("%s integration types = %v", cmd.Name, cmd.IntegrationTypes)
		}
		if !slices.Equal(cmd.Contexts, []dg.InteractionContextType{dg.InteractionContextTypeGuild, dg.InteractionContextTypeBotDM, dg.InteractionContextTypePrivateChannel}) {
			t.Errorf("%s contexts = %v", cmd.Name, cmd.Contexts)
		}
		if len(cmd.Options) != len(optionsFor(e.Input)) {
			t.Errorf("%s options = %v", cmd.Name, cmd.Options)
		}
	}
	if !slices.Equal(names, []string{"link", "status", "whoami"}) {
		t.Fatalf("commands = %v", names)
	}
}

// Builds a mirror holding only the Approval schema with its interactor
func cardService(t *testing.T) (*Service, extension.CardSchema) {
	t.Helper()
	cards := extension.NewRegistry()
	cs := approval.New(nil, nil, nil, nil, nil).Card()
	if err := cards.Register(cs); err != nil {
		t.Fatal(err)
	}
	return &Service{Cards: cards}, cs
}

func actionRows(c dg.ContainerComponent) []dg.ActionRowComponent {
	var out []dg.ActionRowComponent
	for _, sub := range c.Components {
		if row, ok := sub.(dg.ActionRowComponent); ok {
			out = append(out, row)
		}
	}
	return out
}

func texts(c dg.ContainerComponent) string {
	var b strings.Builder
	for _, sub := range c.Components {
		if td, ok := sub.(dg.TextDisplayComponent); ok {
			b.WriteString(td.Content + "\n")
		}
	}
	return b.String()
}

func TestRenderApprovalCard(t *testing.T) {
	s, cs := cardService(t)
	pending := &cardv1.Approval{
		ActionId:  "a1",
		Title:     "Delete message needs approval",
		Body:      "Helper (agent) asked to run delete message.",
		Procedure: "/discoflix.timeline.v1.TimelineService/DeleteMessage",
		InputJson: `{"seq": "7"}`,
		State:     cardv1.ApprovalState_APPROVAL_STATE_PENDING,
	}
	c := s.renderCard(42, pending, cs)
	if c.AccentColor != colorWarning {
		t.Fatalf("pending color = %x", c.AccentColor)
	}
	rows := actionRows(c)
	if len(rows) != 1 || len(rows[0].Components) != 2 {
		t.Fatalf("pending action rows = %+v", rows)
	}
	approve, ok1 := rows[0].Components[0].(dg.ButtonComponent)
	deny, ok2 := rows[0].Components[1].(dg.ButtonComponent)
	if !ok1 || !ok2 || approve.CustomID != "card:42:approve" || approve.Style != dg.ButtonStyleSuccess || approve.Label != "Approve" ||
		deny.CustomID != "card:42:deny" || deny.Style != dg.ButtonStyleDanger || deny.Label != "Deny" {
		t.Fatalf("buttons = %+v %+v", approve, deny)
	}
	body := texts(c)
	for _, want := range []string{"## Delete message needs approval", "Helper (agent) asked", "**Request** `/discoflix.timeline.v1.TimelineService/DeleteMessage`", "⏳ Waiting for a space administrator", "-# discoflix.card.v1.Approval"} {
		if !strings.Contains(body, want) {
			t.Fatalf("pending text lacks %q in %q", want, body)
		}
	}
	if last, ok := c.Components[len(c.Components)-1].(dg.TextDisplayComponent); !ok || last.Content != "-# discoflix.card.v1.Approval" {
		t.Fatalf("footer = %+v", c.Components[len(c.Components)-1])
	}

	decided := time.Unix(1_700_000_000, 0)
	executed := proto.Clone(pending).(*cardv1.Approval)
	executed.State, executed.DecidedByName, executed.DecidedAt, executed.Result = cardv1.ApprovalState_APPROVAL_STATE_EXECUTED, "Nick", timestamppb.New(decided), "Done"
	done := s.renderCard(42, executed, cs)
	if len(actionRows(done)) != 0 || done.AccentColor != colorSuccess {
		t.Fatalf("executed card = %+v", done)
	}
	if body := texts(done); !strings.Contains(body, "✅ Approved by Nick and done <t:1700000000:R>") || strings.Contains(body, "```\nDone") {
		t.Fatalf("executed text = %q", body)
	}
	failed := proto.Clone(executed).(*cardv1.Approval)
	failed.State, failed.Result = cardv1.ApprovalState_APPROVAL_STATE_FAILED, "not allowed"
	if f := s.renderCard(42, failed, cs); f.AccentColor != colorDanger || !strings.Contains(texts(f), "```\nnot allowed\n```") || len(actionRows(f)) != 0 {
		t.Fatalf("failed card = %+v", f)
	}
}

func TestRenderMessage(t *testing.T) {
	s, _ := cardService(t)
	raw, err := proto.Marshal(&cardv1.Approval{Title: "Approve me", State: cardv1.ApprovalState_APPROVAL_STATE_PENDING})
	if err != nil {
		t.Fatal(err)
	}
	m := &ent.Message{ID: 9, Content: "Approval requested by Helper", CardType: extension.TypeURLOf((&cardv1.Approval{}).ProtoReflect().Descriptor()), Card: raw}
	out, err := s.renderMessage(t.Context(), m)
	if err != nil || len(out) != 2 {
		t.Fatalf("render = %v, %v", out, err)
	}
	if td, ok := out[0].(dg.TextDisplayComponent); !ok || td.Content != "Approval requested by Helper" {
		t.Fatalf("content component = %+v", out[0])
	}
	container, ok := out[1].(dg.ContainerComponent)
	if !ok || len(actionRows(container)) != 1 || actionRows(container)[0].Components[0].(dg.ButtonComponent).CustomID != "card:9:approve" {
		t.Fatalf("card component = %+v", out[1])
	}
	if _, err := s.renderMessage(t.Context(), &ent.Message{ID: 10, CardType: "type.googleapis.com/acme.Unknown"}); err == nil {
		t.Fatal("unknown card rendered")
	}
	if out, err := s.renderMessage(t.Context(), &ent.Message{ID: 11}); err != nil || len(out) != 1 {
		t.Fatalf("empty message = %v, %v", out, err)
	}
}

func TestRenderReply(t *testing.T) {
	expires := time.Unix(1_700_000_000, 0)
	got := renderReply(&identityv1.CreateLinkCodeResponse{Url: "http://host:1/link/abc", ExpiresAt: timestamppb.New(expires)})
	if !strings.HasPrefix(got, "http://host:1/link/abc\n") || !strings.Contains(got, "<t:1700000000:t>") {
		t.Fatalf("link reply = %q", got)
	}
	if got := renderReply(&identityv1.CreateLinkCodeResponse{Url: "http://host:1/link/abc"}); got != "http://host:1/link/abc" {
		t.Fatalf("link reply without expiry = %q", got)
	}
	if got := renderReply(&timelinev1.DeleteMessageResponse{}); got != "Done" {
		t.Fatalf("empty reply = %q", got)
	}
	info := renderReply(&identityv1.GetServerInfoResponse{Version: "1.2.3", SetupRequired: true})
	if !strings.Contains(info, "**Version**: 1.2.3") || !strings.Contains(info, "**Setup required**: true") {
		t.Fatalf("server info reply = %q", info)
	}
}

func TestActionButtonsCapAtFive(t *testing.T) {
	var actions []extension.Action
	for i, style := range []string{"success", "danger", "primary", "secondary", "", "success", "danger"} {
		actions = append(actions, extension.Action{ID: fmt.Sprintf("a%d", i), Label: fmt.Sprintf("A%d", i), Style: style})
	}
	buttons := actionButtons(3, actions)
	if len(buttons) != 5 {
		t.Fatalf("buttons = %d", len(buttons))
	}
	wantStyles := []dg.ButtonStyle{dg.ButtonStyleSuccess, dg.ButtonStyleDanger, dg.ButtonStylePrimary, dg.ButtonStyleSecondary, dg.ButtonStyleSecondary}
	for i, b := range buttons {
		btn := b.(dg.ButtonComponent)
		if btn.CustomID != fmt.Sprintf("card:3:a%d", i) || btn.Style != wantStyles[i] || btn.Label != fmt.Sprintf("A%d", i) {
			t.Errorf("button %d = %+v", i, btn)
		}
	}
	if len(actionButtons(3, nil)) != 0 {
		t.Fatal("buttons without actions")
	}
}

func TestChannelMapping(t *testing.T) {
	for typ, want := range map[dg.ChannelType]channel.Kind{
		dg.ChannelTypeGuildText:          channel.KindText,
		dg.ChannelTypeGuildNews:          channel.KindText,
		dg.ChannelTypeGuildCategory:      channel.KindCategory,
		dg.ChannelTypeGuildVoice:         channel.KindVoice,
		dg.ChannelTypeGuildStageVoice:    channel.KindVoice,
		dg.ChannelTypeGuildPublicThread:  channel.KindThread,
		dg.ChannelTypeGuildPrivateThread: channel.KindThread,
		dg.ChannelTypeGuildNewsThread:    channel.KindThread,
	} {
		if got, ok := channelKind(typ); !ok || got != want {
			t.Errorf("kind of %d = %s, %t", typ, got, ok)
		}
		if isThread(typ) != (want == channel.KindThread) {
			t.Errorf("thread %d = %t", typ, isThread(typ))
		}
	}
	if _, ok := channelKind(dg.ChannelTypeGuildForum); ok {
		t.Fatal("forum channels are mirrored")
	}
	if hexColor(0) != "" || hexColor(0x43b581) != "#43b581" || hexColor(0xff) != "#0000ff" {
		t.Fatalf("colors = %q %q %q", hexColor(0), hexColor(0x43b581), hexColor(0xff))
	}
}

func TestErrorText(t *testing.T) {
	if got := errorText(connect.NewError(connect.CodePermissionDenied, "not allowed: writer on message")); got != "not allowed: writer on message" {
		t.Fatalf("connect error = %q", got)
	}
	if got := errorText(errors.New("plain failure")); got != "plain failure" {
		t.Fatalf("plain error = %q", got)
	}
}
