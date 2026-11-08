-- Create "authz_outboxes" table
CREATE TABLE `authz_outboxes` (`id` integer NOT NULL PRIMARY KEY AUTOINCREMENT, `op` text NOT NULL, `object` text NOT NULL, `relation` text NOT NULL, `subject` text NOT NULL, `condition` text NOT NULL DEFAULT (''), `condition_context` blob NULL, `created_at` datetime NOT NULL, `applied_at` datetime NULL, `attempts` integer NOT NULL DEFAULT (0), `last_error` text NOT NULL DEFAULT (''));
-- Create index "authzoutbox_applied_at_id" to table: "authz_outboxes"
CREATE INDEX `authzoutbox_applied_at_id` ON `authz_outboxes` (`applied_at`, `id`);
-- Create "channels" table
CREATE TABLE `channels` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `kind` text NOT NULL DEFAULT ('text'), `name` text NOT NULL, `topic` text NOT NULL DEFAULT (''), `parent_id` text NOT NULL DEFAULT (''), `position` integer NOT NULL DEFAULT (0), `external_id` text NOT NULL DEFAULT (''), `last_seq` integer NOT NULL DEFAULT (0), `space_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `channels_spaces_channels` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`) ON DELETE NO ACTION);
-- Create index "channel_space_id_position" to table: "channels"
CREATE INDEX `channel_space_id_position` ON `channels` (`space_id`, `position`);
-- Create index "channel_space_id_external_id" to table: "channels"
CREATE INDEX `channel_space_id_external_id` ON `channels` (`space_id`, `external_id`);
-- Create index "channel_parent_id" to table: "channels"
CREATE INDEX `channel_parent_id` ON `channels` (`parent_id`);
-- Create "credentials" table
CREATE TABLE `credentials` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `kind` text NOT NULL, `name` text NOT NULL DEFAULT (''), `secret_hash` blob NULL, `prefix` text NOT NULL DEFAULT (''), `credential_id` blob NULL, `public_key` blob NULL, `aaguid` blob NULL, `attestation_type` text NOT NULL DEFAULT (''), `sign_count` integer NOT NULL DEFAULT (0), `transports` json NULL, `backup_eligible` bool NOT NULL DEFAULT (false), `backup_state` bool NOT NULL DEFAULT (false), `expires_at` datetime NULL, `last_used_at` datetime NULL, `user_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `credentials_users_credentials` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Create index "credential_user_id_kind" to table: "credentials"
CREATE INDEX `credential_user_id_kind` ON `credentials` (`user_id`, `kind`);
-- Create index "credential_credential_id" to table: "credentials"
CREATE INDEX `credential_credential_id` ON `credentials` (`credential_id`);
-- Create index "credential_prefix" to table: "credentials"
CREATE INDEX `credential_prefix` ON `credentials` (`prefix`);
-- Create "identities" table
CREATE TABLE `identities` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `provider` text NOT NULL, `subject` text NOT NULL, `display` text NOT NULL DEFAULT (''), `verified_at` datetime NULL, `linked_at` datetime NULL, `user_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `identities_users_identities` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Create index "identity_provider_subject" to table: "identities"
CREATE UNIQUE INDEX `identity_provider_subject` ON `identities` (`provider`, `subject`);
-- Create index "identity_user_id" to table: "identities"
CREATE INDEX `identity_user_id` ON `identities` (`user_id`);
-- Create "memberships" table
CREATE TABLE `memberships` (`id` text NOT NULL, `roles` json NOT NULL, `joined_at` datetime NOT NULL, `space_id` text NOT NULL, `user_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `memberships_spaces_memberships` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`) ON DELETE NO ACTION, CONSTRAINT `memberships_users_memberships` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Create index "membership_user_id_space_id" to table: "memberships"
CREATE UNIQUE INDEX `membership_user_id_space_id` ON `memberships` (`user_id`, `space_id`);
-- Create index "membership_space_id" to table: "memberships"
CREATE INDEX `membership_space_id` ON `memberships` (`space_id`);
-- Create "messages" table
CREATE TABLE `messages` (`id` integer NOT NULL PRIMARY KEY AUTOINCREMENT, `kind` text NOT NULL DEFAULT ('user'), `content` text NOT NULL DEFAULT (''), `card_type` text NOT NULL DEFAULT (''), `card` blob NULL, `reply_to` integer NOT NULL DEFAULT (0), `external_id` text NOT NULL DEFAULT (''), `created_at` datetime NOT NULL, `edited_at` datetime NULL, `deleted_at` datetime NULL, `channel_id` text NOT NULL, `space_id` text NOT NULL, `author_id` text NOT NULL, CONSTRAINT `messages_channels_messages` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION, CONSTRAINT `messages_spaces_messages` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`) ON DELETE NO ACTION, CONSTRAINT `messages_users_messages` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Create index "message_channel_id_id" to table: "messages"
CREATE INDEX `message_channel_id_id` ON `messages` (`channel_id`, `id`);
-- Create index "message_space_id_id" to table: "messages"
CREATE INDEX `message_space_id_id` ON `messages` (`space_id`, `id`);
-- Create index "message_author_id" to table: "messages"
CREATE INDEX `message_author_id` ON `messages` (`author_id`);
-- Create index "message_external_id" to table: "messages"
CREATE INDEX `message_external_id` ON `messages` (`external_id`);
-- Create index "message_card_type" to table: "messages"
CREATE INDEX `message_card_type` ON `messages` (`card_type`);
-- Create "read_states" table
CREATE TABLE `read_states` (`id` text NOT NULL, `last_read_seq` integer NOT NULL DEFAULT (0), `updated_at` datetime NOT NULL, `channel_id` text NOT NULL, `user_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `read_states_channels_read_states` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION, CONSTRAINT `read_states_users_read_states` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Create index "readstate_user_id_channel_id" to table: "read_states"
CREATE UNIQUE INDEX `readstate_user_id_channel_id` ON `read_states` (`user_id`, `channel_id`);
-- Create "settings" table
CREATE TABLE `settings` (`id` text NOT NULL, `value` blob NOT NULL, `secret` bool NOT NULL DEFAULT (false), `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create "spaces" table
CREATE TABLE `spaces` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `kind` text NOT NULL, `name` text NOT NULL, `icon_url` text NOT NULL DEFAULT (''), `external_id` text NOT NULL DEFAULT (''), `position` integer NOT NULL DEFAULT (0), PRIMARY KEY (`id`));
-- Create index "space_kind_external_id" to table: "spaces"
CREATE INDEX `space_kind_external_id` ON `spaces` (`kind`, `external_id`);
-- Create index "space_position" to table: "spaces"
CREATE INDEX `space_position` ON `spaces` (`position`);
-- Create "users" table
CREATE TABLE `users` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `display_name` text NOT NULL, `avatar_url` text NOT NULL DEFAULT (''), `accent_color` text NOT NULL DEFAULT ('7289da'), `kind` text NOT NULL DEFAULT ('person'), `status` text NOT NULL DEFAULT ('active'), `system_admin` bool NOT NULL DEFAULT (false), `last_seen_at` datetime NULL, PRIMARY KEY (`id`));
