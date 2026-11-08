package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
)

// Setting is one JSON value keyed by a dotted path, layered under the file config
type Setting struct{ ent.Schema }

func (Setting) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.Bytes("value"),
		field.Bool("secret").Default(false),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}
