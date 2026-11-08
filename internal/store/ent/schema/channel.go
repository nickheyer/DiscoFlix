package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Channel is an ordered stream of Messages inside a Space
type Channel struct{ ent.Schema }

func (Channel) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}, TimeMixin{}} }

func (Channel) Fields() []ent.Field {
	return []ent.Field{
		field.String("space_id").NotEmpty(),
		field.Enum("kind").Values("text", "category", "voice", "thread").Default("text"),
		field.String("name").NotEmpty().MaxLen(100),
		field.String("topic").Default(""),
		field.String("parent_id").Default(""),
		field.Int32("position").Default(0),
		field.String("external_id").Default(""),
		field.Int64("last_seq").Default(0),
		field.Bool("archived").Default(false),
		field.Time("deleted_at").Optional().Nillable(),
	}
}

func (Channel) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("space", Space.Type).Ref("channels").Field("space_id").Unique().Required(),
		edge.To("messages", Message.Type),
		edge.To("read_states", ReadState.Type),
	}
}

func (Channel) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("space_id", "position"),
		index.Fields("space_id", "external_id"),
		index.Fields("external_id"),
		index.Fields("parent_id"),
	}
}
