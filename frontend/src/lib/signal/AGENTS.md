# Signal Protocol Module

**Location:** [`frontend/src/lib/signal/`](frontend/src/lib/signal/)

**Purpose:** End-to-end encryption implementation using Signal Protocol with post-quantum security (PQXDH + Kyber-768).

---

## Overview

Signal Protocol модуль в ZeroChat-TS обеспечивает сквозное шифрование сообщений с использованием:

- **X3DH** (Extended Triple Diffie-Hellman) - протокол согласования ключей для установления сессий
- **PQXDH** (Post-Quantum X3DH) - постквантовая версия с Kyber-768
- **Double Ratchet** - алгоритм обеспечивающий forward secrecy и future secrecy
- **Sesame** - протокол синхронизации нескольких устройств

Все криптографические операции выполняются через WASM модуль `@getmaapp/signal-wasm`. Ключи и состояния сессий хранятся в IndexedDB.

---

## Core Modules

### [`index.ts`](frontend/src/lib/signal/index.ts:1)

Главный экспорт SignalClient. Предоставляет класс [`SignalProtocol`](frontend/src/lib/signal/index.ts:1) и утилиты для шифрования/дешифрования.

**Key Functions:**

| Function | Description |
|----------|-------------|
| [`initializeSignal()`](frontend/src/lib/signal/index.ts:1) | Инициализация Signal Protocol для нового пользователя |
| [`initializeSignalWithRestore()`](frontend/src/lib/signal/index.ts:1) | Восстановление существующего состояния из IndexedDB |
| [`encryptMessage()`](frontend/src/lib/signal/index.ts:1) | Шифрование сообщения для получателя |
| [`decryptMessage()`](frontend/src/lib/signal/index.ts:1) | Дешифрование входящего сообщения |
| [`ensureKeys()`](frontend/src/lib/signal/index.ts:1) | Импорт ключей из IndexedDB в WASM |
| [`processPreKeyBundle()`](frontend/src/lib/signal/index.ts:1) | Обработка PreKey bundle для установки сессии |

**Operation Queue (Mutex):**
```typescript
// CRITICAL: Сериализация WASM операций для предотвращения повреждения ratchet state
class SignalOperationQueue {
  async enqueue<T>(operation: QueuedOperation<T>): Promise<T>
}
```

### [`types.ts`](frontend/src/lib/signal/types.ts:1)

TypeScript типы для Signal Protocol.

**Core Types:**

| Type | Description |
|------|-------------|
| [`IdentityKeyData`](frontend/src/lib/signal/types.ts:8) | Identity key pair с metadata |
| [`PreKeyBundle`](frontend/src/lib/signal/types.ts:158) | Pre-key bundle для X3DH/PQXDH |
| [`SessionState`](frontend/src/lib/signal/types.ts:55) | Состояние сессии Double Ratchet |
| [`EncryptedMessage`](frontend/src/lib/signal/types.ts:143) | Зашифрованное сообщение |
| [`SignalClientState`](frontend/src/lib/signal/types.ts:116) | Состояние SignalClient для восстановления |

**Sesame Types:**
- [`UserRecord`](frontend/src/lib/signal/types.ts:82) - Запись пользователя для multi-device
- [`DeviceRecord`](frontend/src/lib/signal/types.ts:66) - Запись устройства
- [`LinkedDevice`](frontend/src/lib/signal/types.ts:102) - Связанное устройство
- [`SenderKeyRecord`](frontend/src/lib/signal/types.ts:91) - Sender key для групповых чатов

### [`core/x3dh.ts`](frontend/src/lib/signal/core/x3dh.ts:1)

X3DH (Extended Triple Diffie-Hellman) протокол согласования ключей.

**Features:**
- 3 или 4 DH вычисления для создания shared secret
- Использует identity keys, signed pre-keys, и one-time pre-keys
- KDF с info строкой `'ZeroChat_X3DH'`

**Key Functions:**
```typescript
async function processPreKeyBundle(bundle: PreKeyBundle): Promise<void>
async function generateX3DHSharedSecret(/* ... */): Promise<Uint8Array>
```

### [`core/pqxdh.ts`](frontend/src/lib/signal/core/pqxdh.ts:1)

PQXDH (Post-Quantum Extended Diffie-Hellman) - постквантовая версия X3DH с Kyber-768.

**Features:**
- Классическая безопасность через X25519
- Постквантовая безопасность через Kyber-768
- Гибридное key derivation

**Constants:**
```typescript
const KYBER_PUBLIC_KEY_SIZE = 1184
const KYBER_CIPHERTEXT_SIZE = 1088
const KYBER_SHARED_SECRET_SIZE = 32
const PQXDH_INFO = 'ZeroChat_PQXDH'
```

