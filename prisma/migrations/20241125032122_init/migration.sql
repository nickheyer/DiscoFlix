-- CreateTable
CREATE TABLE "Configuration" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "media_server_name" TEXT DEFAULT 'The Server',
    "prefix_keyword" TEXT DEFAULT '!df',
    "discord_token" TEXT,
    "radarr_url" TEXT,
    "radarr_token" TEXT,
    "sonarr_url" TEXT,
    "sonarr_token" TEXT,
    "session_timeout" INTEGER DEFAULT 60,
    "max_check_time" INTEGER DEFAULT 600,
    "max_results" INTEGER DEFAULT 0,
    "max_seasons_for_non_admin" INTEGER DEFAULT 0,
    "is_debug" BOOLEAN NOT NULL DEFAULT false,
    "is_radarr_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_sonarr_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_trailers_enabled" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "State" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "discord_state" BOOLEAN NOT NULL DEFAULT false,
    "sidebar_exp_state" BOOLEAN NOT NULL DEFAULT true,
    "active_server_id" TEXT,
    CONSTRAINT "State_active_server_id_fkey" FOREIGN KEY ("active_server_id") REFERENCES "DiscordServer" ("server_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "DiscordBot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bot_id" TEXT DEFAULT '0',
    "bot_username" TEXT DEFAULT 'Unavailable',
    "bot_discriminator" TEXT DEFAULT '0000',
    "bot_avatar_url" TEXT,
    "bot_invite_link" TEXT
);

-- CreateTable
CREATE TABLE "DiscordServer" (
    "server_id" TEXT NOT NULL PRIMARY KEY,
    "unread_message_count" INTEGER DEFAULT 0,
    "server_name" TEXT DEFAULT 'TBD',
    "server_avatar_url" TEXT,
    "sort_position" INTEGER DEFAULT -1,
    "active_channel_id" TEXT,
    "available" BOOLEAN DEFAULT true
);

-- CreateTable
CREATE TABLE "DiscordServerChannel" (
    "channel_id" TEXT NOT NULL PRIMARY KEY,
    "channel_name" TEXT DEFAULT 'TBD',
    "position" INTEGER DEFAULT -1,
    "discord_server" TEXT NOT NULL,
    "channel_type" INTEGER NOT NULL DEFAULT 0,
    "isTextChannel" BOOLEAN NOT NULL DEFAULT false,
    "isVoiceChannel" BOOLEAN NOT NULL DEFAULT false,
    "isCategory" BOOLEAN NOT NULL DEFAULT false,
    "parent_id" TEXT NOT NULL DEFAULT '',
    "unread_message_count" INTEGER DEFAULT 0,
    CONSTRAINT "DiscordServerChannel_discord_server_fkey" FOREIGN KEY ("discord_server") REFERENCES "DiscordServer" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscordMessage" (
    "message_id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordMessage_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "DiscordServer" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscordMessage_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "DiscordServerChannel" ("channel_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscordMessage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Media" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
    "trailer_url" TEXT
);

-- CreateTable
CREATE TABLE "MediaRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "created" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "madeInId" TEXT NOT NULL,
    "mediaId" INTEGER NOT NULL,
    "orig_message" TEXT,
    "orig_parsed_title" TEXT,
    "orig_parsed_type" TEXT,
    "status" BOOLEAN,
    CONSTRAINT "MediaRequest_madeInId_fkey" FOREIGN KEY ("madeInId") REFERENCES "DiscordServer" ("server_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MediaRequest_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "added" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "max_requests_in_day" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "_UserDiscordServers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_UserDiscordServers_A_fkey" FOREIGN KEY ("A") REFERENCES "DiscordServer" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_UserDiscordServers_B_fkey" FOREIGN KEY ("B") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_UserMediaRequests" (
    "A" INTEGER NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_UserMediaRequests_A_fkey" FOREIGN KEY ("A") REFERENCES "MediaRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_UserMediaRequests_B_fkey" FOREIGN KEY ("B") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "State_active_server_id_key" ON "State"("active_server_id");

-- CreateIndex
CREATE INDEX "DiscordServerChannel_discord_server_idx" ON "DiscordServerChannel"("discord_server");

-- CreateIndex
CREATE INDEX "DiscordMessage_server_id_idx" ON "DiscordMessage"("server_id");

-- CreateIndex
CREATE INDEX "DiscordMessage_channel_id_idx" ON "DiscordMessage"("channel_id");

-- CreateIndex
CREATE INDEX "DiscordMessage_user_id_idx" ON "DiscordMessage"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "_UserDiscordServers_AB_unique" ON "_UserDiscordServers"("A", "B");

-- CreateIndex
CREATE INDEX "_UserDiscordServers_B_index" ON "_UserDiscordServers"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_UserMediaRequests_AB_unique" ON "_UserMediaRequests"("A", "B");

-- CreateIndex
CREATE INDEX "_UserMediaRequests_B_index" ON "_UserMediaRequests"("B");
