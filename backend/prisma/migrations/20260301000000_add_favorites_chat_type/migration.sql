-- Add FAVORITES to ChatType enum
-- PostgreSQL не позволяет добавлять значения в enum напрямую
-- Создаём новый enum, меняем тип колонки, удаляем старый enum

-- 1. Удаляем значение по умолчанию
ALTER TABLE "chats" ALTER COLUMN "type" DROP DEFAULT;

-- 2. Создаём новый enum с FAVORITES
CREATE TYPE "ChatType_new" AS ENUM ('PRIVATE', 'GROUP', 'CHANNEL', 'SYSTEM', 'FAVORITES');

-- 3. Меняем тип колонки type в таблице chats
ALTER TABLE "chats" ALTER COLUMN "type" TYPE "ChatType_new" USING ("type"::text::"ChatType_new");

-- 4. Восстанавливаем значение по умолчанию
ALTER TABLE "chats" ALTER COLUMN "type" SET DEFAULT 'PRIVATE';

-- 5. Удаляем старый enum
DROP TYPE "ChatType";

-- 6. Переименовываем новый enum
ALTER TYPE "ChatType_new" RENAME TO "ChatType";
