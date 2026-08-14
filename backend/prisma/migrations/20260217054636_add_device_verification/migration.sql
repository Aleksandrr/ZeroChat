-- CreateTable
CREATE TABLE "device_verification_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "device_verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_verification_codes_userId_deviceId_expiresAt_idx" ON "device_verification_codes"("userId", "deviceId", "expiresAt");

-- AddForeignKey
ALTER TABLE "device_verification_codes" ADD CONSTRAINT "device_verification_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_verification_codes" ADD CONSTRAINT "device_verification_codes_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
