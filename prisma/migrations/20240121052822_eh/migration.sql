/*
  Warnings:

  - You are about to drop the column `is_verbose_logging` on the `Configuration` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_State" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "discord_state" BOOLEAN NOT NULL DEFAULT false,
    "app_state" BOOLEAN NOT NULL DEFAULT true,
    "sidebar_exp" BOOLEAN NOT NULL DEFAULT true,
    "current_activity" TEXT NOT NULL DEFAULT 'Offline',
    "host_url" TEXT NOT NULL DEFAULT '0.0.0.0:5454'
);
INSERT INTO "new_State" ("app_state", "current_activity", "discord_state", "host_url", "id") SELECT "app_state", "current_activity", "discord_state", "host_url", "id" FROM "State";
DROP TABLE "State";
ALTER TABLE "new_State" RENAME TO "State";
CREATE TABLE "new_Configuration" (
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
INSERT INTO "new_Configuration" ("discord_token", "id", "is_debug", "is_radarr_enabled", "is_sonarr_enabled", "is_trailers_enabled", "max_check_time", "max_results", "max_seasons_for_non_admin", "media_server_name", "prefix_keyword", "radarr_token", "radarr_url", "session_timeout", "sonarr_token", "sonarr_url") SELECT "discord_token", "id", "is_debug", "is_radarr_enabled", "is_sonarr_enabled", "is_trailers_enabled", "max_check_time", "max_results", "max_seasons_for_non_admin", "media_server_name", "prefix_keyword", "radarr_token", "radarr_url", "session_timeout", "sonarr_token", "sonarr_url" FROM "Configuration";
DROP TABLE "Configuration";
ALTER TABLE "new_Configuration" RENAME TO "Configuration";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
