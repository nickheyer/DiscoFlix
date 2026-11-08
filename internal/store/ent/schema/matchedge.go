package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MatchEdge records how an external candidate was linked to an entity and with what probability
type MatchEdge struct{ ent.Schema }

func (MatchEdge) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}, TimeMixin{}} }

func (MatchEdge) Fields() []ent.Field {
	return []ent.Field{
		field.String("entity_id").NotEmpty(),
		field.String("namespace").NotEmpty().MaxLen(32),
		field.String("value").NotEmpty().MaxLen(128),
		field.String("source").Default(""),
		field.String("candidate_title").Default(""),
		field.Int32("candidate_year").Default(0),
		field.Float("probability").Default(0),
		field.JSON("features", map[string]float64{}).Optional(),
		field.Int32("tier").Default(1),
		field.Enum("state").Values("auto", "review", "accepted", "rejected").Default("auto"),
		field.String("decided_by").Default(""),
		field.Time("decided_at").Optional().Nillable(),
		field.Int64("message_seq").Default(0),
	}
}

func (MatchEdge) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("entity_id"),
		index.Fields("namespace", "value"),
		index.Fields("state", "created_at"),
		index.Fields("message_seq"),
	}
}
