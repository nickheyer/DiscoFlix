package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// EntityField is the resolved value of one field with the claim and policy reason that won
type EntityField struct{ ent.Schema }

func (EntityField) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (EntityField) Fields() []ent.Field {
	return []ent.Field{
		field.String("entity_id").NotEmpty(),
		field.String("field").NotEmpty().MaxLen(64),
		field.Bytes("value"),
		field.String("claim_id").NotEmpty(),
		field.String("source").NotEmpty().MaxLen(32),
		field.Enum("reason").Values("pin", "priority", "agreement", "recency", "only"),
		field.Int32("agreement").Default(1),
		field.Int32("claims").Default(1),
		field.Float32("confidence").Default(1),
		field.Time("observed_at").Default(time.Now),
		field.Time("resolved_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (EntityField) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("entity", Entity.Type).Ref("fields").Field("entity_id").Unique().Required(),
	}
}

func (EntityField) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("entity_id", "field").Unique(),
		index.Fields("field", "source"),
	}
}
