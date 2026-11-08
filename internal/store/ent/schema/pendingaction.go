package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PendingAction is one destructive capability call waiting on an approval card
type PendingAction struct{ ent.Schema }

func (PendingAction) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (PendingAction) Fields() []ent.Field {
	return []ent.Field{
		field.String("procedure").NotEmpty(),
		field.Bytes("input"),
		field.String("principal_user_id").NotEmpty(),
		field.String("principal_kind").NotEmpty(),
		field.String("principal_via").Default(""),
		field.Int64("message_seq").Default(0),
		field.Enum("state").Values("pending", "approved", "denied", "executed", "failed").Default("pending"),
		field.String("decided_by").Default(""),
		field.Time("decided_at").Optional().Nillable(),
		field.Text("result").Default(""),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (PendingAction) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("state", "created_at"),
		index.Fields("message_seq"),
	}
}
