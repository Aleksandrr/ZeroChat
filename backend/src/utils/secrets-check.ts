/**
 * Production secrets fail-fast check.
 *
 * Imported from `server.ts` on process start. In `NODE_ENV=production`
 * we verify that every critical secret is set and meets the minimum
 * strength bar. A missing or weak secret calls `process.exit(1)`.
 *
 * In development / test the check is a no-op so local servers keep
 * booting with the documented fallbacks (which are still loud — the
 * fallback strings contain `change-in-production`).
 *
 * NOTE: even without this check, each consuming module (`jwt.ts`,
 * `crypto-utils.ts`, `crypto-at-rest.ts`) also throws on import in
 * production when its env var is missing. This file is the
 * centralised, discoverable place where all required secrets are
 * listed and validated against the same strength policy.
 */

const REQUIRED_SECRETS: readonly string[] = [
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'HMAC_SECRET',
  'COOKIE_SECRET',
  'ENCRYPTION_SALT',
] as const;

const MIN_LENGTH = 32; // chars

/**
 * Verify all production secrets. Exits the process on failure.
 *
 * Safe to call in any environment — only runs checks when
 * `NODE_ENV === 'production'`.
 */
export function checkProductionSecrets(): void {
  if (process.env['NODE_ENV'] !== 'production') {
    return;
  }

  for (const key of REQUIRED_SECRETS) {
    const val = process.env[key];
    if (!val) {
      console.error(`FATAL: ${key} must be set in production`);
      process.exit(1);
    }
    if (key === 'ENCRYPTION_SALT') {
      // 32 hex chars = 16 bytes of salt for scrypt.
      if (!/^[0-9a-fA-F]{32}$/.test(val)) {
        console.error('FATAL: ENCRYPTION_SALT must be 32 hex chars (16 bytes)');
        process.exit(1);
      }
    } else {
      if (val.length < MIN_LENGTH) {
        console.error(`FATAL: ${key} must be at least ${MIN_LENGTH} chars in production`);
        process.exit(1);
      }
    }
  }
}
