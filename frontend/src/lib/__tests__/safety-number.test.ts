/**
 * Unit tests for `lib/signal/safety-number.ts` formatting helpers and TOFU
 * state management. Pure functions — no WASM, no network, no IndexedDB.
 *
 * The localStorage-backed trust-state helpers are tested via a fresh
 * in-memory `localStorage` shim because jsdom provides one but persists
 * across tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acceptChangedIdentity,
  forgetKnownIdentity,
  formatSafetyNumberFull,
  formatSafetyNumberShort,
  markContactVerified,
  peekIdentityStatus,
  recordIdentitySighting,
  safetyNumberToQrPayload,
  safetyNumbersMatch,
  unmarkContactVerified,
} from '../signal/safety-number';

const KEY_KNOWN = 'zc:known-identities';
const KEY_VERIFIED = 'zc:verified-contacts';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('formatSafetyNumberFull', () => {
  it('formats a 60-digit string into 12 groups of 5 digits', () => {
    const digits = '0123456789'.repeat(6); // 60 digits
    const formatted = formatSafetyNumberFull(digits);
    expect(formatted).toBe(
      '01234 56789 01234 56789 01234 56789 01234 56789 01234 56789 01234 56789',
    );
    expect(formatted.split(' ')).toHaveLength(12);
    expect(formatted.replace(/\s/g, '')).toHaveLength(60);
  });

  it('strips non-digit characters before formatting', () => {
    const messy = '01-23 45\n67ab89CD';
    const formatted = formatSafetyNumberFull(messy);
    expect(formatted.startsWith('01234 56789')).toBe(true);
  });

  it('pads short input with trailing zeros to reach 60 digits', () => {
    const formatted = formatSafetyNumberFull('123');
    // First group: "12300", then 11 groups of "00000"
    expect(formatted).toBe('12300 ' + '00000 '.repeat(10) + '00000');
    expect(formatted.replace(/\s/g, '')).toHaveLength(60);
  });

  it('truncates input longer than 60 digits', () => {
    const long = '9'.repeat(80);
    const formatted = formatSafetyNumberFull(long);
    expect(formatted.replace(/\s/g, '')).toBe('9'.repeat(60));
  });

  it('handles empty input gracefully', () => {
    const formatted = formatSafetyNumberFull('');
    expect(formatted.replace(/\s/g, '')).toBe('0'.repeat(60));
    expect(formatted.split(' ')).toHaveLength(12);
  });
});

describe('formatSafetyNumberShort', () => {
  it('formats the first 12 digits as 3 dash-separated groups of 4', () => {
    const digits = '12345678901234567890';
    const formatted = formatSafetyNumberShort(digits);
    expect(formatted).toBe('1234-5678-9012');
    expect(formatted.split('-')).toHaveLength(3);
  });

  it('pads short input to 12 digits', () => {
    expect(formatSafetyNumberShort('1')).toBe('1000-0000-0000');
    expect(formatSafetyNumberShort('')).toBe('0000-0000-0000');
  });

  it('truncates input longer than 12 digits', () => {
    expect(formatSafetyNumberShort('12345678901234567890')).toBe('1234-5678-9012');
  });

  it('strips non-digit characters', () => {
    expect(formatSafetyNumberShort('12-34 56ab78')).toBe('1234-5678-0000');
  });
});

describe('safetyNumberToQrPayload', () => {
  it('wraps the digit string in a "safety-number:" URL scheme', () => {
    expect(safetyNumberToQrPayload('123456789012')).toBe('safety-number:123456789012');
  });

  it('strips non-digit characters', () => {
    expect(safetyNumberToQrPayload('12-34 56')).toBe('safety-number:123456');
  });
});

describe('safetyNumbersMatch', () => {
  it('returns true for identical strings', () => {
    expect(safetyNumbersMatch('12345-67890', '12345-67890')).toBe(true);
  });

  it('returns true for strings that differ only in formatting', () => {
    expect(safetyNumbersMatch('12345-67890', '12345 67890')).toBe(true);
    expect(safetyNumbersMatch('12-34', '1234')).toBe(true);
  });

  it('returns false for different digit content', () => {
    expect(safetyNumbersMatch('12345', '12346')).toBe(false);
    expect(safetyNumbersMatch('12345-67890', '12345-67891')).toBe(false);
  });

  it('returns false when lengths differ', () => {
    expect(safetyNumbersMatch('12345', '123456')).toBe(false);
    expect(safetyNumbersMatch('', '1')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(safetyNumbersMatch('', '')).toBe(true);
  });

  it('is constant-time: does not short-circuit on first mismatch', () => {
    // We cannot measure timing reliably in unit tests, but we can at least
    // assert the function returns the correct boolean for a near-match
    // that differs only in the last byte.
    const a = '0'.repeat(60);
    const b = '0'.repeat(59) + '1';
    expect(safetyNumbersMatch(a, b)).toBe(false);
  });
});

// ==================== TOFU state helpers ====================

describe('recordIdentitySighting (TOFU state machine)', () => {
  it('returns "unverified" and records the key on first sighting', () => {
    const status = recordIdentitySighting('user-a', 'KEY-A-V1');
    expect(status).toBe('unverified');

    // Stored under the known-identities key.
    const stored = JSON.parse(localStorage.getItem(KEY_KNOWN) || '{}');
    expect(stored['user-a']).toBe('KEY-A-V1');
  });

  it('returns "unverified" on second sighting with the same key (no verification yet)', () => {
    recordIdentitySighting('user-b', 'KEY-B-V1');
    const status = recordIdentitySighting('user-b', 'KEY-B-V1');
    expect(status).toBe('unverified');
  });

  it('returns "verified" when the key matches and the user has marked verified', () => {
    recordIdentitySighting('user-c', 'KEY-C-V1');
    markContactVerified('user-c');
    const status = recordIdentitySighting('user-c', 'KEY-C-V1');
    expect(status).toBe('verified');
  });

  it('returns "changed" when the stored key differs from the current key', () => {
    recordIdentitySighting('user-d', 'KEY-D-V1');
    const status = recordIdentitySighting('user-d', 'KEY-D-V2');
    expect(status).toBe('changed');
  });

  it('does NOT overwrite the stored key on mismatch (TOFU freeze)', () => {
    recordIdentitySighting('user-e', 'KEY-E-V1');
    recordIdentitySighting('user-e', 'KEY-E-V2');
    const stored = JSON.parse(localStorage.getItem(KEY_KNOWN) || '{}');
    expect(stored['user-e']).toBe('KEY-E-V1');
  });

  it('isolates users — recording one user does not affect another', () => {
    recordIdentitySighting('user-f', 'KEY-F');
    recordIdentitySighting('user-g', 'KEY-G');
    const stored = JSON.parse(localStorage.getItem(KEY_KNOWN) || '{}');
    expect(stored['user-f']).toBe('KEY-F');
    expect(stored['user-g']).toBe('KEY-G');
  });
});

describe('peekIdentityStatus (read-only)', () => {
  it('returns "unverified" for a user that has never been seen (no side effects)', () => {
    const before = localStorage.getItem(KEY_KNOWN);
    expect(peekIdentityStatus('user-h', 'KEY-H')).toBe('unverified');
    const after = localStorage.getItem(KEY_KNOWN);
    // No write should have occurred.
    expect(after).toBe(before);
    expect(after).toBeNull();
  });

  it('returns "verified" if the user was marked verified with the same key', () => {
    recordIdentitySighting('user-i', 'KEY-I');
    markContactVerified('user-i');
    expect(peekIdentityStatus('user-i', 'KEY-I')).toBe('verified');
  });

  it('returns "changed" if the stored key differs', () => {
    recordIdentitySighting('user-j', 'KEY-J-V1');
    expect(peekIdentityStatus('user-j', 'KEY-J-V2')).toBe('changed');
  });
});

describe('markContactVerified / unmarkContactVerified', () => {
  it('persists the verified set across reads', () => {
    markContactVerified('user-k');
    const stored = JSON.parse(localStorage.getItem(KEY_VERIFIED) || '[]');
    expect(stored).toContain('user-k');
  });

  it('unmarkContactVerified removes the user from the verified set', () => {
    markContactVerified('user-l');
    unmarkContactVerified('user-l');
    const stored = JSON.parse(localStorage.getItem(KEY_VERIFIED) || '[]');
    expect(stored).not.toContain('user-l');
  });

  it('markContactVerified is idempotent', () => {
    markContactVerified('user-m');
    markContactVerified('user-m');
    const stored = JSON.parse(localStorage.getItem(KEY_VERIFIED) || '[]');
    expect(stored.filter((u: string) => u === 'user-m')).toHaveLength(1);
  });

  it('unmarkContactVerified is safe for unknown users', () => {
    expect(() => unmarkContactVerified('never-seen')).not.toThrow();
  });
});

describe('acceptChangedIdentity', () => {
  it('overwrites the stored key with the new key and clears the verified flag', () => {
    recordIdentitySighting('user-n', 'KEY-N-V1');
    markContactVerified('user-n');
    expect(peekIdentityStatus('user-n', 'KEY-N-V2')).toBe('changed');

    const status = acceptChangedIdentity('user-n', 'KEY-N-V2');
    expect(status).toBe('unverified');

    // The stored key is now V2, and verified flag is gone.
    expect(peekIdentityStatus('user-n', 'KEY-N-V2')).toBe('unverified');
    expect(peekIdentityStatus('user-n', 'KEY-N-V1')).toBe('changed');
  });

  it('works even when there was no previous key (no-op but does not throw)', () => {
    expect(() => acceptChangedIdentity('user-o', 'KEY-O-V1')).not.toThrow();
    const stored = JSON.parse(localStorage.getItem(KEY_KNOWN) || '{}');
    expect(stored['user-o']).toBe('KEY-O-V1');
  });
});

describe('forgetKnownIdentity', () => {
  it('removes the stored key for a user', () => {
    recordIdentitySighting('user-p', 'KEY-P');
    forgetKnownIdentity('user-p');
    const stored = JSON.parse(localStorage.getItem(KEY_KNOWN) || '{}');
    expect(stored['user-p']).toBeUndefined();
  });

  it('is safe for unknown users', () => {
    expect(() => forgetKnownIdentity('never-seen')).not.toThrow();
  });

  it('does not affect the verified flag', () => {
    recordIdentitySighting('user-q', 'KEY-Q');
    markContactVerified('user-q');
    forgetKnownIdentity('user-q');
    const verified = JSON.parse(localStorage.getItem(KEY_VERIFIED) || '[]');
    expect(verified).toContain('user-q');
  });
});

describe('TOFU state — cross-test isolation', () => {
  // Each test starts with a clean localStorage thanks to beforeEach, but
  // verify that explicitly here so we catch regressions in the setup.
  it('localStorage is empty at the start of this test', () => {
    expect(localStorage.getItem(KEY_KNOWN)).toBeNull();
    expect(localStorage.getItem(KEY_VERIFIED)).toBeNull();
  });
});
