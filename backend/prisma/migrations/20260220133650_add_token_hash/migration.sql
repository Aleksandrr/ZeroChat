-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "tokenHash" TEXT,
ALTER COLUMN "token" DROP NOT NULL;
