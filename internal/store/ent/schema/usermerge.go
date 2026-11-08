package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// UserMerge records one identity-link merge so an administrator can split the users again
type UserMerge struct{ ent.Schema }

func (UserMerge) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}} }

func (UserMerge) Fields() []ent.Field {
	return []ent.Field{
		field.String("from_user_id").NotEmpty(),
		field.String("into_user_id").NotEmpty(),
		field.Strings("identity_ids").Default([]string{}),
		field.Strings("credential_ids").Default([]string{}),
		field.Strings("added_space_ids").Default([]string{}),
		field.Bool("granted_system_member").Default(false),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("reverted_at").Optional().Nillable(),
	}
}

func (UserMerge) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("from_user_id"),
		index.Fields("into_user_id"),
	}
}
