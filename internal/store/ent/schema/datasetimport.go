package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
)

// DatasetImport tracks one bulk dataset such as the IMDb title basics file, keyed by dataset name
type DatasetImport struct{ ent.Schema }

func (DatasetImport) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.Bool("enabled").Default(false),
		field.Enum("state").Values("idle", "downloading", "loading", "done", "failed").Default("idle"),
		field.Int64("rows").Default(0),
		field.Int64("bytes").Default(0),
		field.Text("error").Default(""),
		field.Time("started_at").Optional().Nillable(),
		field.Time("finished_at").Optional().Nillable(),
		field.String("etag").Default(""),
		field.Time("last_modified").Optional().Nillable(),
		field.String("workflow_id").Default(""),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}
