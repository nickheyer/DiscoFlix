-- CreateTable
CREATE TABLE "configuration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "media_server_name" TEXT NOT NULL DEFAULT 'The Server',
    "prefix_keyword" TEXT NOT NULL DEFAULT '!df',
    "discord_token" TEXT,
    "radarr_url" TEXT,
    "radarr_token" TEXT,
    "sonarr_url" TEXT,
    "sonarr_token" TEXT,
    "session_timeout" INTEGER NOT NULL DEFAULT 60,
    "max_check_time" INTEGER NOT NULL DEFAULT 600,
    "max_results" INTEGER NOT NULL DEFAULT 0,
    "max_seasons_for_non_admin" INTEGER NOT NULL DEFAULT 0,
    "is_debug" BOOLEAN NOT NULL DEFAULT false,
    "is_radarr_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_sonarr_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_trailers_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_state" BOOLEAN NOT NULL DEFAULT false,
    "sidebar_exp_state" BOOLEAN NOT NULL DEFAULT true,
    "active_server_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "state_active_server_id_fkey" FOREIGN KEY ("active_server_id") REFERENCES "discord_servers" ("server_id") ON DELETE SET NULL ON UPDATE CASCADE
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
    "updated_at" DATETIME NOT NULL
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
    "updated_at" DATETIME NOT NULL
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
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "discord_channels_discord_server_fkey" FOREIGN KEY ("discord_server") REFERENCES "discord_servers" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "discord_messages" (
    "message_id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
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
    "imdb_id" TEXT,
    "first_aired" TEXT,
    "series_type" TEXT,
    "in_theaters" TEXT,
    "website_url" TEXT,
    "trailer_url" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "media_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "madeInId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "orig_message" TEXT,
    "orig_parsed_title" TEXT,
    "orig_parsed_type" TEXT,
    "status" BOOLEAN,
    CONSTRAINT "media_requests_madeInId_fkey" FOREIGN KEY ("madeInId") REFERENCES "discord_servers" ("server_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "media_requests_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "is_bot" BOOLEAN NOT NULL DEFAULT false,
    "is_client" BOOLEAN NOT NULL DEFAULT false,
    "session_timeout" INTEGER NOT NULL DEFAULT 60,
    "max_check_time" INTEGER NOT NULL DEFAULT 600,
    "max_results" INTEGER NOT NULL DEFAULT 0,
    "max_seasons_for_non_admin" INTEGER NOT NULL DEFAULT 0,
    "max_requests_in_day" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
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
CREATE UNIQUE INDEX "state_active_server_id_key" ON "state"("active_server_id");

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
CREATE INDEX "media_requests_madeInId_idx" ON "media_requests"("madeInId");

-- CreateIndex
CREATE INDEX "media_requests_mediaId_idx" ON "media_requests"("mediaId");

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
