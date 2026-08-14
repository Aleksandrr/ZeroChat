import argon2 from 'argon2';
import { randomInt } from 'node:crypto';

/**
 * Argon2id parameters per OWASP 2023 recommendations:
 *   - memoryCost: 65536 KiB (64 MB)
 *   - timeCost: 3 iterations
 *   - parallelism: 4 lanes
 *
 * These parameters provide strong resistance against GPU/ASIC attacks
 * while keeping verification latency under ~50ms on commodity hardware.
 * https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id
 *
 * Argon2id is used in ALL environments (dev + production) for
 * consistency — the same hash format is stored whether the user
 * registers on a dev or prod instance, and `verifyPassword` works
 * regardless of where the hash was created.
 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(password: string): Promise<string> {
  try {
    return await argon2.hash(password, HASH_OPTIONS);
  } catch (error) {
    throw new Error('Failed to hash password');
  }
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (error) {
    throw new Error('Failed to verify password');
  }
}

/**
 * Hash an arbitrary secret (refresh token, session id, etc.) using argon2id
 * with the same parameters as passwords. Used by `utils/jwt.ts` for
 * refresh-token hashing at rest.
 */
export async function hashSecret(secret: string): Promise<string> {
  return hashPassword(secret);
}

export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  return verifyPassword(secret, hash);
}

export function isPasswordStrong(password: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  if (password.length > 128) {
    errors.push('Password must be less than 128 characters long');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Generate a cryptographically-secure random password.
 *
 * FIX: previously used `Math.random()` which is NOT CSPRNG. Switched to
 * `node:crypto.randomInt` which uses OpenSSL's RNG.
 */
export function generateSecureRandomPassword(length: number = 12): string {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  let password = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = randomInt(0, charset.length);
    password += charset[randomIndex];
  }
  return password;
}
