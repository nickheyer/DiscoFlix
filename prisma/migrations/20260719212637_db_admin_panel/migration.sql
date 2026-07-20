-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_configuration" (
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
    "tuning_json" TEXT,
    "db_admin_enabled" BOOLEAN NOT NULL DEFAULT false,
    "db_admin_warning_dismissed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_configuration" ("admin_password", "admin_role_ids", "bot_presence_activity", "bot_presence_text", "created_at", "discord_token", "id", "is_debug", "media_server_name", "prefix_keyword", "staff_role_ids", "tuning_json", "updated_at", "whitelist_role_ids") SELECT "admin_password", "admin_role_ids", "bot_presence_activity", "bot_presence_text", "created_at", "discord_token", "id", "is_debug", "media_server_name", "prefix_keyword", "staff_role_ids", "tuning_json", "updated_at", "whitelist_role_ids" FROM "configuration";
DROP TABLE "configuration";
ALTER TABLE "new_configuration" RENAME TO "configuration";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
