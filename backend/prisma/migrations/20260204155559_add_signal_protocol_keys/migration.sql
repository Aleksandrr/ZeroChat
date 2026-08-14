-- CreateTable
CREATE TABLE "device_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "registrationId" INTEGER NOT NULL DEFAULT 0,
    "identityKeyPub" TEXT NOT NULL,
    "signedPreKeyId" INTEGER NOT NULL DEFAULT 0,
    "signedPreKeyPub" TEXT NOT NULL,
    "signedPreKeySig" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ec_one_time_prekeys" (
    "id" TEXT NOT NULL,
    "deviceKeysId" TEXT NOT NULL,
    "preKeyId" INTEGER NOT NULL,
    "preKeyPub" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ec_one_time_prekeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pq_kem_one_time_prekeys" (
    "id" TEXT NOT NULL,
    "deviceKeysId" TEXT NOT NULL,
    "preKeyId" INTEGER NOT NULL,
    "preKeyPub" TEXT NOT NULL,
    "preKeySig" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pq_kem_one_time_prekeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pq_kem_last_resort_prekey" (
    "id" TEXT NOT NULL,
    "deviceKeysId" TEXT NOT NULL,
    "preKeyId" INTEGER NOT NULL DEFAULT 0,
    "preKeyPub" TEXT NOT NULL,
    "preKeySig" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pq_kem_last_resort_prekey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_key_distribution" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "chainKey" TEXT NOT NULL,
    "signatureKeyPub" TEXT NOT NULL,
    "signatureKeyPriv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_key_distribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_key_distribution_message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "receiverUserId" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_key_distribution_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_keys_userId_idx" ON "device_keys"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "device_keys_userId_deviceId_key" ON "device_keys"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "ec_one_time_prekeys_deviceKeysId_idx" ON "ec_one_time_prekeys"("deviceKeysId");

-- CreateIndex
CREATE UNIQUE INDEX "ec_one_time_prekeys_deviceKeysId_preKeyId_key" ON "ec_one_time_prekeys"("deviceKeysId", "preKeyId");

-- CreateIndex
CREATE INDEX "pq_kem_one_time_prekeys_deviceKeysId_idx" ON "pq_kem_one_time_prekeys"("deviceKeysId");

-- CreateIndex
CREATE UNIQUE INDEX "pq_kem_one_time_prekeys_deviceKeysId_preKeyId_key" ON "pq_kem_one_time_prekeys"("deviceKeysId", "preKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "pq_kem_last_resort_prekey_deviceKeysId_key" ON "pq_kem_last_resort_prekey"("deviceKeysId");

-- CreateIndex
CREATE INDEX "sender_key_distribution_chatId_idx" ON "sender_key_distribution"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "sender_key_distribution_chatId_senderUserId_deviceId_key" ON "sender_key_distribution"("chatId", "senderUserId", "deviceId");

-- CreateIndex
CREATE INDEX "sender_key_distribution_message_chatId_receiverUserId_idx" ON "sender_key_distribution_message"("chatId", "receiverUserId");

-- CreateIndex
CREATE INDEX "sender_key_distribution_message_distributionId_idx" ON "sender_key_distribution_message"("distributionId");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- AddForeignKey
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ec_one_time_prekeys" ADD CONSTRAINT "ec_one_time_prekeys_deviceKeysId_fkey" FOREIGN KEY ("deviceKeysId") REFERENCES "device_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pq_kem_one_time_prekeys" ADD CONSTRAINT "pq_kem_one_time_prekeys_deviceKeysId_fkey" FOREIGN KEY ("deviceKeysId") REFERENCES "device_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pq_kem_last_resort_prekey" ADD CONSTRAINT "pq_kem_last_resort_prekey_deviceKeysId_fkey" FOREIGN KEY ("deviceKeysId") REFERENCES "device_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_key_distribution" ADD CONSTRAINT "sender_key_distribution_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_key_distribution" ADD CONSTRAINT "sender_key_distribution_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("deviceId") ON DELETE RESTRICT ON UPDATE CASCADE;
