package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Artwork is one image of an entity stored by content hash with its encoded variants
type Artwork struct{ ent.Schema }

func (Artwork) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (Artwork) Fields() []ent.Field {
	return []ent.Field{
		field.String("entity_id").NotEmpty(),
		field.Enum("kind").Values("poster", "backdrop", "logo", "still", "banner", "thumb"),
		field.String("source").NotEmpty().MaxLen(32),
		field.String("source_url").NotEmpty(),
		field.String("hash").Default(""),
		field.Int32("width").Default(0),
		field.Int32("height").Default(0),
		field.String("mime").Default(""),
		field.Int64("bytes").Default(0),
		field.Bytes("thumbhash").Optional(),
		field.JSON("variants", []ArtworkVariant{}).Optional(),
		field.String("language").Default(""),
		field.Float("score").Default(0),
		field.Enum("state").Values("pending", "ready", "failed").Default("pending"),
		field.Text("error").Default(""),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("fetched_at").Optional().Nillable(),
	}
}

func (Artwork) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("entity", Entity.Type).Ref("artworks").Field("entity_id").Unique().Required(),
	}
}

func (Artwork) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("entity_id", "source_url").Unique(),
		index.Fields("entity_id", "kind", "score"),
		index.Fields("hash"),
		index.Fields("state"),
	}
}
