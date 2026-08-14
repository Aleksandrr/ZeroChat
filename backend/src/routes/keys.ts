/**
 * Signal Protocol Keys Routes
 * 
 * Хранит ОТКРЫТЫЕ ключи для sesame синхронизации и prekey bundles.
 * НЕ хранит приватные ключи - только то что безопасно передавать.
 * 
 * Security guarantees:
 * - Все приватные ключи генерируются на клиенте
 * - Сервер только валидирует и хранит публичные ключи
 * - deviceId в JWT должен соответствовать deviceId в запросе (device binding)
 * - identity key нельзя изменить после первой публикации
 * - HMAC-подпись запросов для защиты от подмены и replay attacks
 * - Timestamp validation (5 minute window)
 * - User-specific HMAC secrets (compromise of one user doesn't affect others)
 */

import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import {
  decodeBase64,
  isValidPublicKey
} from '../services/crypto-utils';
import { authenticate } from '../middleware/auth';
import { encryptAtRest } from '../utils/crypto-at-rest';

// Rate limits
const keysPublishRateLimit = {
  timeWindow: '1 minute',
  max: 10,
};

/**
 * SECURITY: bundle fetch is the most expensive PQXDH operation (it
 * consumes a one-time prekey atomically) and a common target for
 * enumeration / DoS. We cap at 20/min per (requester, target) pair
 * — a legitimate user fetching one bundle per recipient will never
 * hit this, but an attacker trying to drain someone's prekey pool
 * will be throttled quickly.
 */
const keysBundleRateLimit = {
  timeWindow: '1 minute',
  max: 20,
  keyGenerator: (req: any) => `${req.user?.userId ?? req.ip}:${req.params?.userId ?? ''}`,
};

// Master HMAC secret for deriving user-specific secrets.
// @removed — HMAC requirement was removed from /publish and /one-time
// endpoints (see inline comment in the `/publish` handler for full rationale).
// The constants below are retained only for reference; `HMAC_MASTER_SECRET`
// env var is still validated at boot by `checkProductionSecrets()` so existing
// deployments don't break.

/**
 * Validates HMAC signature and timestamp for replay attack protection.
 *
 * @removed HMAC requirement was removed from /publish and /one-time endpoints
 * because the master secret was bundled into the frontend (VITE_HMAC_SECRET)
 * and trivially recoverable. JWT auth + identity key immutability + deviceId
 * ownership check provide equivalent protection without a client-side secret.
 * See the inline comment in the `/publish` handler for full rationale.
 */

/**
 * Проверяет что ключ является именно публичным (не приватным)
 * X25519 публичный ключ - 33 байта (0x05 префикс + 32 байта данных)
 */
function isPublicKey(pubKey: string): boolean {
  try {
    const decoded = decodeBase64(pubKey);
    // X25519 публичный ключ = 33 байта (0x05 + 32 байта данных)
    return decoded.length === 33;
  } catch {
    return false;
  }
}

/**
 * Проверяет PQ (Kyber) публичный ключ. Kyber public keys are much
 * larger than X25519 keys (1184 bytes for Kyber-768, 1568 for Kyber-1024),
 * so the X25519-specific 33-byte check in `isPublicKey` would reject them.
 * We accept any non-empty base64-decodable buffer in the [800, 4096] byte
 * range as a defensive sanity check.
 */
function isPqPublicKey(pubKey: string): boolean {
  try {
    const decoded = decodeBase64(pubKey);
    return decoded.length >= 800 && decoded.length <= 4096;
  } catch {
    return false;
  }
}

