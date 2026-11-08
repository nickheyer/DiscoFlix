package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Credential is a password hash, a passkey, or an API key owned by a User
type Credential struct{ ent.Schema }

func (Credential) Mixin() []ent.Mixin { return []ent.Mixin{IDMixin{}, TimeMixin{}} }

func (Credential) Fields() []ent.Field {
	return []ent.Field{
		field.String("user_id").NotEmpty(),
		field.Enum("kind").Values("password", "passkey", "apikey"),
		field.String("name").Default(""),
		field.Bytes("secret_hash").Optional(),
		field.String("prefix").Default(""),
		field.Bytes("credential_id").Optional(),
		field.Bytes("public_key").Optional(),
		field.Bytes("aaguid").Optional(),
		field.String("attestation_type").Default(""),
		field.Uint32("sign_count").Default(0),
		field.Strings("transports").Optional(),
		field.Bool("backup_eligible").Default(false),
		field.Bool("backup_state").Default(false),
		field.Time("expires_at").Optional().Nillable(),
		field.Time("last_used_at").Optional().Nillable(),
	}
}

func (Credential) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("user", User.Type).Ref("credentials").Field("user_id").Unique().Required(),
	}
}

func (Credential) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "kind"),
		index.Fields("credential_id"),
		index.Fields("prefix"),
	}
}
