package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// IMDbTitle is one row of the IMDb title.basics dataset, keyed by tconst
type IMDbTitle struct{ ent.Schema }

func (IMDbTitle) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.String("title_type").Default(""),
		field.String("primary_title").Default(""),
		field.String("original_title").Default(""),
		field.String("normalized").Default(""),
		field.Bool("adult").Default(false),
		field.Int32("start_year").Default(0),
		field.Int32("end_year").Default(0),
		field.Int32("runtime").Default(0),
		field.String("genres").Default(""),
	}
}

func (IMDbTitle) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("normalized", "start_year"),
		index.Fields("title_type"),
	}
}

// IMDbRating is one row of the IMDb title.ratings dataset, keyed by tconst
type IMDbRating struct{ ent.Schema }

func (IMDbRating) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.Float32("rating").Default(0),
		field.Int32("votes").Default(0),
	}
}

// IMDbAka is one alternative title from the IMDb title.akas dataset
type IMDbAka struct{ ent.Schema }

func (IMDbAka) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("tconst").NotEmpty(),
		field.Int32("ordering").Default(0),
		field.String("title").Default(""),
		field.String("normalized").Default(""),
		field.String("region").Default(""),
		field.String("language").Default(""),
		field.String("types").Default(""),
		field.Bool("original").Default(false),
	}
}

func (IMDbAka) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("tconst", "ordering").Unique(),
		index.Fields("normalized"),
	}
}

// IMDbEpisode is one row of the IMDb title.episode dataset linking an episode to its series
type IMDbEpisode struct{ ent.Schema }

func (IMDbEpisode) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.String("parent").NotEmpty(),
		field.Int32("season").Default(0),
		field.Int32("episode").Default(0),
	}
}

func (IMDbEpisode) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("parent", "season", "episode"),
	}
}
