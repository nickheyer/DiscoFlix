package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
)

// SourceState is the health, budget, and options of one metadata source, keyed by its name
type SourceState struct{ ent.Schema }

func (SourceState) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.Bool("enabled").Default(true),
		field.Time("last_ok_at").Optional().Nillable(),
		field.String("last_error").Default(""),
		field.Time("last_error_at").Optional().Nillable(),
		field.Int32("calls_today").Default(0),
		field.Time("calls_reset_at").Default(time.Now),
		field.JSON("options", map[string]string{}).Optional(),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}
