package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// TMDBExport is one row of a TMDB daily id export for movies or series
type TMDBExport struct{ ent.Schema }

func (TMDBExport) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Enum("kind").Values("movie", "series"),
		field.Int64("tmdb_id"),
		field.String("original_title").Default(""),
		field.String("normalized").Default(""),
		field.Float("popularity").Default(0),
		field.Bool("adult").Default(false),
		field.Bool("video").Default(false),
	}
}

func (TMDBExport) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("kind", "tmdb_id").Unique(),
		index.Fields("normalized"),
		index.Fields("kind", "popularity"),
	}
}
