package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Membership is a User's presence in a Space with roles
type Membership struct{ ent.Schema }

func (Membership) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (Membership) Fields() []ent.Field {
	return []ent.Field{
		field.String("user_id").NotEmpty(),
		field.String("space_id").NotEmpty(),
		field.Strings("roles").Default([]string{}),
		field.String("nickname").Default(""),
		field.Bool("admin").Default(false),
		field.Time("joined_at").Default(time.Now).Immutable(),
	}
}

func (Membership) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("user", User.Type).Ref("memberships").Field("user_id").Unique().Required(),
		edge.From("space", Space.Type).Ref("memberships").Field("space_id").Unique().Required(),
	}
}

func (Membership) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "space_id").Unique(),
		index.Fields("space_id"),
	}
}
