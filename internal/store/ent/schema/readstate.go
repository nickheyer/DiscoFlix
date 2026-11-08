package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ReadState is one User's read cursor on one Channel
type ReadState struct{ ent.Schema }

func (ReadState) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (ReadState) Fields() []ent.Field {
	return []ent.Field{
		field.String("user_id").NotEmpty(),
		field.String("channel_id").NotEmpty(),
		field.Int64("last_read_seq").Default(0),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ReadState) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("user", User.Type).Ref("read_states").Field("user_id").Unique().Required(),
		edge.From("channel", Channel.Type).Ref("read_states").Field("channel_id").Unique().Required(),
	}
}

func (ReadState) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "channel_id").Unique(),
	}
}