### [`core/kyber.ts`](frontend/src/lib/signal/core/kyber.ts:1)

Kyber-768 постквантовый KEM (Key Encapsulation Mechanism).

**NIST-standardized parameters:**
```typescript
KYBER_N = 256              // Polynomial degree
KYBER_Q = 3329             // Modulus
KYBER_K = 3                // Vector dimension
KYBER_PUBLICKEYBYTES = 1184
KYBER_CIPHERTEXTBYTES = 1088
KYBER_SSBYTES = 32         // Shared secret size
```

**Note:** Реальные криптографические операции делегируются `signal-wasm`. Этот модуль предоставляет константы и валидацию.

### [`core/double-ratchet.ts`](frontend/src/lib/signal/core/double-ratchet.ts:1)

Double Ratchet алгоритм для forward secrecy и break-in recovery.

**Algorithm Components:**
1. **Symmetric Key Ratchet** - для шифрования сообщений
2. **DH Ratchet** - для forward secrecy (асинхронное вращение ключей)

**Message Types:**
```typescript
MESSAGE_TYPES = {
  PRE_KEY: 3,      // PreKeyMessage - establishes new session
  SIGNAL: 2,       // SignalMessage - existing session
  SENDER_KEY: 4,   // SenderKeyMessage - group messaging
}
```

**Key Functions:**
```typescript
async function encryptMessage(client, recipientId, deviceId, plaintext): Promise<EncryptedMessage>
async function decryptMessage(client, senderId, deviceId, message): Promise<DecryptedMessage>
```

---

## Storage Layer (IndexedDB)

### [`storage/db.ts`](frontend/src/lib/signal/storage/db.ts:1)

Настройка и управление IndexedDB для Signal Protocol.

**Database Configuration:**
```typescript
const DB_NAME = 'ZeroChatSignalDB'
const DB_VERSION = 4
```

**Stores:**
```typescript
STORES = {
  IDENTITY_KEY: 'identityKeys',
  PRE_KEY: 'preKeys',
  SIGNED_PRE_KEY: 'signedPreKeys',
  KYBER_PRE_KEY: 'kyberPreKeys',
  SESSION: 'sessions',
  SENDER_KEY: 'senderKeys',
  REGISTRATION: 'registration',
  LINKED_DEVICES: 'linkedDevices',
  LINKING_REQUESTS: 'linkingRequests',
  SESAME_STATE: 'sesameState',
  SIGNAL_CLIENT_STATE: 'signalClientState',
}
```

**RC-8 Fix:** Promise-based mutex для предотвращения параллельной инициализации:
```typescript
let signalDbInitPromise: Promise<IDBDatabase> | null = null
```

### [`storage/identity.ts`](frontend/src/lib/signal/storage/identity.ts:1)

Хранение identity keys и registration data.

**Key Functions:**

| Function | Description |
|----------|-------------|
| [`storeIdentityKey()`](frontend/src/lib/signal/storage/identity.ts:15) | Сохранение identity key pair |
| [`persistIdentity()`](frontend/src/lib/signal/storage/identity.ts:36) | Сохранение с counter-ами |
| [`loadIdentityKey()`](frontend/src/lib/signal/storage/identity.ts:1) | Загрузка identity key |
| [`hasIdentityKey()`](frontend/src/lib/signal/storage/identity.ts:1) | Проверка наличия identity |
| [`loadLocalDeviceUuid()`](frontend/src/lib/signal/storage/identity.ts:1) | Загрузка UUID устройства |

### [`storage/keys.ts`](frontend/src/lib/signal/storage/keys.ts:1)

Хранение PreKeys, SignedPreKeys, и KyberPreKeys с полными WASM записями.

**Database Records:**
```typescript
interface DBPreKeyRecord {
  id: number
  uuid: string
  publicKey: string
  record: string        // WASM record (base64)
  createdAt: number
}
```

**Key Functions:**
```typescript
async function storePreKeyWithRecord(uuid, id, publicKey, record): Promise<void>
async function loadPreKeyRecord(uuid, id): Promise<Uint8Array | undefined>
async function removePreKeyRecord(uuid, id): Promise<void>
async function loadAllPreKeyRecords(uuid): Promise<Array<...>>
```

### [`storage/sessions.ts`](frontend/src/lib/signal/storage/sessions.ts:1)

Хранение сессий для Double Ratchet алгоритма.

**Database Record:**
```typescript
interface DBSessionRecord {
  localUuid: string
  remoteUuid: string
  remoteDeviceId: number
  record: string        // WASM session record (base64)
  createdAt: number
  updatedAt: number
}
```

