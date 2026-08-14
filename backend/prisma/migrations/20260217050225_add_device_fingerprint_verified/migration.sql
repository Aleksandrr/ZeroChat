-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "devices_userId_idx" ON "devices"("userId");
