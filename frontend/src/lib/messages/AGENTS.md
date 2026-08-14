# Messages Module - AGENTS.md

**Stage 5.3.4**: IndexedDB дедупликация и хранение вложений

## Overview

Этот модуль предоставляет хранение сообщений и вложений в IndexedDB с дедупликацией по SHA-256 хешу.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Messages Module                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  messages   │  │chatMetadata │  │  messageRecords     │ │
│  │   store     │  │   store     │  │    (Sesame)         │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │             attachments store (NEW)                      ││
│  │  ┌──────────────────────────────────────────────────┐   ││
│  │  │  Key: contentHash (SHA-256)                      │   ││
│  │  │  Value: { data, size, timestamp, accessCount }   │   ││
│  │  └──────────────────────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

### 1. Content-Hash Deduplication
- Вложения хранятся по SHA-256 хешу содержимого
- Одинаковые файлы не дублируются в хранилище
- Экономия места при пересылке одних и тех же файлов

### 2. LRU Cleanup Strategy
- Удаление по accessCount (редко используемые первыми)
- Затем по timestamp (старые первыми)
- Целевой лимит: 80% от maxSizeBytes

### 3. Write Queue Protection
- Отдельная очередь записи для вложений
- Предотвращение конфликтов параллельных операций IndexedDB
- Таймауты на все операции (3-30 сек)

## API Reference

### Core Functions (db.ts)

```typescript
// Message operations
storeMessage(message: StoredMessage): Promise<void>
getChatMessages(chatId: string): Promise<StoredMessage[]>
getRecentMessages(chatId: string, limit?: number): Promise<StoredMessage[]>

// Attachment operations (NEW)
import {
  storeAttachment,
  getAttachment,
  hasAttachment,
  deleteAttachment,
  getStorageInfo,
  cleanupAttachments,
} from './attachments';

// Store with deduplication
await storeAttachment(contentHash, data);

// Retrieve from cache
const data = await getAttachment(contentHash);

// Check existence
const exists = await hasAttachment(contentHash);

// Cleanup old files
const result = await cleanupAttachments(500 * 1024 * 1024); // 500MB
```

### Hook (useAttachments.ts)

```typescript
import { useAttachments } from '@/hooks/useAttachments';

function MyComponent() {
  const {
    getAttachment,
    isCached,
    decryptingAttachments,
    decryptErrors,
    storageInfo,
    cleanup,
  } = useAttachments();

  // Get attachment (from cache or decrypt)
  const data = await getAttachment(attachment, encryptedData, senderInfo);
  
  // Check cache status
  const cached = await isCached(contentHash);
  
  // Cleanup old files
  await cleanup(500 * 1024 * 1024); // 500MB limit
}
```

## Storage Schema

### Attachments Store
```typescript
interface StoredAttachment {
  id: string;           // contentHash (SHA-256 hex)
  data: Uint8Array;     // Binary file data
  size: number;         // Size in bytes
  timestamp: number;    // Last access time
  accessCount: number;  // Access frequency
  createdAt: number;    // Initial storage time
}
```

### Indexes
- `timestamp` - For LRU cleanup queries
- `size` - For storage statistics
- `timestamp_size` - Composite for efficient cleanup

## Integration

### With MessageAttachment Component

```tsx
// MessageAttachments now uses contentHash for deduplication
<MessageAttachments
  attachments={message.attachments}
  decryptedData={decryptedDataMap} // Keyed by contentHash
  useContentHash={true} // Enable deduplication
/>
```

### With File Upload

```typescript
import { hashFileContent } from '@/lib/media/crypto';

// When uploading a file
const contentHash = await hashFileContent(fileData);
const attachment: Attachment = {
  id: generateAttachmentId(),
  contentHash, // For deduplication
  fileName: file.name,
  size: file.size,
  mimeType: file.type,
  // ...
};
```

## Configuration

### Default Limits
```typescript
const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const CLEANUP_TARGET_PERCENTAGE = 0.8; // Clean to 80% of max
```

### Database Version
```typescript
const MESSAGES_DB_VERSION = 3; // Bumped for Attachments store
```

## Migration Notes

### From v2 to v3
- New `attachments` store is created automatically
- Existing messages are preserved
- No migration needed for old data

## Performance Considerations

1. **Hash Calculation**: SHA-256 вычисляется при отправке, не при хранении
2. **Cache Lookup**: O(1) по contentHash
3. **Cleanup**: O(n log n) при необходимости очистки
4. **Batch Operations**: storeAttachmentsBatch для множественной записи

## Testing

```typescript
// Test deduplication
const hash = await hashFileContent(data);
await storeAttachment(hash, data);
await storeAttachment(hash, data); // Should not create duplicate

// Test LRU cleanup
await cleanupAttachments(100); // 100 bytes limit
const info = await getStorageInfo();
console.log(info.usedBytes); // Should be <= 80 bytes
```

## Security

- Вложения хранятся в расшифрованном виде (только для отображения)
- SHA-256 используется только для дедупликации, не для безопасности
- Данные не покидают устройство (IndexedDB - local only)

## Related Files

- `db.ts` - Core IndexedDB operations
- `attachments.ts` - Attachment storage (NEW)
- `../media/crypto.ts` - Hash functions
- `../../hooks/useAttachments.ts` - React hook
- `../../components/chat/MessageAttachment.tsx` - UI component
