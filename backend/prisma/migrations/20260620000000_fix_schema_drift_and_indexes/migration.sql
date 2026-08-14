-- Migration: fix schema drift + restore performance indexes
--
-- 1. Drop the orphaned `email` column that exists in the database but
--    not in schema.prisma (removed in auth_refactor migration but the
--    column was never actually dropped).
-- 2. Recreate indexes on `messages` that were dropped by the
--    `20260306145808_add_pending_commands` migration and never
--    restored. These are critical for chat view performance.
-- 3. Add a GIN index on metadata for pendingDeviceId lookups.

-- 1. Drop orphaned email column + its unique index
DROP INDEX IF EXISTS "users_email_key";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email";

-- 2. Recreate messages indexes (dropped by 20260306145808)
CREATE INDEX IF NOT EXISTS "idx_messages_chat_id_created_at"
  ON "messages" ("chatId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "idx_messages_author_id"
  ON "messages" ("authorId");

-- 3. Add GIN index on metadata for pendingDeviceId lookups
--    (used by multi-device offline message delivery)
CREATE INDEX IF NOT EXISTS "idx_messages_metadata_pending"
  ON "messages" USING GIN ("metadata" jsonb_path_ops);
