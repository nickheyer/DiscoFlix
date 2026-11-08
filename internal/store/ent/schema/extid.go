package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ExtID links an entity to one identifier in an external namespace such as imdb or tmdb
type ExtID struct{ ent.Schema }

func (ExtID) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (ExtID) Fields() []ent.Field {
	return []ent.Field{
		field.String("entity_id").NotEmpty(),
		field.String("namespace").NotEmpty().MaxLen(32),
		field.String("value").NotEmpty().MaxLen(128),
		field.Float("p_match").Default(1),
		field.String("source").Default(""),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (ExtID) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("entity", Entity.Type).Ref("ext_ids").Field("entity_id").Unique().Required(),
	}
}

func (ExtID) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("namespace", "value").Unique(),
		index.Fields("entity_id"),
	}
}
