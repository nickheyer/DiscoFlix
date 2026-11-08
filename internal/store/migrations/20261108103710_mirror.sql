-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_channels" table
CREATE TABLE `new_channels` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `kind` text NOT NULL DEFAULT ('text'), `name` text NOT NULL, `topic` text NOT NULL DEFAULT (''), `parent_id` text NOT NULL DEFAULT (''), `position` integer NOT NULL DEFAULT (0), `external_id` text NOT NULL DEFAULT (''), `last_seq` integer NOT NULL DEFAULT (0), `archived` bool NOT NULL DEFAULT (false), `deleted_at` datetime NULL, `space_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `channels_spaces_channels` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`) ON DELETE NO ACTION);
-- Copy rows from old table "channels" to new temporary table "new_channels"
INSERT INTO `new_channels` (`id`, `created_at`, `updated_at`, `kind`, `name`, `topic`, `parent_id`, `position`, `external_id`, `last_seq`, `space_id`) SELECT `id`, `created_at`, `updated_at`, `kind`, `name`, `topic`, `parent_id`, `position`, `external_id`, `last_seq`, `space_id` FROM `channels`;
-- Drop "channels" table after copying rows
DROP TABLE `channels`;
-- Rename temporary table "new_channels" to "channels"
ALTER TABLE `new_channels` RENAME TO `channels`;
-- Create index "channel_space_id_position" to table: "channels"
CREATE INDEX `channel_space_id_position` ON `channels` (`space_id`, `position`);
-- Create index "channel_space_id_external_id" to table: "channels"
CREATE INDEX `channel_space_id_external_id` ON `channels` (`space_id`, `external_id`);
-- Create index "channel_external_id" to table: "channels"
CREATE INDEX `channel_external_id` ON `channels` (`external_id`);
-- Create index "channel_parent_id" to table: "channels"
CREATE INDEX `channel_parent_id` ON `channels` (`parent_id`);
-- Create "new_memberships" table
CREATE TABLE `new_memberships` (`id` text NOT NULL, `roles` json NOT NULL, `nickname` text NOT NULL DEFAULT (''), `admin` bool NOT NULL DEFAULT (false), `joined_at` datetime NOT NULL, `space_id` text NOT NULL, `user_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `memberships_spaces_memberships` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`) ON DELETE NO ACTION, CONSTRAINT `memberships_users_memberships` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Copy rows from old table "memberships" to new temporary table "new_memberships"
INSERT INTO `new_memberships` (`id`, `roles`, `joined_at`, `space_id`, `user_id`) SELECT `id`, `roles`, `joined_at`, `space_id`, `user_id` FROM `memberships`;
-- Drop "memberships" table after copying rows
DROP TABLE `memberships`;
-- Rename temporary table "new_memberships" to "memberships"
ALTER TABLE `new_memberships` RENAME TO `memberships`;
-- Create index "membership_user_id_space_id" to table: "memberships"
CREATE UNIQUE INDEX `membership_user_id_space_id` ON `memberships` (`user_id`, `space_id`);
-- Create index "membership_space_id" to table: "memberships"
CREATE INDEX `membership_space_id` ON `memberships` (`space_id`);
-- Create "new_messages" table
CREATE TABLE `new_messages` (`id` integer NOT NULL PRIMARY KEY AUTOINCREMENT, `kind` text NOT NULL DEFAULT ('user'), `content` text NOT NULL DEFAULT (''), `card_type` text NOT NULL DEFAULT (''), `card` blob NULL, `reply_to` integer NOT NULL DEFAULT (0), `external_id` text NOT NULL DEFAULT (''), `origin` text NOT NULL DEFAULT (''), `attachments` json NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `edited_at` datetime NULL, `deleted_at` datetime NULL, `synced_at` datetime NULL, `channel_id` text NOT NULL, `space_id` text NOT NULL, `author_id` text NOT NULL, CONSTRAINT `messages_channels_messages` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION, CONSTRAINT `messages_spaces_messages` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`) ON DELETE NO ACTION, CONSTRAINT `messages_users_messages` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Copy rows from old table "messages" to new temporary table "new_messages"
INSERT INTO `new_messages` (`id`, `kind`, `content`, `card_type`, `card`, `reply_to`, `external_id`, `origin`, `created_at`, `updated_at`, `edited_at`, `deleted_at`, `synced_at`, `channel_id`, `space_id`, `author_id`) SELECT `id`, `kind`, `content`, `card_type`, `card`, `reply_to`, `external_id`, CASE WHEN `kind` = 'user' THEN 'web' ELSE 'system' END, `created_at`, COALESCE(`edited_at`, `created_at`), `edited_at`, `deleted_at`, COALESCE(`edited_at`, `created_at`), `channel_id`, `space_id`, `author_id` FROM `messages`;
-- Drop "messages" table after copying rows
DROP TABLE `messages`;
-- Rename temporary table "new_messages" to "messages"
ALTER TABLE `new_messages` RENAME TO `messages`;
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
-- Create index "message_channel_id_synced_at" to table: "messages"
CREATE INDEX `message_channel_id_synced_at` ON `messages` (`channel_id`, `synced_at`);
-- Create "new_spaces" table
CREATE TABLE `new_spaces` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `kind` text NOT NULL, `name` text NOT NULL, `icon_url` text NOT NULL DEFAULT (''), `external_id` text NOT NULL DEFAULT (''), `position` integer NOT NULL DEFAULT (0), `approvals_channel_id` text NOT NULL DEFAULT (''), `roles` json NULL, PRIMARY KEY (`id`));
-- Copy rows from old table "spaces" to new temporary table "new_spaces"
INSERT INTO `new_spaces` (`id`, `created_at`, `updated_at`, `kind`, `name`, `icon_url`, `external_id`, `position`) SELECT `id`, `created_at`, `updated_at`, `kind`, `name`, `icon_url`, `external_id`, `position` FROM `spaces`;
-- Drop "spaces" table after copying rows
DROP TABLE `spaces`;
-- Rename temporary table "new_spaces" to "spaces"
ALTER TABLE `new_spaces` RENAME TO `spaces`;
-- Create index "space_kind_external_id" to table: "spaces"
CREATE INDEX `space_kind_external_id` ON `spaces` (`kind`, `external_id`);
-- Create index "space_position" to table: "spaces"
CREATE INDEX `space_position` ON `spaces` (`position`);
-- Create "new_users" table
CREATE TABLE `new_users` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `display_name` text NOT NULL, `avatar_url` text NOT NULL DEFAULT (''), `accent_color` text NOT NULL DEFAULT ('7289da'), `kind` text NOT NULL DEFAULT ('person'), `status` text NOT NULL DEFAULT ('active'), `system_admin` bool NOT NULL DEFAULT (false), `last_seen_at` datetime NULL, `merged_into_id` text NULL, PRIMARY KEY (`id`), CONSTRAINT `users_users_absorbed` FOREIGN KEY (`merged_into_id`) REFERENCES `users` (`id`) ON DELETE SET NULL);
-- Copy rows from old table "users" to new temporary table "new_users"
INSERT INTO `new_users` (`id`, `created_at`, `updated_at`, `display_name`, `avatar_url`, `accent_color`, `kind`, `status`, `system_admin`, `last_seen_at`) SELECT `id`, `created_at`, `updated_at`, `display_name`, `avatar_url`, `accent_color`, `kind`, `status`, `system_admin`, `last_seen_at` FROM `users`;
-- Drop "users" table after copying rows
DROP TABLE `users`;
-- Rename temporary table "new_users" to "users"
ALTER TABLE `new_users` RENAME TO `users`;
-- Create index "user_merged_into_id" to table: "users"
CREATE INDEX `user_merged_into_id` ON `users` (`merged_into_id`);
-- Create "pending_actions" table
CREATE TABLE `pending_actions` (`id` text NOT NULL, `procedure` text NOT NULL, `input` blob NOT NULL, `principal_user_id` text NOT NULL, `principal_kind` text NOT NULL, `principal_via` text NOT NULL DEFAULT (''), `message_seq` integer NOT NULL DEFAULT (0), `state` text NOT NULL DEFAULT ('pending'), `decided_by` text NOT NULL DEFAULT (''), `decided_at` datetime NULL, `result` text NOT NULL DEFAULT (''), `created_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "pendingaction_state_created_at" to table: "pending_actions"
CREATE INDEX `pendingaction_state_created_at` ON `pending_actions` (`state`, `created_at`);
-- Create index "pendingaction_message_seq" to table: "pending_actions"
CREATE INDEX `pendingaction_message_seq` ON `pending_actions` (`message_seq`);
-- Create "reactions" table
CREATE TABLE `reactions` (`id` text NOT NULL, `emoji` text NOT NULL, `origin` text NOT NULL DEFAULT (''), `created_at` datetime NOT NULL, `message_id` integer NOT NULL, `user_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `reactions_messages_reactions` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE NO ACTION, CONSTRAINT `reactions_users_reactions` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION);
-- Create index "reaction_message_id_user_id_emoji" to table: "reactions"
CREATE UNIQUE INDEX `reaction_message_id_user_id_emoji` ON `reactions` (`message_id`, `user_id`, `emoji`);
-- Create index "reaction_message_id_emoji" to table: "reactions"
CREATE INDEX `reaction_message_id_emoji` ON `reactions` (`message_id`, `emoji`);
-- Create "user_merges" table
CREATE TABLE `user_merges` (`id` text NOT NULL, `from_user_id` text NOT NULL, `into_user_id` text NOT NULL, `identity_ids` json NOT NULL, `credential_ids` json NOT NULL, `added_space_ids` json NOT NULL, `granted_system_member` bool NOT NULL DEFAULT (false), `created_at` datetime NOT NULL, `reverted_at` datetime NULL, PRIMARY KEY (`id`));
-- Create index "usermerge_from_user_id" to table: "user_merges"
CREATE INDEX `usermerge_from_user_id` ON `user_merges` (`from_user_id`);
-- Create index "usermerge_into_user_id" to table: "user_merges"
CREATE INDEX `usermerge_into_user_id` ON `user_merges` (`into_user_id`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
