-- AlterTable
ALTER TABLE "configuration" ADD COLUMN "tuning_json" TEXT;

-- AlterTable
ALTER TABLE "media_requests" ADD COLUMN "watch_expired_at" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_discord_channels" (
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
    "last_read_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discord_channels_discord_server_fkey" FOREIGN KEY ("discord_server") REFERENCES "discord_servers" ("server_id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_discord_channels" ("channel_id", "channel_name", "channel_type", "created_at", "discord_server", "isCategory", "isTextChannel", "isVoiceChannel", "parent_id", "position", "unread_message_count", "updated_at") SELECT "channel_id", "channel_name", "channel_type", "created_at", "discord_server", "isCategory", "isTextChannel", "isVoiceChannel", "parent_id", "position", "unread_message_count", "updated_at" FROM "discord_channels";
DROP TABLE "discord_channels";
ALTER TABLE "new_discord_channels" RENAME TO "discord_channels";
CREATE INDEX "discord_channels_discord_server_idx" ON "discord_channels"("discord_server");
CREATE INDEX "discord_channels_parent_id_idx" ON "discord_channels"("parent_id");
CREATE INDEX "discord_channels_position_idx" ON "discord_channels"("position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
