package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Claim is one source's assertion of one field value on an entity, claims only grow
type Claim struct{ ent.Schema }

func (Claim) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (Claim) Fields() []ent.Field {
	return []ent.Field{
		field.String("entity_id").NotEmpty(),
		field.String("field").NotEmpty().MaxLen(64),
		field.Bytes("value"),
		field.String("value_hash").NotEmpty().MaxLen(32),
		field.String("source").NotEmpty().MaxLen(32),
		field.String("record_id").Default(""),
		field.String("user_id").Default(""),
		field.Float32("confidence").Default(1),
		field.Int32("rank").Default(100),
		field.Bool("pinned").Default(false),
		field.Time("observed_at").Default(time.Now),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (Claim) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("entity", Entity.Type).Ref("claims").Field("entity_id").Unique().Required(),
	}
}

func (Claim) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("entity_id", "field", "source", "value_hash").Unique(),
		index.Fields("entity_id", "field"),
		index.Fields("source", "observed_at"),
	}
}
