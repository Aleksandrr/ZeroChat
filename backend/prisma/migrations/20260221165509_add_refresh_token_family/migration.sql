-- Add familyId column to refresh_tokens table
-- This field is used for token leak detection (token family tracking)
-- When a token from a revoked family is used, all user tokens are revoked

-- Step 1: Add column as nullable
ALTER TABLE "refresh_tokens" ADD COLUMN "familyId" TEXT;

-- Step 2: Populate existing rows with unique family IDs
UPDATE "refresh_tokens" SET "familyId" = gen_random_uuid() WHERE "familyId" IS NULL;

-- Step 3: Make column NOT NULL
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET NOT NULL;

-- Step 4: Create index for familyId lookups (used in leak detection)
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");
