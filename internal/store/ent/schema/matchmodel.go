package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
)

// MatchModel holds the learned Fellegi-Sunter weights for one entity kind
type MatchModel struct{ ent.Schema }

func (MatchModel) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.Bytes("weights"),
		field.Int64("pairs").Default(0),
		field.Time("trained_at").Default(time.Now).UpdateDefault(time.Now),
	}
}
