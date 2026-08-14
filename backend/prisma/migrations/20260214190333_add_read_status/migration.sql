-- AlterTable
ALTER TABLE "chat_users" ADD COLUMN     "lastReadAt" TIMESTAMP(3),
ADD COLUMN     "unreadCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "message_read_status" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_read_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_read_status_userId_idx" ON "message_read_status"("userId");

-- CreateIndex
CREATE INDEX "message_read_status_messageId_idx" ON "message_read_status"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "message_read_status_messageId_userId_key" ON "message_read_status"("messageId", "userId");

-- CreateIndex
CREATE INDEX "chat_users_userId_idx" ON "chat_users"("userId");

-- AddForeignKey
ALTER TABLE "message_read_status" ADD CONSTRAINT "message_read_status_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_read_status" ADD CONSTRAINT "message_read_status_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
