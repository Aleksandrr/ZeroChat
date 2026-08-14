-- Migration: signal_device_id_per_user_unique
--
-- Signal Protocol requires `signalDeviceId` (1-127) to be unique
-- WITHIN a single user's device set, NOT globally across all users.
-- The previous global `@unique` constraint broke multi-user setups
-- because two different users could never share the same numeric
-- Signal device id (e.g. both having device id 1).
--
-- This migration:
--   1. Drops the global unique index on `devices.signalDeviceId`.
--   2. Adds a composite unique index on `(userId, signalDeviceId)`.
--
-- `signalDeviceId` is nullable (devices exist before they publish
-- Signal keys). NULL values are not treated as equal by PostgreSQL
-- unique indexes, so multiple devices with NULL signalDeviceId for
-- the same user are still allowed — which is the desired behavior
-- during the initial registration window.

-- 1. Drop the global unique index on signalDeviceId.
DROP INDEX IF EXISTS "devices_signalDeviceId_key";

-- 2. Add composite per-user unique index.
--    NULL values are intentionally allowed (Prisma @@unique emits this
--    as a partial-friendly constraint because PostgreSQL treats NULL
--    as distinct by default in unique indexes).
CREATE UNIQUE INDEX "devices_userId_signalDeviceId_key"
  ON "devices"("userId", "signalDeviceId");
