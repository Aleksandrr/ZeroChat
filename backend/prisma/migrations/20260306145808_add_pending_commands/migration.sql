-- DropIndex
DROP INDEX "idx_chat_folder_items_folder_id";

-- DropIndex
DROP INDEX "idx_chats_created_at";

-- DropIndex
DROP INDEX "idx_chats_created_by_id";

-- DropIndex
DROP INDEX "idx_chats_is_archived";

-- DropIndex
DROP INDEX "idx_chats_is_muted";

-- DropIndex
DROP INDEX "idx_chats_is_pinned";

-- DropIndex
DROP INDEX "idx_chats_type";

-- DropIndex
DROP INDEX "idx_devices_fingerprint";

-- DropIndex
DROP INDEX "idx_messages_author_id";

-- DropIndex
DROP INDEX "idx_messages_chat_id";

-- DropIndex
DROP INDEX "idx_messages_created_at";

-- DropIndex
DROP INDEX "idx_sync_events_server_received_at";

-- DropIndex
DROP INDEX "idx_sync_events_user_id";

-- DropIndex
DROP INDEX "idx_user_folders_order";

-- DropIndex
DROP INDEX "idx_user_folders_user_id";

-- DropIndex
DROP INDEX "idx_users_last_seen";

-- CreateTable
CREATE TABLE "pending_commands" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "pending_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_commands_userId_deviceId_idx" ON "pending_commands"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "pending_commands_expiresAt_idx" ON "pending_commands"("expiresAt");

-- AddForeignKey
ALTER TABLE "pending_commands" ADD CONSTRAINT "pending_commands_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
