package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// SourceRecord is one raw response fetched from a metadata source, kept for provenance
type SourceRecord struct{ ent.Schema }

func (SourceRecord) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (SourceRecord) Fields() []ent.Field {
	return []ent.Field{
		field.String("source").NotEmpty().MaxLen(32),
		field.String("namespace").Default(""),
		field.String("ext_value").Default(""),
		field.String("kind").Default(""),
		field.String("url").Default(""),
		field.Int32("status").Default(0),
		field.String("etag").Default(""),
		field.Bytes("payload").Optional(),
		field.String("license").Default(""),
		field.Time("fetched_at").Default(time.Now),
		field.Time("expires_at").Optional().Nillable(),
	}
}

func (SourceRecord) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("source", "namespace", "ext_value", "fetched_at"),
		index.Fields("source", "url", "fetched_at"),
		index.Fields("fetched_at"),
	}
}
