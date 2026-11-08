package discord

import (
	"context"
	"fmt"
	"sort"
	"strings"

	dg "github.com/disgoorg/disgo/discord"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/nickheyer/DiscoFlix/internal/extension"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

// Accent colors shared with the web palette
const (
	colorInfo    = 0x7289da
	colorSuccess = 0x43b581
	colorWarning = 0xfaa61a
	colorDanger  = 0xf04747
	colorNeutral = 0x4f545c
)

const (
	maxText  = 4000
	maxBlock = 1500
)

// renderMessage builds the Components V2 layout for a bot-sent row, content first then the card
func (s *Service) renderMessage(ctx context.Context, m *ent.Message) ([]dg.LayoutComponent, error) {
	var out []dg.LayoutComponent
	if m.Content != "" {
		out = append(out, dg.NewTextDisplay(clip(m.Content, maxText)))
	}
	if m.CardType != "" {
		cs, ok := s.Cards.CardSchema(m.CardType)
		if !ok {
			return nil, fmt.Errorf("discord: no schema registered for card %s", m.CardType)
		}
		card := cs.Message()
		if err := proto.Unmarshal(m.Card, card); err != nil {
			return nil, fmt.Errorf("discord: decode card %s: %w", m.CardType, err)
		}
		out = append(out, s.renderCard(m.ID, card, cs))
	}
	if len(out) == 0 {
		out = append(out, dg.NewTextDisplay("\u200b"))
	}
	_ = ctx
	return out, nil
}

// renderCard turns a card into one container with its text, state, and action buttons
func (s *Service) renderCard(seq int64, card proto.Message, cs extension.CardSchema) dg.ContainerComponent {
	var parts []dg.ContainerSubComponent
	var color int
	switch c := card.(type) {
	case *cardv1.Approval:
		color, parts = renderApproval(c)
	case *cardv1.SystemNotice:
		color = severityColor(c.GetSeverity())
		parts = append(parts, dg.NewTextDisplay(heading(c.GetTitle(), "Notice")))
		if c.GetBody() != "" {
			parts = append(parts, dg.NewTextDisplay(clip(c.GetBody(), maxBlock)))
		}
	default:
		color = colorInfo
		parts = append(parts, dg.NewTextDisplay(heading(string(card.ProtoReflect().Descriptor().Name()), "Card")))
		if fields := renderFields(card.ProtoReflect(), 0); fields != "" {
			parts = append(parts, dg.NewTextDisplay(clip(fields, maxBlock)))
		}
	}
	if actions, ok := cs.(extension.CardActions); ok {
		if buttons := actionButtons(seq, actions.Actions(card)); len(buttons) > 0 {
			parts = append(parts, dg.NewSmallSeparator(), dg.NewActionRow(buttons...))
		}
	}
	parts = append(parts, dg.NewTextDisplay("-# "+string(card.ProtoReflect().Descriptor().FullName())))
	return dg.NewContainer(parts...).WithAccentColor(color)
}

// renderApproval lays out the approval request and its decision
func renderApproval(c *cardv1.Approval) (int, []dg.ContainerSubComponent) {
	parts := []dg.ContainerSubComponent{dg.NewTextDisplay(heading(c.GetTitle(), "Approval"))}
	if c.GetBody() != "" {
		parts = append(parts, dg.NewTextDisplay(clip(c.GetBody(), maxBlock)))
	}
	if c.GetInputJson() != "" {
		parts = append(parts, dg.NewTextDisplay("**Request** `"+c.GetProcedure()+"`\n```json\n"+clip(c.GetInputJson(), 900)+"\n```"))
	}
	color := colorWarning
	state := "⏳ Waiting for a space administrator"
	by := c.GetDecidedByName()
	if by == "" {
		by = c.GetDecidedBy()
	}
	switch c.GetState() {
	case cardv1.ApprovalState_APPROVAL_STATE_APPROVED:
		color, state = colorInfo, "✅ Approved by "+by+", running"
	case cardv1.ApprovalState_APPROVAL_STATE_DENIED:
		color, state = colorDanger, "⛔ Denied by "+by
	case cardv1.ApprovalState_APPROVAL_STATE_EXECUTED:
		color, state = colorSuccess, "✅ Approved by "+by+" and done"
	case cardv1.ApprovalState_APPROVAL_STATE_FAILED:
		color, state = colorDanger, "❌ Approved by "+by+" but failed"
	}
	if at := c.GetDecidedAt(); at != nil {
		state += fmt.Sprintf(" <t:%d:R>", at.AsTime().Unix())
	}
	parts = append(parts, dg.NewTextDisplay(state))
	if c.GetResult() != "" && c.GetResult() != "Done" {
		parts = append(parts, dg.NewTextDisplay("```\n"+clip(c.GetResult(), 900)+"\n```"))
	}
	return color, parts
}

func severityColor(sv cardv1.Severity) int {
	switch sv {
	case cardv1.Severity_SEVERITY_SUCCESS:
		return colorSuccess
	case cardv1.Severity_SEVERITY_WARNING:
		return colorWarning
	case cardv1.Severity_SEVERITY_ERROR:
		return colorDanger
	case cardv1.Severity_SEVERITY_INFO:
		return colorInfo
	}
	return colorNeutral
}

// actionButtons renders card actions as buttons whose custom ids route back to InteractCard
func actionButtons(seq int64, actions []extension.Action) []dg.InteractiveComponent {
	var out []dg.InteractiveComponent
	for i, a := range actions {
		if i == 5 {
			break
		}
		id := fmt.Sprintf("card:%d:%s", seq, a.ID)
		switch a.Style {
		case "success":
			out = append(out, dg.NewSuccessButton(a.Label, id))
		case "danger":
			out = append(out, dg.NewDangerButton(a.Label, id))
		case "primary":
			out = append(out, dg.NewPrimaryButton(a.Label, id))
		default:
			out = append(out, dg.NewSecondaryButton(a.Label, id))
		}
	}
	return out
}

func heading(title, fallback string) string {
	if strings.TrimSpace(title) == "" {
		title = fallback
	}
	return "## " + clip(title, 200)
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// renderFields lists set fields of any message as bold names with values, nesting one level
func renderFields(m protoreflect.Message, depth int) string {
	var lines []string
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		lines = append(lines, renderField(fd, v, depth))
		return true
	})
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func renderField(fd protoreflect.FieldDescriptor, v protoreflect.Value, depth int) string {
	name := humanize(string(fd.Name()))
	indent := strings.Repeat("  ", depth)
	switch {
	case fd.IsList():
		return fmt.Sprintf("%s**%s**: %d items", indent, name, v.List().Len())
	case fd.IsMap():
		return fmt.Sprintf("%s**%s**: %d entries", indent, name, v.Map().Len())
	case fd.Kind() == protoreflect.MessageKind:
		if ts, ok := v.Message().Interface().(*timestamppb.Timestamp); ok {
			return fmt.Sprintf("%s**%s**: <t:%d:f>", indent, name, ts.AsTime().Unix())
		}
		if depth >= 1 {
			raw, _ := protojson.Marshal(v.Message().Interface())
			return fmt.Sprintf("%s**%s**: `%s`", indent, name, clip(string(raw), 200))
		}
		return fmt.Sprintf("%s**%s**\n%s", indent, name, renderFields(v.Message(), depth+1))
	case fd.Kind() == protoreflect.EnumKind:
		return fmt.Sprintf("%s**%s**: %s", indent, name, enumLabel(fd, v.Enum()))
	case fd.Kind() == protoreflect.BytesKind:
		return fmt.Sprintf("%s**%s**: %d bytes", indent, name, len(v.Bytes()))
	}
	return fmt.Sprintf("%s**%s**: %s", indent, name, clip(v.String(), 300))
}

// enumLabel strips the ENUM_NAME_ prefix and lowercases, so SEVERITY_WARNING reads as warning
func enumLabel(fd protoreflect.FieldDescriptor, n protoreflect.EnumNumber) string {
	ev := fd.Enum().Values().ByNumber(n)
	if ev == nil {
		return fmt.Sprint(n)
	}
	prefix := strings.ToUpper(snake(string(fd.Enum().Name()))) + "_"
	return strings.ToLower(strings.TrimPrefix(string(ev.Name()), prefix))
}

func humanize(s string) string {
	s = strings.ReplaceAll(s, "_", " ")
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// snake turns CamelCase into snake_case
func snake(s string) string {
	var b strings.Builder
	for i, r := range s {
		if i > 0 && r >= 'A' && r <= 'Z' {
			b.WriteByte('_')
		}
		b.WriteRune(r)
	}
	return strings.ToLower(b.String())
}

// renderReply formats a capability output for an ephemeral command response
func renderReply(out proto.Message) string {
	m := out.ProtoReflect()
	if url := m.Descriptor().Fields().ByName("url"); url != nil && m.Has(url) {
		text := m.Get(url).String()
		if exp := m.Descriptor().Fields().ByName("expires_at"); exp != nil && m.Has(exp) {
			if ts, ok := m.Get(exp).Message().Interface().(*timestamppb.Timestamp); ok {
				return fmt.Sprintf("%s\nThis link works until <t:%d:t> and only once.", text, ts.AsTime().Unix())
			}
		}
		return text
	}
	fields := renderFields(m, 0)
	if fields == "" {
		return "Done"
	}
	return clip(fields, 1900)
}
