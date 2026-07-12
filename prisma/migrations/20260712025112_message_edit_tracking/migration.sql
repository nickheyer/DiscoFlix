-- AlterTable
ALTER TABLE "discord_messages" ADD COLUMN "edited_at" DATETIME;
ALTER TABLE "discord_messages" ADD COLUMN "previous_content" TEXT;
