/*
  Warnings:

  - A unique constraint covering the columns `[inviteCode]` on the table `chats` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "HistoryAccess" AS ENUM ('ALL', 'FROM_NOW', 'NONE');

-- AlterTable
ALTER TABLE "chats" ADD COLUMN     "historyAccess" "HistoryAccess" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "inviteCode" TEXT,
ADD COLUMN     "inviteCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "requireApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "payloadSize" INTEGER;

-- CreateTable
CREATE TABLE "chat_join_requests" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,

    CONSTRAINT "chat_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_join_requests_chatId_idx" ON "chat_join_requests"("chatId");

-- CreateIndex
CREATE INDEX "chat_join_requests_userId_idx" ON "chat_join_requests"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_join_requests_chatId_userId_key" ON "chat_join_requests"("chatId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "chats_inviteCode_key" ON "chats"("inviteCode");

-- AddForeignKey
ALTER TABLE "chat_join_requests" ADD CONSTRAINT "chat_join_requests_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_join_requests" ADD CONSTRAINT "chat_join_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_join_requests" ADD CONSTRAINT "chat_join_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
