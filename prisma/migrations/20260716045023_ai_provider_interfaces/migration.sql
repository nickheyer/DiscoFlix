-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'console',
    "context_key" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_conversations_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "blocks_json" TEXT,
    "author_label" TEXT,
    "author_key" TEXT,
    "usage_json" TEXT,
    "error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ai_conversations_appId_surface_idx" ON "ai_conversations"("appId", "surface");

-- CreateIndex
CREATE INDEX "ai_conversations_surface_context_key_idx" ON "ai_conversations"("surface", "context_key");

-- CreateIndex
CREATE INDEX "ai_conversations_updated_at_idx" ON "ai_conversations"("updated_at");

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_created_at_idx" ON "ai_messages"("conversationId", "created_at");

-- CreateIndex
CREATE INDEX "ai_messages_author_key_created_at_idx" ON "ai_messages"("author_key", "created_at");