**Key Functions:**
```typescript
async function storeSessionWithRecord(localUuid, remoteUuid, deviceId, record): Promise<void>
async function loadSessionRecord(localUuid, remoteUuid, deviceId): Promise<SessionRecord | undefined>
async function loadAllSessionRecords(localUuid): Promise<Array<...>>
async function removeAllSessionsForDevice(localUuid, remoteUuid, deviceId): Promise<void>
```

### [`storage/state.ts`](frontend/src/lib/signal/storage/state.ts:1)

Сохранение состояния SignalClient для восстановления после перезагрузки страницы.

**Key Functions:**
```typescript
async function saveSignalClientState(state: {
  userId: string
  identityKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array }
  registrationId: number
  deviceId: number
  nextPreKeyId: number
  nextSignedPreKeyId: number
  nextKyberPreKeyId: number
  localDeviceUuid: string
}): Promise<void>

async function loadSignalClientState(): Promise<SignalClientState | null>
async function restoreSignalClient(): Promise<boolean>
```

### [`storage/sesame.ts`](frontend/src/lib/signal/storage/sesame.ts:1)

Хранение для Sesame multi-device протокола.

**Data Types:**
- Linked devices (связанные устройства)
- Linking requests (запросы на связывание)
- Sender keys (для групповых чатов)
- Sesame state (состояние протокола)

**Key Functions:**
```typescript
async function storeLinkedDevice(device: LinkedDevice): Promise<void>
async function getLinkedDevice(id: number): Promise<LinkedDevice | undefined>
async function storeSenderKey(groupId, senderUserId, senderKeyId, state): Promise<void>
async function loadSenderKey(groupId, senderUserId): Promise<SenderKeyRecord | undefined>
async function saveSesameState(state: string): Promise<void>
async function loadSesameState(): Promise<string | null>
```

---

## Utils

### [`utils/crypto.ts`](frontend/src/lib/signal/utils/crypto.ts:1)

Криптографические утилиты для Signal Protocol.

**UUID Generation:**
```typescript
function bytesToUuid(bytes: Uint8Array): string  // Конвертация WASM UUID в строку
function generateRandomBytes(length: number): Uint8Array
function generateRandomInt(min: number, max: number): number
```

**HMAC Operations:**
```typescript
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>
async function verifyHmacSha256(key, data, signature): Promise<boolean>
```

**Key Derivation:**
```typescript
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string, length: number): Promise<Uint8Array>
async function deriveKeys(seed: Uint8Array, info: string, count: number): Promise<Uint8Array[]>
```

**Hash Functions:**
```typescript
async function sha256(data: Uint8Array): Promise<Uint8Array>
async function sha512(data: Uint8Array): Promise<Uint8Array>
```

---

## Key Management Flow

### 1. [`ensureKeys()`](frontend/src/lib/signal/index.ts:1) - Импорт ключей в WASM

**Purpose:** Импортирует PreKeys, SignedPreKeys, и KyberPreKeys из IndexedDB в WASM память.

**Critical:** Без вызова `ensureKeys()` дешифрование PreKeyMessage (type 3) будет неудачным.

**Flow:**
```typescript
async function ensureKeys(): Promise<void> {
  // 1. Check if already loaded
  if (wasmPreKeysLoaded) return
  
  // 2. Load keys from IndexedDB
  const preKeys = await loadAllPreKeyRecords(localUuid)
  const signedPreKeys = await loadAllSignedPreKeyRecords(localUuid)
  const kyberPreKeys = await loadAllKyberPreKeyRecords(localUuid)
  
  // 3. Import into WASM
  for (const key of preKeys) {
    await signalClient.importPreKey(key.id, key.record)
  }
  // ... same for signedPreKeys and kyberPreKeys
  
  wasmPreKeysLoaded = true
}
```

### 2. [`saveSession()`](frontend/src/lib/signal/index.ts:1) - Сохранение сессии

**Purpose:** Сохраняет состояние сессии в IndexedDB после encrypt/decrypt операций.

**Called automatically by:**
- `encryptMessage()` - после шифрования
- `decryptMessage()` - после дешифрования

**Flow:**
```typescript
async function saveSession(recipientId: string, deviceId: number): Promise<void> {
  // 1. Get session state from WASM
  const sessionState = await signalClient.getSessionState(recipientId, deviceId)
  if (!sessionState) return
  
  // 2. Store in IndexedDB
  await storeSessionWithRecord(
    localUuid,
    recipientUuid,
    deviceId,
    sessionState
  )
}
```

