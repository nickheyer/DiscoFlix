package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Space is a context that people and automation share
type Space struct{ ent.Schema }

func (Space) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}, TimeMixin{}} }

func (Space) Fields() []ent.Field {
	return []ent.Field{
		field.Enum("kind").Values("system", "guild", "library", "plugin", "provider", "server"),
		field.String("name").NotEmpty().MaxLen(100),
		field.String("icon_url").Default(""),
		field.String("external_id").Default(""),
		field.Int32("position").Default(0),
		field.String("approvals_channel_id").Default(""),
		field.JSON("roles", []Role{}).Optional(),
	}
}

func (Space) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("channels", Channel.Type),
		edge.To("memberships", Membership.Type),
		edge.To("messages", Message.Type),
	}
}

func (Space) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("kind", "external_id"),
		index.Fields("position"),
	}
}
