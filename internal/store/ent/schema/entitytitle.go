package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// EntityTitle is one searchable title of an entity, its integer id anchors the FTS index
type EntityTitle struct{ ent.Schema }

func (EntityTitle) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("entity_id").NotEmpty(),
		field.String("title").NotEmpty().MaxLen(500),
		field.String("normalized").NotEmpty().MaxLen(500),
		field.String("lang").Default(""),
		field.Enum("kind").Values("primary", "original", "alias").Default("alias"),
		field.String("source").Default(""),
	}
}

func (EntityTitle) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("entity", Entity.Type).Ref("titles").Field("entity_id").Unique().Required(),
	}
}

func (EntityTitle) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("entity_id", "normalized", "lang").Unique(),
		index.Fields("normalized"),
	}
}
