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

-- HAND-ADDED: CARRY CONFIGURED ARR SERVICES OVER FROM THE CONFIGURATION SINGLETON.
-- (PRISMA cuid() IS CLIENT-SIDE; ANY UNIQUE ID IS VALID — RANDOM HEX IS FINE.)
INSERT INTO "apps" ("id", "app_type", "display_name", "enabled", "url", "api_key", "is_default", "sort_position")
SELECT lower(hex(randomblob(16))), 'radarr', 'Radarr', "is_radarr_enabled", "radarr_url", "radarr_token", 1, 0
FROM "configuration"
WHERE "radarr_url" IS NOT NULL AND "radarr_url" != '' AND "radarr_token" IS NOT NULL AND "radarr_token" != '';

INSERT INTO "apps" ("id", "app_type", "display_name", "enabled", "url", "api_key", "is_default", "sort_position")
SELECT lower(hex(randomblob(16))), 'sonarr', 'Sonarr', "is_sonarr_enabled", "sonarr_url", "sonarr_token", 1, 1
FROM "configuration"
WHERE "sonarr_url" IS NOT NULL AND "sonarr_url" != '' AND "sonarr_token" IS NOT NULL AND "sonarr_token" != '';

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_media_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "madeInId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "orig_message" TEXT,
    "orig_parsed_title" TEXT,
    "orig_parsed_type" TEXT,
    "orig_channel_id" TEXT,
    "orig_message_id" TEXT,
    "status" BOOLEAN,
    "appId" TEXT,
    CONSTRAINT "media_requests_madeInId_fkey" FOREIGN KEY ("madeInId") REFERENCES "discord_servers" ("server_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "media_requests_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "media_requests_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_media_requests" ("created_at", "id", "madeInId", "mediaId", "orig_channel_id", "orig_message", "orig_message_id", "orig_parsed_title", "orig_parsed_type", "status", "updated_at") SELECT "created_at", "id", "madeInId", "mediaId", "orig_channel_id", "orig_message", "orig_message_id", "orig_parsed_title", "orig_parsed_type", "status", "updated_at" FROM "media_requests";
DROP TABLE "media_requests";
ALTER TABLE "new_media_requests" RENAME TO "media_requests";
CREATE INDEX "media_requests_madeInId_idx" ON "media_requests"("madeInId");
CREATE INDEX "media_requests_mediaId_idx" ON "media_requests"("mediaId");
CREATE INDEX "media_requests_appId_idx" ON "media_requests"("appId");
CREATE TABLE "new_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_state" BOOLEAN NOT NULL DEFAULT false,
    "sidebar_exp_state" BOOLEAN NOT NULL DEFAULT true,
    "active_server_id" TEXT,
    "active_app_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "state_active_server_id_fkey" FOREIGN KEY ("active_server_id") REFERENCES "discord_servers" ("server_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "state_active_app_id_fkey" FOREIGN KEY ("active_app_id") REFERENCES "apps" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_state" ("active_server_id", "created_at", "discord_state", "id", "sidebar_exp_state", "updated_at") SELECT "active_server_id", "created_at", "discord_state", "id", "sidebar_exp_state", "updated_at" FROM "state";
DROP TABLE "state";
ALTER TABLE "new_state" RENAME TO "state";
CREATE UNIQUE INDEX "state_active_server_id_key" ON "state"("active_server_id");
CREATE UNIQUE INDEX "state_active_app_id_key" ON "state"("active_app_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- HAND-ADDED: BACKFILL LEGACY REQUESTS ONTO THE MIGRATED INSTANCES
UPDATE "media_requests" SET "appId" =
  (SELECT "id" FROM "apps" WHERE "app_type" = 'radarr' ORDER BY "sort_position" LIMIT 1)
  WHERE "orig_parsed_type" = 'movie';
UPDATE "media_requests" SET "appId" =
  (SELECT "id" FROM "apps" WHERE "app_type" = 'sonarr' ORDER BY "sort_position" LIMIT 1)
  WHERE "orig_parsed_type" = 'show';

-- CreateIndex
CREATE INDEX "apps_app_type_idx" ON "apps"("app_type");

-- CreateIndex
CREATE INDEX "apps_sort_position_idx" ON "apps"("sort_position");
