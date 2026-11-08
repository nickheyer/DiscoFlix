package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AuthzOutbox stages one relationship tuple change until the authorization store applies it
type AuthzOutbox struct{ ent.Schema }

func (AuthzOutbox) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Enum("op").Values("write", "delete"),
		field.String("object").NotEmpty(),
		field.String("relation").NotEmpty(),
		field.String("subject").NotEmpty(),
		field.String("condition").Default(""),
		field.Bytes("condition_context").Optional(),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("applied_at").Optional().Nillable(),
		field.Int("attempts").Default(0),
		field.String("last_error").Default(""),
	}
}

func (AuthzOutbox) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("applied_at", "id"),
	}
}
