package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Message is one event in a Channel, its id is the timeline sequence
type Message struct{ ent.Schema }

func (Message) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("space_id").NotEmpty(),
		field.String("channel_id").NotEmpty(),
		field.String("author_id").NotEmpty(),
		field.Enum("kind").Values("user", "system", "card").Default("user"),
		field.Text("content").Default(""),
		field.String("card_type").Default(""),
		field.Bytes("card").Optional(),
		field.Int64("reply_to").Default(0),
		field.String("external_id").Default(""),
		field.String("origin").Default(""),
		field.JSON("attachments", []Attachment{}).Optional(),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
		field.Time("edited_at").Optional().Nillable(),
		field.Time("deleted_at").Optional().Nillable(),
		field.Time("synced_at").Optional().Nillable(),
	}
}

func (Message) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("space", Space.Type).Ref("messages").Field("space_id").Unique().Required(),
		edge.From("channel", Channel.Type).Ref("messages").Field("channel_id").Unique().Required(),
		edge.From("author", User.Type).Ref("messages").Field("author_id").Unique().Required(),
		edge.To("reactions", Reaction.Type),
	}
}

func (Message) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("channel_id", "id"),
		index.Fields("space_id", "id"),
		index.Fields("author_id"),
		index.Fields("external_id"),
		index.Fields("card_type"),
		index.Fields("channel_id", "synced_at"),
	}
}
