package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Identity links one external or local account to a User
type Identity struct{ ent.Schema }

func (Identity) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}, TimeMixin{}} }

func (Identity) Fields() []ent.Field {
	return []ent.Field{
		field.String("user_id").NotEmpty(),
		field.String("provider").NotEmpty(),
		field.String("subject").NotEmpty(),
		field.String("display").Default(""),
		field.Time("verified_at").Optional().Nillable(),
		field.Time("linked_at").Optional().Nillable(),
	}
}

func (Identity) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("user", User.Type).Ref("identities").Field("user_id").Unique().Required(),
	}
}

func (Identity) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("provider", "subject").Unique(),
		index.Fields("user_id"),
	}
}
