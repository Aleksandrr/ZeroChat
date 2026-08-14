-- AlterTable
ALTER TABLE "chats" ADD COLUMN     "description" TEXT,
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mutedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_folders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_folder_items" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,

    CONSTRAINT "chat_folder_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_folders_userId_order_idx" ON "user_folders"("userId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "user_folders_userId_name_key" ON "user_folders"("userId", "name");

-- CreateIndex
CREATE INDEX "chat_folder_items_chatId_idx" ON "chat_folder_items"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_folder_items_folderId_chatId_key" ON "chat_folder_items"("folderId", "chatId");

-- AddForeignKey
ALTER TABLE "user_folders" ADD CONSTRAINT "user_folders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_folder_items" ADD CONSTRAINT "chat_folder_items_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "user_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_folder_items" ADD CONSTRAINT "chat_folder_items_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
