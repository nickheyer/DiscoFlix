package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// User is the single representation of a person, bot, plugin, or agent
type User struct{ ent.Schema }

func (User) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}, TimeMixin{}} }

func (User) Fields() []ent.Field {
	return []ent.Field{
		field.String("display_name").NotEmpty().MaxLen(64),
		field.String("avatar_url").Default(""),
		field.String("accent_color").Default("7289da"),
		field.Enum("kind").Values("person", "bot", "plugin", "agent").Default("person"),
		field.Enum("status").Values("active", "disabled").Default("active"),
		field.Bool("system_admin").Default(false),
		field.Time("last_seen_at").Optional().Nillable(),
		field.String("merged_into_id").Optional(),
	}
}

func (User) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("identities", Identity.Type),
		edge.To("credentials", Credential.Type),
		edge.To("memberships", Membership.Type),
		edge.To("messages", Message.Type),
		edge.To("read_states", ReadState.Type),
		edge.To("reactions", Reaction.Type),
		edge.To("absorbed", User.Type).From("merged_into").Field("merged_into_id").Unique(),
	}
}

func (User) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("merged_into_id"),
	}
}
