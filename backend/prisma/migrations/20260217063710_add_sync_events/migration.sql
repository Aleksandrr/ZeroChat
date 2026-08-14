-- CreateTable
CREATE TABLE "sync_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "payloadCiphertext" TEXT NOT NULL,
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_events_userId_serverReceivedAt_idx" ON "sync_events"("userId", "serverReceivedAt");

-- CreateIndex
CREATE INDEX "sync_events_userId_entity_entityId_idx" ON "sync_events"("userId", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_events_deviceId_seq_key" ON "sync_events"("deviceId", "seq");

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