### 3. [`SignalClient.restore()`](frontend/src/lib/signal/index.ts:1) - Восстановление identity

**Purpose:** Восстанавливает SignalClient из сохраненного состояния.

**Requires 8 parameters:**
```typescript
SignalClient.restore(
  registrationId,
  deviceId,
  identityKeyPair.publicKey,
  identityKeyPair.privateKey,
  nextPreKeyId,
  nextSignedPreKeyId,
  nextKyberPreKeyId,
  localDeviceUuid
)
```

**After restore:** MUST call `ensureKeys()` to import keys into WASM!

---

## Usage Examples

### From SignalContext

```typescript
// contexts/SignalContext.tsx
import * as signal from '@/lib/signal'
import * as signalStorage from '@/lib/signal/storage'

// Initialize Signal Protocol
const result = await signal.initializeSignalWithRestore(userId)

// Encrypt message
const encrypted = await signal.encryptMessage(
  recipientId,
  recipientDeviceId,
  new TextEncoder().encode(message)
)

// Decrypt message
const decrypted = await signal.decryptMessage(
  senderId,
  senderDeviceId,
  encryptedData,
  messageType
)
const plaintext = new TextDecoder().decode(decrypted.body)

// Process PreKey bundle (for new chat)
await signal.processPreKeyBundle(recipientId, deviceId, preKeyBundle)

// Check if session exists
const hasSession = await signal.hasSession(recipientId, deviceId)

// Generate PreKey bundle for publishing
const bundle = await signal.generatePreKeyBundle(
  preKeyId,
  signedPreKeyId,
  kyberPreKeyId
)
```

### Key Publishing Flow

```typescript
// SignalContext.tsx initialization
if (result.keysForPublishing) {
  const { preKeys, signedPreKeys, kyberPreKeys, identityKey, registrationId, deviceId } = 
    result.keysForPublishing
  
  await publishSignalKeys({
    userId,
    deviceId,
    identityKey,
    registrationId,
    preKeys,
    signedPreKeys,
    kyberPreKeys
  })
}
```

### Storage Operations

```typescript
// Check for existing identity
const hasIdentity = await signalStorage.hasIdentityKey(userId)

// Load device UUID
const uuid = await signalStorage.loadLocalDeviceUuid()

// Store PreKey with full WASM record
await signalStorage.storePreKeyWithRecord(
  uuid,
  preKeyId,
  publicKey,
  wasmRecord
)

// Restore all sessions
const sessions = await signalStorage.loadAllSessionRecords(uuid)
for (const session of sessions) {
  await signalClient.loadSession(
    session.remoteUuid,
    session.remoteDeviceId,
    session.record
  )
}
```

---

## Security Considerations

1. **WASM Operation Queue** - Критически важна сериализация операций для предотвращения повреждения ratchet state при параллельных вызовах

2. **Session Corruption Detection** - Отслеживание неудач дешифрования для обнаружения поврежденных сессий

3. **PreKey Consumption** - One-time pre-keys удаляются после использования (atomic on backend)

4. **Key Rotation** - SignedPreKeys и KyberPreKeys ротируются периодически

5. **Post-Quantum Security** - Kyber-768 обеспечивает защиту от квантовых атак

6. **Device Verification Requirement** (2026-03-07) - Signal Protocol инициализация блокируется до верификации устройства (`verifiedAt !== null`). Защита от компрометации JWT токена:
   - Frontend: `SignalContext` проверяет `device.verified_at` перед инициализацией
   - Backend: Все эндпоинты публикации ключей (`/publish`, `/one-time`) и WebSocket `handlePreKeyMessage` проверяют верификацию
   - Неверифицированные устройства получают `403 Forbidden` при попытке публикации ключей

---

## Related Documentation

| Document | Path |
|----------|------|
| Signal Protocol Theory | [`docs/signal/libsignal-integration.md`](docs/signal/libsignal-integration.md) |
| PQXDH/Kyber Details | [`docs/signal/pqxdh-kyber.md`](docs/signal/pqxdh-kyber.md) |
| WASM Integration | [`docs/signal/signal-wasm.md`](docs/signal/signal-wasm.md) |
| Sesame Protocol | [`docs/signal/sesame.md`](docs/signal/sesame.md) |
| Sender Keys Rotation | [`docs/signal/SENDER_KEYS_ROTATION_PLAN.md`](docs/signal/SENDER_KEYS_ROTATION_PLAN.md) |

---

**Recent Changes:**
- 2026-03-07: Added device verification security requirement (block Signal init until verified)
- 2026-03-02: Added SENDER_KEYS_ROTATION_PLAN.md documentation

*Last updated: 2026-03-07*
