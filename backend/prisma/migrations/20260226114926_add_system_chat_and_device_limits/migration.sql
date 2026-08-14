-- AlterEnum
ALTER TYPE "ChatType" ADD VALUE 'SYSTEM';

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "failedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "generationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastCodeRequestAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3);
