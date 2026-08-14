/**
 * Bypass device verification for dev/e2e testing.
 * Marks the given device as verified directly in the database.
 *
 * Usage: node scripts/bypass-verification.js <deviceId>
 */
import { PGlite } from '@electric-sql/pglite';

const deviceId = process.argv[2];
if (!deviceId) {
  console.error('Usage: node bypass-verification.js <deviceId>');
  process.exit(1);
}

const pg = await PGlite.create({ dataDir: '/tmp/zerochat-pglite-data' });

const result = await pg.query(
  `UPDATE devices SET "verifiedAt" = NOW() WHERE "deviceId" = $1 RETURNING id, "deviceId", "verifiedAt"`,
  [deviceId],
);

if (result.rows.length === 0) {
  console.error(`Device not found: ${deviceId}`);
  process.exit(1);
}

console.log('Device verified:', result.rows[0]);
await pg.close();
