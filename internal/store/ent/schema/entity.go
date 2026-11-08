package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Entity is one canonical catalog item such as a movie, series, season, or episode
type Entity struct{ ent.Schema }

func (Entity) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}, TimeMixin{}} }

func (Entity) Fields() []ent.Field {
	return []ent.Field{
		field.String("kind").NotEmpty().MaxLen(32),
		field.String("title").Default(""),
		field.Int32("year").Default(0),
		field.String("parent_id").Optional(),
		field.Int32("ordinal").Default(0),
		field.String("merged_into_id").Optional(),
		field.Time("resolved_at").Optional().Nillable(),
		field.Time("refreshed_at").Optional().Nillable(),
	}
}

func (Entity) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("children", Entity.Type).From("parent").Field("parent_id").Unique(),
		edge.To("ext_ids", ExtID.Type),
		edge.To("claims", Claim.Type),
		edge.To("fields", EntityField.Type),
		edge.To("titles", EntityTitle.Type),
		edge.To("artworks", Artwork.Type),
	}
}

func (Entity) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("kind", "title"),
		index.Fields("parent_id", "ordinal"),
		index.Fields("merged_into_id"),
	}
}
