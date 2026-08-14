-- CreateIndexes

-- Chats indexes
CREATE INDEX IF NOT EXISTS idx_chats_created_by_id ON "chats"("createdById");
CREATE INDEX IF NOT EXISTS idx_chats_is_muted ON "chats"("isMuted") WHERE "isMuted" = true;
CREATE INDEX IF NOT EXISTS idx_chats_is_archived ON "chats"("isArchived") WHERE "isArchived" = true;
CREATE INDEX IF NOT EXISTS idx_chats_is_pinned ON "chats"("isPinned") WHERE "isPinned" = true;
CREATE INDEX IF NOT EXISTS idx_chats_created_at ON "chats"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_chats_type ON "chats"("type");

-- Messages indexes
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON "messages"("chatId");
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON "messages"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author_id ON "messages"("authorId");

-- User Folders indexes
CREATE INDEX IF NOT EXISTS idx_user_folders_user_id ON "user_folders"("userId");
CREATE INDEX IF NOT EXISTS idx_user_folders_order ON "user_folders"("order");

-- Chat Folder Items indexes
CREATE INDEX IF NOT EXISTS idx_chat_folder_items_chat_id ON "chat_folder_items"("chatId");
CREATE INDEX IF NOT EXISTS idx_chat_folder_items_folder_id ON "chat_folder_items"("folderId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_folder_items_unique ON "chat_folder_items"("folderId", "chatId");

-- Command replay protection (if using DB cache)
-- CREATE INDEX IF NOT EXISTS idx_command_replay_command_id ON "command_replay_cache"("commandId", "expiresAt");

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON "users"("username");
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON "users"("lastSeen");

-- Devices indexes
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON "devices"("userId");
CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON "devices"("fingerprint") WHERE "fingerprint" IS NOT NULL;

-- Sync events indexes
CREATE INDEX IF NOT EXISTS idx_sync_events_user_id ON "sync_events"("userId");
CREATE INDEX IF NOT EXISTS idx_sync_events_server_received_at ON "sync_events"("serverReceivedAt" DESC);
