-- CreateTable
CREATE TABLE "configuration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "media_server_name" TEXT NOT NULL DEFAULT 'The Server',
    "prefix_keyword" TEXT NOT NULL DEFAULT '!df',
    "admin_password" TEXT,
    "discord_token" TEXT,
    "is_debug" BOOLEAN NOT NULL DEFAULT false,
    "bot_presence_activity" TEXT NOT NULL DEFAULT 'none',
    "bot_presence_text" TEXT NOT NULL DEFAULT '',
    "whitelist_role_ids" TEXT NOT NULL DEFAULT '',
    "staff_role_ids" TEXT NOT NULL DEFAULT '',
    "admin_role_ids" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "bot_feature_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feature_id" TEXT NOT NULL,
    "server_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "audience" TEXT NOT NULL DEFAULT 'everyone',
    "role_ids" TEXT NOT NULL DEFAULT '',
    "extents_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bot_feature_rules_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "discord_servers" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_state" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "view_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sidebar_exp_state" BOOLEAN NOT NULL DEFAULT true,
    "active_server_id" TEXT,
    "active_app_id" TEXT,
    "active_channels" TEXT,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "view_sessions_active_server_id_fkey" FOREIGN KEY ("active_server_id") REFERENCES "discord_servers" ("server_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "view_sessions_active_app_id_fkey" FOREIGN KEY ("active_app_id") REFERENCES "apps" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "apps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "app_type" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "url" TEXT,
    "api_key" TEXT,
    "username" TEXT,
    "password" TEXT,
    "settings_json" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_position" INTEGER NOT NULL DEFAULT 0,
    "active_section" TEXT NOT NULL DEFAULT 'overview',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" TEXT
);

