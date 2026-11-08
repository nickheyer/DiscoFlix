package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Reaction is one User's emoji on one Message
type Reaction struct{ ent.Schema }

func (Reaction) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (Reaction) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("message_id"),
		field.String("user_id").NotEmpty(),
		field.String("emoji").NotEmpty().MaxLen(64),
		field.String("origin").Default(""),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (Reaction) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("message", Message.Type).Ref("reactions").Field("message_id").Unique().Required(),
		edge.From("user", User.Type).Ref("reactions").Field("user_id").Unique().Required(),
	}
}

func (Reaction) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("message_id", "user_id", "emoji").Unique(),
		index.Fields("message_id", "emoji"),
	}
}
