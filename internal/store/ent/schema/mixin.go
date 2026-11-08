package schema

import (
	"time"
	"uuid"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/mixin"
)

// NewID returns a time-ordered UUIDv7 string for primary keys
func NewID() string { return uuid.NewV7().String() }

// IDMixin gives an entity a UUIDv7 string primary key
type IDMixin struct{ mixin.Schema }

func (IDMixin) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").DefaultFunc(NewID).Immutable().NotEmpty(),
	}
}

// TimeMixin stamps creation and last update times
type TimeMixin struct{ mixin.Schema }

func (TimeMixin) Fields() []ent.Field {
	return []ent.Field{
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}