-- CreateTable
CREATE TABLE "discord_bots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bot_id" TEXT NOT NULL DEFAULT '0',
    "bot_username" TEXT NOT NULL DEFAULT 'Unavailable',
    "bot_discriminator" TEXT NOT NULL DEFAULT '0000',
    "bot_avatar_url" TEXT,
    "bot_invite_link" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "discord_servers" (
    "server_id" TEXT NOT NULL PRIMARY KEY,
    "unread_message_count" INTEGER DEFAULT 0,
    "server_name" TEXT DEFAULT 'TBD',
    "server_avatar_url" TEXT,
    "sort_position" INTEGER DEFAULT -1,
    "active_channel_id" TEXT,
    "available" BOOLEAN DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "discord_channels" (
    "channel_id" TEXT NOT NULL PRIMARY KEY,
    "channel_name" TEXT DEFAULT 'TBD',
    "position" INTEGER DEFAULT -1,
    "discord_server" TEXT NOT NULL,
    "channel_type" INTEGER NOT NULL DEFAULT 0,
    "isTextChannel" BOOLEAN NOT NULL DEFAULT false,
    "isVoiceChannel" BOOLEAN NOT NULL DEFAULT false,
    "isCategory" BOOLEAN NOT NULL DEFAULT false,
    "parent_id" TEXT NOT NULL DEFAULT '',
    "unread_message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discord_channels_discord_server_fkey" FOREIGN KEY ("discord_server") REFERENCES "discord_servers" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "discord_messages" (
    "message_id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embeds" TEXT,
    "attachments" TEXT,
    "components" TEXT,
    "previous_content" TEXT,
    "edited_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discord_messages_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "discord_servers" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "discord_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "discord_channels" ("channel_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "discord_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "overview" TEXT,
    "poster_url" TEXT,
    "year" INTEGER,
    "path" TEXT,
    "monitored" BOOLEAN,
    "runtime" INTEGER,
    "added" TEXT,
    "season_count" INTEGER,
    "network" TEXT,
    "air_time" TEXT,
    "tvdb_id" TEXT,
    "tmdb_id" TEXT,
    "imdb_id" TEXT,
    "musicbrainz_id" TEXT,
    "first_aired" TEXT,
    "series_type" TEXT,
    "in_theaters" TEXT,
    "website_url" TEXT,
    "trailer_url" TEXT,
    "is_available" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "media_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "madeInId" TEXT,
    "mediaId" TEXT NOT NULL,
    "orig_message" TEXT,
    "orig_parsed_title" TEXT,
    "orig_parsed_type" TEXT,
    "orig_channel_id" TEXT,
    "orig_message_id" TEXT,
    "arr_id" TEXT,
    "seasons" TEXT,
    "status" BOOLEAN,
    "appId" TEXT,
    CONSTRAINT "media_requests_madeInId_fkey" FOREIGN KEY ("madeInId") REFERENCES "discord_servers" ("server_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "media_requests_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "media_requests_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL DEFAULT 'DiscordUser',
    "display_name" TEXT NOT NULL DEFAULT 'ADiscordUser',
    "accent_color" TEXT NOT NULL DEFAULT 'ffffff',
    "avatar_url" TEXT NOT NULL DEFAULT 'https://cdn.discordapp.com/embed/avatars/3.png',
    "is_superuser" BOOLEAN NOT NULL DEFAULT false,
    "is_staff" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_whitelisted" BOOLEAN NOT NULL DEFAULT false,
    "is_bot" BOOLEAN NOT NULL DEFAULT false,
    "is_client" BOOLEAN NOT NULL DEFAULT false,
    "access_requested_at" DATETIME,
    "last_seen_at" DATETIME,
    "max_results" INTEGER NOT NULL DEFAULT 0,
    "max_seasons_for_non_admin" INTEGER NOT NULL DEFAULT 0,
    "max_requests_in_day" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "_UserDiscordServers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_UserDiscordServers_A_fkey" FOREIGN KEY ("A") REFERENCES "discord_servers" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_UserDiscordServers_B_fkey" FOREIGN KEY ("B") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_UserMediaRequests" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_UserMediaRequests_A_fkey" FOREIGN KEY ("A") REFERENCES "media_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_UserMediaRequests_B_fkey" FOREIGN KEY ("B") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "bot_feature_rules_feature_id_idx" ON "bot_feature_rules"("feature_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_feature_rules_feature_id_server_id_key" ON "bot_feature_rules"("feature_id", "server_id");

-- CreateIndex
CREATE INDEX "view_sessions_last_seen_at_idx" ON "view_sessions"("last_seen_at");

-- CreateIndex
CREATE INDEX "apps_app_type_idx" ON "apps"("app_type");

-- CreateIndex
CREATE INDEX "apps_sort_position_idx" ON "apps"("sort_position");

-- CreateIndex
CREATE INDEX "event_logs_timestamp_idx" ON "event_logs"("timestamp");

-- CreateIndex
CREATE INDEX "discord_servers_sort_position_idx" ON "discord_servers"("sort_position");

-- CreateIndex
CREATE INDEX "discord_channels_discord_server_idx" ON "discord_channels"("discord_server");

-- CreateIndex
CREATE INDEX "discord_channels_parent_id_idx" ON "discord_channels"("parent_id");

-- CreateIndex
CREATE INDEX "discord_channels_position_idx" ON "discord_channels"("position");

-- CreateIndex
CREATE INDEX "discord_messages_server_id_idx" ON "discord_messages"("server_id");

-- CreateIndex
CREATE INDEX "discord_messages_channel_id_idx" ON "discord_messages"("channel_id");

-- CreateIndex
CREATE INDEX "discord_messages_user_id_idx" ON "discord_messages"("user_id");

-- CreateIndex
CREATE INDEX "discord_messages_created_at_idx" ON "discord_messages"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_imdb_id_key" ON "media"("imdb_id");

-- CreateIndex
CREATE INDEX "media_imdb_id_idx" ON "media"("imdb_id");

-- CreateIndex
CREATE INDEX "media_tmdb_id_idx" ON "media"("tmdb_id");

-- CreateIndex
CREATE INDEX "media_tvdb_id_idx" ON "media"("tvdb_id");

-- CreateIndex
CREATE INDEX "media_musicbrainz_id_idx" ON "media"("musicbrainz_id");

-- CreateIndex
CREATE INDEX "media_path_idx" ON "media"("path");

-- CreateIndex
CREATE INDEX "media_requests_madeInId_idx" ON "media_requests"("madeInId");

-- CreateIndex
CREATE INDEX "media_requests_mediaId_idx" ON "media_requests"("mediaId");

-- CreateIndex
CREATE INDEX "media_requests_appId_idx" ON "media_requests"("appId");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "_UserDiscordServers_AB_unique" ON "_UserDiscordServers"("A", "B");

-- CreateIndex
CREATE INDEX "_UserDiscordServers_B_index" ON "_UserDiscordServers"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_UserMediaRequests_AB_unique" ON "_UserMediaRequests"("A", "B");

-- CreateIndex
CREATE INDEX "_UserMediaRequests_B_index" ON "_UserMediaRequests"("B");
