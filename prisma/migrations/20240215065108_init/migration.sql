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
CREATE TABLE "ErrLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "created" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entry" TEXT NOT NULL DEFAULT 'Error Occured'
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "created" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entry" TEXT NOT NULL DEFAULT 'Event Occured'
);

-- CreateTable
CREATE TABLE "DiscordBot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bot_username" TEXT DEFAULT 'Unavailable',
    "bot_discriminator" TEXT DEFAULT '0000',
    "bot_avatar_url" TEXT,
    "bot_invite_link" TEXT
);

-- CreateTable
CREATE TABLE "DiscordServer" (
    "server_id" TEXT NOT NULL PRIMARY KEY,
    "unread_ui_state" BOOLEAN NOT NULL DEFAULT false,
    "server_name" TEXT,
    "server_avatar_url" TEXT,
    "sort_position" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "DiscordServerChannel" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "discord_server" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    CONSTRAINT "DiscordServerChannel_discord_server_fkey" FOREIGN KEY ("discord_server") REFERENCES "DiscordServer" ("server_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscordMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "server_id" TEXT NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordMessage_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "DiscordServer" ("server_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DiscordMessage_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "DiscordServerChannel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DiscordMessage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "added" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_server_restricted" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT NOT NULL,
    "is_additional_settings" BOOLEAN NOT NULL DEFAULT false,
    "is_superuser" BOOLEAN NOT NULL DEFAULT false,
    "is_staff" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "session_timeout" INTEGER NOT NULL DEFAULT 60,
    "max_check_time" INTEGER NOT NULL DEFAULT 600,
    "max_results" INTEGER NOT NULL DEFAULT 0,
    "max_seasons_for_non_admin" INTEGER NOT NULL DEFAULT 0,
    "max_requests_in_day" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "_UserDiscordServers" (
    "A" TEXT NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_UserDiscordServers_A_fkey" FOREIGN KEY ("A") REFERENCES "DiscordServer" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_UserDiscordServers_B_fkey" FOREIGN KEY ("B") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_UserMediaRequests" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
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
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "_UserDiscordServers_AB_unique" ON "_UserDiscordServers"("A", "B");

-- CreateIndex
CREATE INDEX "_UserDiscordServers_B_index" ON "_UserDiscordServers"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_UserMediaRequests_AB_unique" ON "_UserMediaRequests"("A", "B");

-- CreateIndex
CREATE INDEX "_UserMediaRequests_B_index" ON "_UserMediaRequests"("B");