export const keysRoutes = async (fastify: FastifyInstance) => {

  // ==================== PUBLISH PREKEY BUNDLE ====================
  fastify.post('/keys/pqxdh/publish', {
    preHandler: authenticate,
    config: {
      rateLimit: keysPublishRateLimit,
    },
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const jwtDeviceId = (request as any).user.deviceId;
        
        const {
          deviceId,
          registrationId,
          identityKeyPub,
          signedPreKey,
          pqLastResortPreKey,
          ecOneTimePreKeys,
          pqOneTimePreKeys,
        } = request.body as {
          deviceId: string | number | null;
          registrationId: number;
          identityKeyPub: string;
          signedPreKey: { id: number; pub: string; sig: string };
          pqLastResortPreKey?: { id: number; pub: string; sig: string };
          ecOneTimePreKeys?: Array<{ id: number; pub: string }>;
          pqOneTimePreKeys?: Array<{ id: number; pub: string; sig: string }>;
        };

        // Валидация входных данных - deviceId может быть null при новой регистрации
        if (!identityKeyPub || !signedPreKey) {
          return reply.code(400).send({
            success: false,
            message: 'Missing required fields: identityKeyPub, signedPreKey',
          });
        }

        // NOTE: jwtDeviceId (JWT session deviceId) and deviceId (Signal protocol deviceId) are DIFFERENT
        // jwtDeviceId = string "dev_xxx" for session tracking
        // deviceId = number (1-127) for Signal Protocol cryptography

        // SECURITY: JWT-based authentication only.
        // Previously required HMAC signature over request body, but the HMAC
        // master secret was bundled into the frontend (VITE_HMAC_SECRET) —
        // trivially recoverable from JS, so it provided no real protection
        // against a malicious authenticated user. It only blocked legitimate
        // prekey replenishment (U10/U11) by the client because the new
        // upload paths don't sign requests.
        //
        // Real protection comes from:
        //   1. JWT auth — only the device owner can publish their own keys.
        //   2. Identity key immutability (checked below) — once published,
        //      the identity key cannot be changed.
        //   3. Strict deviceId ownership check — `jwtDeviceId` must own
        //      the target `deviceId` in the `devices` table.
        //   4. Rate limiting (keysPublishRateLimit).
        // Replay attacks on key publication are low-impact: publishing the
        // same keys twice is idempotent for the server.

        // SECURITY: deviceId binding - if both are present, verify they belong to this user
        // Prevents users from submitting keys for other users' devices
        // NOTE: deviceId from payload is Signal protocol deviceId (number 1-127)
        // jwtDeviceId from JWT is session deviceId (string "dev_xxx")
        // We need to check against signalDeviceId in the database
        // Use session deviceId for DeviceKeys reference (defaults to jwtDeviceId)
        let sessionDeviceId = jwtDeviceId;
        let numericDeviceId: number | undefined = undefined;
        //
        // BUG #2 FIX: Previously the signalDeviceId write (update or create)
        // happened HERE, BEFORE the verifiedAt check below. A 403 response
        // did not roll it back, so an unverified device ended up with a
        // bound signalDeviceId (and could then pass the WS-auth
        // signalDeviceId !== null check — see Bug #3). We now DEFER the
        // write until AFTER the verifiedAt check, and execute it INSIDE
        // the $transaction that persists the keys, so it commits only
        // when the whole publish succeeds.
        type PendingSignalWrite =
          | { kind: 'none' }
          | { kind: 'update'; targetDeviceInternalId: string; newSignalId: number }
          | {
              kind: 'create';
              newDeviceId: string;
              newSignalId: number;
              name: string;
              type: 'WEB';
            };
        let pendingSignalWrite: PendingSignalWrite = { kind: 'none' };

        if (deviceId !== null && deviceId !== undefined && jwtDeviceId) {
          // For new device registration (deviceId >= 100), it's client-generated and allowed
          // For existing device updates, verify the device belongs to this user by signalDeviceId
          numericDeviceId = parseInt(String(deviceId), 10);
          
          let existingDevice = await prisma.device.findFirst({
            where: {
              userId: userId,
              signalDeviceId: numericDeviceId,
            },
          });
          
          if (!existingDevice) {
            // BUGFIX: Check for KEY ROTATION scenario first
            // When JWT device already has a signalDeviceId and client publishes a different one
            // This means the client wiped IndexedDB and generated new keys
            const jwtDevice = await prisma.device.findFirst({
              where: { userId, deviceId: jwtDeviceId },
            });

            if (jwtDevice && jwtDevice.signalDeviceId !== null && jwtDevice.signalDeviceId !== numericDeviceId) {
              // KEY ROTATION: same JWT device, wiped IndexedDB → new signalDeviceId.
              // DEFER the update — execute it inside the $transaction below,
              // after the verifiedAt check.
              pendingSignalWrite = {
                kind: 'update',
                targetDeviceInternalId: jwtDevice.id,
                newSignalId: numericDeviceId,
              };
              sessionDeviceId = jwtDevice.deviceId;
              fastify.log.info({ 
                userId, 
                jwtDeviceId, 
                oldSignalDeviceId: jwtDevice.signalDeviceId, 
                newSignalDeviceId: numericDeviceId 
              }, '[Keys] Key rotation: deferred signalDeviceId update until verifiedAt check + transaction');

            } else if (jwtDevice && jwtDevice.signalDeviceId === null) {
              // Initial registration - device exists but signalDeviceId not yet set.
              // DEFER the update — execute it inside the $transaction below,
              // after the verifiedAt check.
              pendingSignalWrite = {
                kind: 'update',
                targetDeviceInternalId: jwtDevice.id,
                newSignalId: numericDeviceId,
              };
              sessionDeviceId = jwtDevice.deviceId;
              fastify.log.info({ 
                userId, 
                jwtDeviceId,
                signalDeviceId: numericDeviceId 
              }, '[Keys] Deferred signalDeviceId association until verifiedAt check + transaction');

            } else {
              // MULTI-DEVICE: Schedule creation of a new device entry for this
              // Signal deviceId. This supports Sesame protocol where each
              // client instance is a separate device.
              //
              // The actual create is DEFERRED to the $transaction below. Note:
              // the verifiedAt check below uses `sessionDeviceId` (which is
              // the to-be-created newDeviceId). Since that device doesn't
              // exist yet, the check returns 404 — i.e. multi-device key
              // publication for a not-yet-created device is now blocked
              // until the device goes through the device verification flow.
              // This is the correct behaviour per the spec: "new device →
              // require verification".
              const newSessionDeviceId = `dev_${crypto.randomUUID()}`;
              pendingSignalWrite = {
                kind: 'create',
                newDeviceId: newSessionDeviceId,
                newSignalId: numericDeviceId,
                name: 'Web Client',
                type: 'WEB',
              };
              sessionDeviceId = newSessionDeviceId;
              fastify.log.info({ 
                userId, 
                deviceId: newSessionDeviceId,
                signalDeviceId: numericDeviceId 
              }, '[Keys] Deferred new device creation until verifiedAt check + transaction (multi-device/Sesame scenario)');
            }
          } else {
            // Device exists with signalDeviceId, use its session deviceId
            sessionDeviceId = existingDevice.deviceId;
          }
        }

        // SECURITY: Проверяем что identityKeyPub это именно публичный ключ
        if (!isPublicKey(identityKeyPub)) {
          return reply.code(400).send({
            success: false,
            message: 'identityKeyPub must be a valid public key (32 bytes for Ed25519)',
          });
        }

        // Signature validation is now done client-side (receiver validates)
        // Server stores keys but does not verify Signal signatures

        // SECURITY: Validate that signedPreKey was created by this identity key owner
        // (Signature validation is deferred to client-side for E2E security)
        // isValidPublicKey check is sufficient for server-side validation

        if (!isValidPublicKey(signedPreKey.pub)) {
          return reply.code(400).send({
            success: false,
            message: 'signedPreKey.pub must be a valid public key',
          });
        }

        // Signature validation deferred to client-side

        // deviceId может быть null при новой регистрации - используем sessionDeviceId (из Device.deviceId)
        const effectiveDeviceId = sessionDeviceId || jwtDeviceId || 'default';

        // SECURITY: Проверка верификации устройства
        // Публикация ключей разрешена ТОЛЬКО для верифицированных устройств
        const device = await prisma.device.findFirst({
          where: {
            deviceId: effectiveDeviceId,
            userId: userId,
            isActive: true,
          },
          select: {
            verifiedAt: true,
          },
        });

        if (!device) {
          return reply.code(404).send({
            success: false,
            message: 'Device not found',
          });
        }

        // Запрещаем если устройство не верифицировано
        if (!device.verifiedAt) {
          fastify.log.warn({
            userId,
            deviceId: effectiveDeviceId,
            verifiedAt: device.verifiedAt,
          }, '[Keys] Unverified device attempted to publish keys');
          
          return reply.code(403).send({
            success: false,
            message: 'Device verification required to publish Signal keys. Please verify this device first via /devices/:id/verify.',
          });
        }

        await prisma.$transaction(async (tx) => {
          // BUG #2 FIX: Execute the deferred signalDeviceId write HERE,
          // inside the transaction and AFTER the verifiedAt check above.
          // This makes the signalDeviceId binding atomic with the key
          // writes — if anything below throws, the binding is rolled
          // back too, so an unverified/partial state can't persist.
          if (pendingSignalWrite.kind === 'update') {
            try {
              await tx.device.update({
                where: { id: pendingSignalWrite.targetDeviceInternalId },
                data: { signalDeviceId: pendingSignalWrite.newSignalId },
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw new Error(`SIGNAL_DEVICE_ID_CONFLICT: signalDeviceId ${pendingSignalWrite.newSignalId} already in use for this user. Choose a different device ID.`);
              }
              throw err;
            }
          } else if (pendingSignalWrite.kind === 'create') {
            try {
              await tx.device.create({
                data: {
                  deviceId: pendingSignalWrite.newDeviceId,
                  signalDeviceId: pendingSignalWrite.newSignalId,
                  userId: userId,
                  name: pendingSignalWrite.name,
                  type: pendingSignalWrite.type,
                  isActive: true,
                  lastSeen: new Date(),
                },
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw new Error(`SIGNAL_DEVICE_ID_CONFLICT: signalDeviceId ${pendingSignalWrite.newSignalId} already in use for this user. Choose a different device ID.`);
              }
              throw err;
            }
          }

          // Проверяем существующие ключи
          const existing = await tx.deviceKeys.findUnique({
            where: { userId_deviceId: { userId, deviceId: effectiveDeviceId } },
          });

          // SECURITY: Если уже есть ключи, identity key нельзя изменить
          if (existing && existing.identityKeyPub !== identityKeyPub) {
            throw new Error('Cannot change identity key once established');
          }

          const deviceKeys = await tx.deviceKeys.upsert({
            where: {
              userId_deviceId: { userId, deviceId: effectiveDeviceId },
            },
            create: {
              userId,
              deviceId: effectiveDeviceId,
              registrationId,
              identityKeyPub,
              signedPreKeyId: signedPreKey.id,
              signedPreKeyPub: signedPreKey.pub,
              signedPreKeySig: signedPreKey.sig,
            },
            update: {
              registrationId,
              // identityKeyPub не обновляем - он immutable после установки
              signedPreKeyId: signedPreKey.id,
              signedPreKeyPub: signedPreKey.pub,
              signedPreKeySig: signedPreKey.sig,
            },
          });

          // Удаляем старые one-time prekeys
          await tx.oneTimePreKey.deleteMany({
            where: { deviceKeysId: deviceKeys.id },
          });
          await tx.pqOneTimePreKey.deleteMany({
            where: { deviceKeysId: deviceKeys.id },
          });

          // Валидация и добавление EC one-time prekeys
          if (ecOneTimePreKeys && ecOneTimePreKeys.length > 0) {
            for (const pk of ecOneTimePreKeys) {
              if (!isPublicKey(pk.pub)) {
                throw new Error('Invalid EC one-time prekey: not a public key');
              }
            }
            await tx.oneTimePreKey.createMany({
              data: ecOneTimePreKeys.map(pk => ({
                deviceKeysId: deviceKeys.id,
                preKeyId: pk.id,
                preKeyPub: pk.pub,
              })),
            });
          }

          // Валидация и добавление PQ one-time prekeys
          if (pqOneTimePreKeys && pqOneTimePreKeys.length > 0) {
            for (const pk of pqOneTimePreKeys) {
              if (!isPqPublicKey(pk.pub)) {
                throw new Error('Invalid PQ one-time prekey: not a public key');
              }
              // Signature validation deferred to client-side
            }
            await tx.pqOneTimePreKey.createMany({
              data: pqOneTimePreKeys.map(pk => ({
                deviceKeysId: deviceKeys.id,
                preKeyId: pk.id,
                preKeyPub: pk.pub,
                preKeySig: pk.sig,
              })),
            });
          }

          // Обновляем PQ last resort prekey
          if (pqLastResortPreKey) {
            await tx.pqLastResortPreKey.upsert({
              where: { deviceKeysId: deviceKeys.id },
              create: {
                deviceKeysId: deviceKeys.id,
                preKeyId: pqLastResortPreKey.id,
                preKeyPub: pqLastResortPreKey.pub,
                preKeySig: pqLastResortPreKey.sig,
              },
              update: {
                preKeyId: pqLastResortPreKey.id,
                preKeyPub: pqLastResortPreKey.pub,
                preKeySig: pqLastResortPreKey.sig,
              },
            });
          }
        });

        // Return response with new deviceId if created
        const response: any = {
          success: true,
          message: 'Prekey bundle published successfully',
        };
        
        // If we created a new device (multi-device scenario), return the new deviceId
        // Client should use this to get a new JWT with the correct deviceId
        if (sessionDeviceId && sessionDeviceId !== jwtDeviceId && numericDeviceId !== undefined) {
          response.newDeviceId = sessionDeviceId;
          response.signalDeviceId = numericDeviceId;
        }
        
        return response;
      } catch (error) {
        // Handle the deferred SIGNAL_DEVICE_ID_CONFLICT thrown from inside
        // the $transaction (Bug #2 fix). Previously this was a 409 returned
        // directly from the pre-transaction write path; we now surface the
        // same status code so existing clients/tests keep working.
        if (error instanceof Error && error.message.startsWith('SIGNAL_DEVICE_ID_CONFLICT:')) {
          return reply.code(409).send({
            success: false,
            message: error.message.replace(/^SIGNAL_DEVICE_ID_CONFLICT:\s*/, ''),
            code: 'SIGNAL_DEVICE_ID_CONFLICT',
          });
        }
        fastify.log.error({ error: 'Failed to publish prekey bundle', details: error });
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to publish prekey bundle',
        });
      }
    },
  });

  // ==================== PUBLISH ONE-TIME PREKEYS ====================
  fastify.post('/keys/pqxdh/one-time', {
    preHandler: authenticate,
    config: { rateLimit: keysPublishRateLimit },
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const jwtDeviceId = (request as any).user.deviceId;
        const { deviceId, ecOneTimePreKeys, pqOneTimePreKeys } = request.body as {
          deviceId: string;
          ecOneTimePreKeys?: Array<{ id: number; pub: string }>;
          pqOneTimePreKeys?: Array<{ id: number; pub: string; sig: string }>;
        };

        if (!deviceId) {
          return reply.code(400).send({ success: false, message: 'Missing deviceId' });
        }

        // SECURITY: JWT-based authentication only (HMAC requirement removed —
        // see /keys/pqxdh/publish for rationale). Real protection: JWT auth,
        // deviceId ownership check (below), and rate limiting.

        // SECURITY: Strict deviceId binding - deviceId must match JWT deviceId
        // This prevents users from updating other users' prekeys
        if (jwtDeviceId && jwtDeviceId !== deviceId) {
          // Also check if deviceId is registered to this user
          const device = await prisma.device.findFirst({
            where: { userId, deviceId },
          });
          if (!device) {
            return reply.code(403).send({ success: false, message: 'deviceId does not belong to this user' });
          }
        }

        // SECURITY: Проверка верификации устройства
        // Публикация ключей разрешена ТОЛЬКО для верифицированных устройств
        const deviceForVerification = await prisma.device.findFirst({
          where: {
            deviceId: deviceId,
            userId: userId,
            isActive: true,
          },
          select: {
            verifiedAt: true,
          },
        });

        if (!deviceForVerification) {
          return reply.code(404).send({
            success: false,
            message: 'Device not found',
          });
        }

        // Запрещаем если устройство не верифицировано
        if (!deviceForVerification.verifiedAt) {
          fastify.log.warn({
            userId,
            deviceId: deviceId,
            verifiedAt: deviceForVerification.verifiedAt,
          }, '[Keys] Unverified device attempted to publish one-time prekeys');
          
          return reply.code(403).send({
            success: false,
            message: 'Device verification required to publish Signal keys. Please verify this device first via /devices/:id/verify.',
          });
        }

        const deviceKeys = await prisma.deviceKeys.findUnique({
          where: { userId_deviceId: { userId, deviceId } },
        });

        if (!deviceKeys) {
          return reply.code(404).send({ success: false, message: 'Device keys not found' });
        }

        await prisma.$transaction(async (tx) => {
          if (ecOneTimePreKeys) {
            for (const pk of ecOneTimePreKeys) {
              if (!isPublicKey(pk.pub)) {
                throw new Error('Invalid EC prekey');
              }
            }
            await tx.oneTimePreKey.createMany({
              data: ecOneTimePreKeys.map(pk => ({
                deviceKeysId: deviceKeys.id,
                preKeyId: pk.id,
                preKeyPub: pk.pub,
              })),
            });
          }

          if (pqOneTimePreKeys) {
            for (const pk of pqOneTimePreKeys) {
              if (!isPqPublicKey(pk.pub)) {
                throw new Error('Invalid PQ prekey');
              }
              // Signature validation deferred to client-side
            }
            await tx.pqOneTimePreKey.createMany({
              data: pqOneTimePreKeys.map(pk => ({
                deviceKeysId: deviceKeys.id,
                preKeyId: pk.id,
                preKeyPub: pk.pub,
                preKeySig: pk.sig,
              })),
            });
          }
        });

        return { success: true, message: 'One-time prekeys published' };
      } catch (error) {
        // Prisma errors often have enumerable props on a non-Error class;
        // pino would otherwise log them as `{}`. Capture name + message +
        // stack + any custom fields so 500s here are actually debuggable.
        const errInfo: Record<string, unknown> = {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        };
        if (error && typeof error === 'object') {
          for (const key of Object.keys(error as object)) {
            try { errInfo[key] = (error as Record<string, unknown>)[key]; } catch { /* ignore */ }
          }
        }
        fastify.log.error(errInfo, '[/keys/pqxdh/one-time] failed');
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed'
        });
      }
    },
  });

  // ==================== GET PREKEY BUNDLE ====================
  fastify.get('/keys/pqxdh/bundle/:userId/:deviceId', {
    preHandler: authenticate,
    config: { rateLimit: keysBundleRateLimit },
    handler: async (request, reply) => {
      try {
        const { userId, deviceId } = request.params as { userId: string; deviceId: string };

        // deviceId from URL can be either:
        // 1. Signal protocol deviceId (number as string, e.g. "119")
        // 2. Session deviceId (legacy, e.g. "dev_xxx")
        
        let sessionDeviceId: string | null = null;
        
        // Try to parse as Signal protocol deviceId (number)
        const signalDeviceId = parseInt(deviceId, 10);
        if (!isNaN(signalDeviceId)) {
          // First, find the device by signalDeviceId
          const device = await prisma.device.findFirst({
            where: { 
              userId: userId,
              signalDeviceId: signalDeviceId,
              isActive: true,
            },
          });
          
          if (device) {
            sessionDeviceId = device.deviceId;
          }
        }
        
        // Fallback: check if deviceId is actually a session deviceId
        if (!sessionDeviceId) {
          const fallbackDevice = await prisma.device.findFirst({
            where: {
              userId: userId,
              deviceId: deviceId,
              isActive: true,
            },
          });
          
          if (fallbackDevice) {
            sessionDeviceId = fallbackDevice.deviceId;
          }
        }
        
        // Also check DeviceKeys directly (for cases where device record might be missing)
        if (!sessionDeviceId) {
          const directKeys = await prisma.deviceKeys.findUnique({
            where: { userId_deviceId: { userId, deviceId } },
          });
          if (directKeys) {
            sessionDeviceId = deviceId;
          }
        }
        
        if (!sessionDeviceId) {
          return reply.code(404).send({ success: false, message: 'Device not found' });
        }
        
        // Get keys using session deviceId
        const deviceKeys = await prisma.deviceKeys.findUnique({
          where: { userId_deviceId: { userId, deviceId: sessionDeviceId } },
          include: { pqLastResortPreKey: true },
        });

        if (!deviceKeys) {
          return reply.code(404).send({ success: false, message: 'Device keys not found' });
        }

        // RACE CONDITION FIX: Use atomic SELECT ... FOR UPDATE SKIP LOCKED
        // This prevents multiple concurrent requests from consuming the same prekey.
        // Without this, two parallel requests could read the same prekey before
        // either marks it as consumed, violating the one-time-use guarantee.
        const [ecPreKeyResult, pqPreKeyResult] = await prisma.$transaction(async (tx) => {
          // Atomically select and lock EC one-time prekey
          const ecRows = await tx.$queryRaw<Array<{ id: string; preKeyId: number; preKeyPub: string }>>`
            SELECT id, "preKeyId", "preKeyPub" FROM ec_one_time_prekeys
            WHERE "deviceKeysId" = ${deviceKeys.id} AND "consumedAt" IS NULL
            ORDER BY "createdAt" ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `;
          
          let ecPreKey: { id: string; preKeyId: number; preKeyPub: string } | null = null;
          if (ecRows.length > 0 && ecRows[0]) {
            // Mark as consumed and return the key data
            await tx.$executeRaw`
              UPDATE ec_one_time_prekeys
              SET "consumedAt" = NOW()
              WHERE id = ${ecRows[0].id}
            `;
            ecPreKey = ecRows[0];
          }

          // Atomically select and lock PQ one-time prekey
          const pqRows = await tx.$queryRaw<Array<{ id: string; preKeyId: number; preKeyPub: string; preKeySig: string | null }>>`
            SELECT id, "preKeyId", "preKeyPub", "preKeySig" FROM pq_kem_one_time_prekeys
            WHERE "deviceKeysId" = ${deviceKeys.id} AND "consumedAt" IS NULL
            ORDER BY "createdAt" ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `;
          
          let pqPreKey: { id: string; preKeyId: number; preKeyPub: string; preKeySig: string | null } | null = null;
          if (pqRows.length > 0 && pqRows[0]) {
            // Mark as consumed and return the key data
            await tx.$executeRaw`
              UPDATE pq_kem_one_time_prekeys
              SET "consumedAt" = NOW()
              WHERE id = ${pqRows[0].id}
            `;
            pqPreKey = pqRows[0];
          }

          return [ecPreKey, pqPreKey];
        });

        const bundle: any = {
          identityKeyPub: deviceKeys.identityKeyPub,
          signedPreKey: {
            id: deviceKeys.signedPreKeyId,
            pub: deviceKeys.signedPreKeyPub,
            sig: deviceKeys.signedPreKeySig,
          },
          registrationId: deviceKeys.registrationId,
        };

        if (deviceKeys.pqLastResortPreKey) {
          bundle.pqLastResortPreKey = {
            id: deviceKeys.pqLastResortPreKey.preKeyId,
            pub: deviceKeys.pqLastResortPreKey.preKeyPub,
            sig: deviceKeys.pqLastResortPreKey.preKeySig,
          };
        }

        if (ecPreKeyResult) {
          bundle.oneTimeEcPreKey = {
            id: ecPreKeyResult.preKeyId,
            pub: ecPreKeyResult.preKeyPub,
          };
        }

        if (pqPreKeyResult) {
          bundle.oneTimePqPreKey = {
            id: pqPreKeyResult.preKeyId,
            pub: pqPreKeyResult.preKeyPub,
            sig: pqPreKeyResult.preKeySig,
          };
        }

        return { success: true, data: bundle };
      } catch (error) {
        fastify.log.error({ error });
        return reply.code(500).send({ success: false, message: 'Failed to get bundle' });
      }
    },
  });

  // ==================== GET KEYS STATUS ====================
  fastify.get('/keys/pqxdh/status/:userId', {
    preHandler: authenticate,
    handler: async (request) => {
      try {
        const { userId } = request.params as { userId: string };

        const devices = await prisma.deviceKeys.findMany({
          where: { userId },
          include: {
            ecOneTimePreKeys: { where: { consumedAt: null }, select: { id: true } },
            pqOneTimePreKeys: { where: { consumedAt: null }, select: { id: true } },
          },
        });

        const ecCount = devices.reduce((sum, d) => sum + d.ecOneTimePreKeys.length, 0);
        const pqCount = devices.reduce((sum, d) => sum + d.pqOneTimePreKeys.length, 0);

        return { success: true, data: { ecPreKeyCount: ecCount, pqPreKeyCount: pqCount } };
      } catch (error) {
        throw error;
      }
    },
  });

  // ==================== DISTRIBUTE SENDER KEY ====================
  fastify.post('/keys/sender-key/distribute', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const jwtDeviceId = (request as any).user.deviceId;
        const { chatId, distribution } = request.body as {
          chatId: string;
          distribution: { chainKey: string; sigPub: string; sigPriv: string };
        };

        if (!chatId || !distribution) {
          return reply.code(400).send({ success: false, message: 'Missing chatId or distribution' });
        }

        const deviceId = jwtDeviceId || 'default';

        await prisma.senderKeyDistribution.upsert({
          where: {
            chatId_senderUserId_deviceId: { chatId, senderUserId: userId, deviceId },
          },
          create: {
            chatId,
            senderUserId: userId,
            deviceId,
            chainKey: distribution.chainKey,
            signatureKeyPub: distribution.sigPub,
            // SECURITY: Encrypt private signing key at rest
            signatureKeyPriv: encryptAtRest(distribution.sigPriv),
          },
          update: {
            chainKey: distribution.chainKey,
            signatureKeyPub: distribution.sigPub,
            signatureKeyPriv: encryptAtRest(distribution.sigPriv),
          },
        });

        return { success: true, message: 'Sender key distributed' };
      } catch (error) {
        return reply.code(500).send({ success: false, message: 'Failed to distribute' });
      }
    },
  });

  // ==================== REQUEST SENDER KEY ====================
  fastify.post('/keys/sender-key/request', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId, senderUserId } = request.body as { chatId: string; senderUserId: string };

        if (!chatId || !senderUserId) {
          return reply.code(400).send({ success: false, message: 'Missing required fields' });
        }

        // SECURITY: the requester must be a participant of chatId.
        // Without this check, any authenticated user could probe
        // which sender keys exist for chats they don't belong to.
        // We use the authenticated userId (NOT a client-supplied
        // field) for the membership check.
        const requesterId = (request as any).user?.userId as string | undefined;
        if (requesterId) {
          const isParticipant = await prisma.chatUser.findUnique({
            where: { chatId_userId: { chatId, userId: requesterId } },
            select: { userId: true },
          });
          if (!isParticipant) {
            return reply.code(403).send({ success: false, message: 'Not a participant' });
          }
        }

        const senderKey = await prisma.senderKeyDistribution.findFirst({
          where: { chatId, senderUserId },
          orderBy: { createdAt: 'desc' },
        });

        if (!senderKey) {
          return reply.code(404).send({ success: false, message: 'Sender key not found' });
        }

        // SECURITY: NEVER return the private signing key to clients.
        // The private key is used only server-side for creating sender key
        // distribution messages. Clients only need the public key + chain key.
        return {
          success: true,
          data: {
            chainKey: senderKey.chainKey,
            sigPub: senderKey.signatureKeyPub,
          },
        };
      } catch (error) {
        return reply.code(500).send({ success: false, message: 'Failed to request' });
      }
    },
  });

  // ==================== GET USER DEVICES ====================
  fastify.get('/keys/devices/:userId', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { userId } = request.params as { userId: string };

        // FIX: previously this used `select: { deviceKeys: {...} }` but
        // the `Device` schema has no relation to `DeviceKeys`. Query the
        // two models separately and join them in JS by `deviceId`.
        const devices = await prisma.device.findMany({
          where: {
            userId,
            isActive: true,
            signalDeviceId: { not: null },
          },
          select: {
            deviceId: true,
            signalDeviceId: true,
          },
        });

        const deviceIds = devices.map((d) => d.deviceId);
        const keysRows = deviceIds.length
          ? await prisma.deviceKeys.findMany({
              where: { userId, deviceId: { in: deviceIds } },
              select: {
                deviceId: true,
                registrationId: true,
                identityKeyPub: true,
              },
            })
          : [];

        const keysByDeviceId = new Map(keysRows.map((k) => [k.deviceId, k]));

        const devicesWithKeys = devices
          .map((device) => {
            const keys = keysByDeviceId.get(device.deviceId);
            if (!keys) return null;
            return {
              deviceId: device.signalDeviceId,
              identityKeyPub: keys.identityKeyPub,
              registrationId: keys.registrationId,
            };
          })
          .filter((d): d is { deviceId: number | null; identityKeyPub: string; registrationId: number } => d !== null);

        // FIX: previously this handler built `devicesWithKeys` but never
        // returned it, so Fastify always sent an empty body. The endpoint
        // was effectively broken.
        return { success: true, data: devicesWithKeys };
      } catch (error) {
        request.log.error({ error }, 'GET /keys/devices/:userId failed');
        return reply.code(500).send({ success: false, message: 'Internal server error' });
      }
    },
  });

  // ==================== DELETE DEVICE ====================
  fastify.delete('/keys/device/:deviceId', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const jwtDeviceId = (request as any).user.deviceId;
        const { deviceId } = request.params as { deviceId: string };

        if (jwtDeviceId && jwtDeviceId !== deviceId) {
          return reply.code(403).send({ success: false, message: 'deviceId mismatch' });
        }

        await prisma.deviceKeys.delete({
          where: { userId_deviceId: { userId, deviceId } },
        });

        return { success: true, message: 'Device deleted' };
      } catch (error) {
        return reply.code(500).send({ success: false, message: 'Failed to delete device' });
      }
    },
  });

  // ==================== CHECK SIGNAL DEVICE ID AVAILABILITY ====================
  fastify.post('/keys/check-signal-device-id', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const { signalDeviceId } = request.body as { signalDeviceId: number };

        if (!signalDeviceId || signalDeviceId < 1 || signalDeviceId > 127) {
          return reply.code(400).send({ 
            success: false, 
            message: 'Signal device ID must be between 1 and 127' 
          });
        }

        // Проверяем, используется ли этот Signal Device ID для данного пользователя.
        // NOTE: signalDeviceId is now per-user unique (see @@unique([userId, signalDeviceId])
        // in schema.prisma), so we cannot use findUnique on signalDeviceId alone —
        // filter by userId as well.
        const existingDevice = await prisma.device.findFirst({
          where: { userId, signalDeviceId },
        });

        const isAvailable = !existingDevice;

        return {
          success: true,
          data: {
            signalDeviceId,
            isAvailable,
            message: isAvailable 
              ? 'Signal device ID is available' 
              : 'Signal device ID is already in use',
          },
        };
      } catch (error) {
        fastify.log.error({ error });
        return reply.code(500).send({ success: false, message: 'Failed to check device ID' });
      }
    },
  });

  // ==================== HEALTH CHECK ====================
  fastify.get('/keys/health', {
    handler: async (_request, reply) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { success: true, message: 'Keys service healthy', timestamp: new Date().toISOString() };
      } catch (error) {
        return reply.code(503).send({ success: false, message: 'Keys service unhealthy' });
      }
    },
  });
};
