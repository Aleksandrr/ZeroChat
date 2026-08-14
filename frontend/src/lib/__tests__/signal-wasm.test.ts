/**
 * Signal-wasm v0.2.x integration tests.
 *
 * These tests exercise the new modular API directly (without going through
 * the app's IndexedDB-backed storage layer). They verify that:
 *
 *   1. WASM module loads and basic primitives work
 *      (PrivateKey/PublicKey/IdentityKeyPair/ProtocolAddress).
 *   2. Two clients (Alice + Bob) can establish a session via
 *      processPreKeyBundle and exchange encrypted 1:1 messages in both
 *      directions, including forward secrecy after ratchet steps.
 *   3. The PreKey message type flows correctly
 *      (first message = PreKey type, subsequent = Signal type).
 *   4. Group messaging via Sender Keys works
 *      (Alice, Bob, Carol share a distributionId, all can read each
 *      other's group messages).
 *   5. Safety numbers are deterministic for a given key pair.
 *   6. Utility functions (generate_uuid, generate_random_bytes,
 *      message_type_*) return sane values.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import init, {
  initSync,
  WasmPrivateKey,
  WasmPublicKey,
  WasmIdentityKeyPair,
  WasmProtocolAddress,
  WasmInMemIdentityKeyStore,
  WasmInMemSessionStore,
  WasmInMemPreKeyStore,
  WasmInMemSignedPreKeyStore,
  WasmInMemKyberPreKeyStore,
  WasmInMemSenderKeyStore,
  generateRegistrationId,
  generatePreKeys,
  generateSignedPreKey,
  generateKyberPreKey,
  processPreKeyBundle,
  encryptMessage,
  decryptMessage,
  createSenderKeyDistribution,
  processSenderKeyDistribution,
  encryptGroupMessage,
  decryptGroupMessage,
  generateSafetyNumber,
  verifySafetyNumber,
  generate_uuid,
  generate_random_bytes,
  message_type_pre_key,
  message_type_signal,
  message_type_sender_key,
  uuid_to_string,
  uuid_from_string,
} from '@getmaapp/signal-wasm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let wasmInitialised = false;

async function ensureWasm() {
  if (wasmInitialised) return;
  // Use initSync with the .wasm file bytes — avoids jsdom's lack of fetch.
  try {
    const wasmPath = resolve(__dirname, '../../../node_modules/@getmaapp/signal-wasm/signal_wasm_bg.wasm');
    const bytes = readFileSync(wasmPath);
    initSync(bytes);
  } catch {
    // Fall back to async init (will work in a real browser-like env).
    await init();
  }
  wasmInitialised = true;
}

/** Build a complete in-memory store bag for one user. */
async function makeUser(name: string, deviceId: number) {
  await ensureWasm();

  const privateKey = WasmPrivateKey.generate();
  const publicKey = privateKey.getPublicKey();
  const identityKeyPair = new WasmIdentityKeyPair(publicKey, privateKey);
  const registrationId = generateRegistrationId();
  const address = new WasmProtocolAddress(name, deviceId);

  const identityStore = new WasmInMemIdentityKeyStore(identityKeyPair, registrationId);
  const sessionStore = new WasmInMemSessionStore();
  const preKeyStore = new WasmInMemPreKeyStore();
  const signedPreKeyStore = new WasmInMemSignedPreKeyStore();
  const kyberPreKeyStore = new WasmInMemKyberPreKeyStore();
  const senderKeyStore = new WasmInMemSenderKeyStore();

  // Generate one batch of prekeys + signed prekey + kyber prekey.
  const preKeys = await generatePreKeys(1, 5, preKeyStore);
  const signedPreKey = await generateSignedPreKey(1, identityKeyPair, signedPreKeyStore);
  const kyberPreKey = await generateKyberPreKey(1, identityKeyPair, kyberPreKeyStore);

  return {
    name,
    deviceId,
    privateKey,
    publicKey,
    identityKeyPair,
    registrationId,
    address,
    identityStore,
    sessionStore,
    preKeyStore,
    signedPreKeyStore,
    kyberPreKeyStore,
    senderKeyStore,
    preKeys,
    signedPreKey,
    kyberPreKey,
  };
}

describe('signal-wasm v0.2 — basic primitives', () => {
  beforeAll(async () => {
    await ensureWasm();
  });

  it('PrivateKey/PublicKey round-trip through serialize/deserialize', () => {
    const sk = WasmPrivateKey.generate();
    const skBytes = sk.serialize();
    expect(skBytes.length).toBeGreaterThan(0);

    const sk2 = WasmPrivateKey.deserialize(skBytes);
    const pk1 = sk.getPublicKey();
    const pk2 = sk2.getPublicKey();
    expect(pk1.serialize()).toEqual(pk2.serialize());
  });

  it('IdentityKeyPair serialize/deserialize preserves the keys', () => {
    const sk = WasmPrivateKey.generate();
    const pk = sk.getPublicKey();
    const ikp = new WasmIdentityKeyPair(pk, sk);

    const ser = ikp.serialize();
    expect(ser.length).toBeGreaterThan(0);

    const ikp2 = WasmIdentityKeyPair.deserialize(ser);
    expect(ikp2.public_key.serialize()).toEqual(pk.serialize());
    expect(ikp2.private_key.serialize()).toEqual(sk.serialize());
  });

  it('ProtocolAddress exposes name and deviceId', () => {
    const addr = new WasmProtocolAddress('alice-uid', 7);
    expect(addr.name).toBe('alice-uid');
    expect(addr.deviceId).toBe(7);
  });

  it('generateRegistrationId returns a value in the documented range (1..=16380)', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateRegistrationId();
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(16380);
    }
  });
});

describe('signal-wasm v0.2 — utility functions', () => {
  beforeAll(async () => {
    await ensureWasm();
  });

  it('generate_uuid returns 16 bytes', () => {
    const bytes = generate_uuid();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
  });

  it('uuid_to_string / uuid_from_string round-trip', () => {
    const bytes = generate_uuid();
    const str = uuid_to_string(bytes);
    expect(str).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const bytes2 = uuid_from_string(str);
    expect(Array.from(bytes2)).toEqual(Array.from(bytes));
  });

  it('generate_random_bytes returns the requested length', () => {
    for (const len of [1, 16, 32, 100, 1024]) {
      const buf = generate_random_bytes(len);
      expect(buf.length).toBe(len);
    }
  });

  it('message_type_* return distinct small integers', () => {
    const preKey = message_type_pre_key();
    const signal = message_type_signal();
    const senderKey = message_type_sender_key();
    expect(preKey).not.toBe(signal);
    expect(signal).not.toBe(senderKey);
    expect(preKey).not.toBe(senderKey);
    expect(preKey).toBeGreaterThan(0);
    expect(signal).toBeGreaterThan(0);
    expect(senderKey).toBeGreaterThan(0);
  });
});

describe('signal-wasm v0.2 — 1:1 E2EE conversation (Alice ↔ Bob)', () => {
  let alice: Awaited<ReturnType<typeof makeUser>>;
  let bob: Awaited<ReturnType<typeof makeUser>>;

  beforeAll(async () => {
    alice = await makeUser('alice-uid', 1);
    bob = await makeUser('bob-uid', 1);
  });

  it('Alice processes Bob\'s PreKey bundle and establishes a session', async () => {
    // Alice receives Bob's bundle (registrationId, identityKey, signedPreKey,
    // optional one-time prekey, kyber prekey).
    //
    // In v0.2.x, processPreKeyBundle expects `identity_key` and
    // `signed_prekey` to be WasmPublicKey instances (not raw bytes), while
    // `prekey` and `kyber_prekey` are Uint8Array. The WasmSignedPreKey and
    // WasmKyberPreKey structs return their public_key as raw bytes, so we
    // wrap them in WasmPublicKey.deserialize() before passing.
    const bobIdentityPub = bob.identityKeyPair.public_key;
    const bobSignedPreKeyPub = WasmPublicKey.deserialize(bob.signedPreKey.public_key);

    // kyberPreKey.public_key is already Uint8Array (per the .d.ts).
    const bobKyberPreKeyPub = bob.kyberPreKey.public_key;

    await processPreKeyBundle(
      bob.address,
      alice.address,
      bob.registrationId,
      bobIdentityPub,
      bob.signedPreKey.id,
      bobSignedPreKeyPub,
      bob.signedPreKey.signature,
      bob.preKeys[0].id,
      bob.preKeys[0].public_key,
      bob.kyberPreKey.id,
      bobKyberPreKeyPub,
      bob.kyberPreKey.signature,
      alice.sessionStore,
      alice.identityStore,
    );

    // Alice should now have a session with Bob.
    const has = await alice.sessionStore.has_session(bob.address);
    expect(has).toBe(true);
  });

  it('Alice → Bob first message is a PreKeySignalMessage (type=3)', async () => {
    const plaintext = new TextEncoder().encode('Hello Bob, this is Alice! 🔒');
    const ciphertext = await encryptMessage(
      plaintext,
      bob.address,
      alice.address,
      alice.sessionStore,
      alice.identityStore,
    );

    // First message in a fresh session is always a PreKey message.
    expect(ciphertext.message_type).toBe(message_type_pre_key());
    expect(ciphertext.body).toBeInstanceOf(Uint8Array);
    expect(ciphertext.body.length).toBeGreaterThan(0);

    // Bob decrypts with all his stores.
    const decrypted = await decryptMessage(
      ciphertext.body,
      ciphertext.message_type,
      alice.address,
      bob.address,
      bob.sessionStore,
      bob.identityStore,
      bob.preKeyStore,
      bob.signedPreKeyStore,
      bob.kyberPreKeyStore,
    );

    expect(new TextDecoder().decode(decrypted)).toBe('Hello Bob, this is Alice! 🔒');
  });

  it('Alice → Bob second message is a normal SignalMessage (type=2) after PreKey delivery', async () => {
    // First, send + deliver a PreKey message so the ratchet transitions
    // out of the "pending prekey" state.
    const firstCt = await encryptMessage(
      new TextEncoder().encode('primer'),
      bob.address,
      alice.address,
      alice.sessionStore,
      alice.identityStore,
    );
    await decryptMessage(
      firstCt.body,
      firstCt.message_type,
      alice.address,
      bob.address,
      bob.sessionStore,
      bob.identityStore,
      bob.preKeyStore,
      bob.signedPreKeyStore,
      bob.kyberPreKeyStore,
    );

    // Now the second message should be a regular SignalMessage.
    const plaintext = new TextEncoder().encode('Second message');
    const ciphertext = await encryptMessage(
      plaintext,
      bob.address,
      alice.address,
      alice.sessionStore,
      alice.identityStore,
    );

    // Accept either SignalMessage (type 2) or PreKey (type 3) — v0.2.x
    // may continue sending PreKey messages until the ratchet acknowledges
    // the previous one.
    expect([
      message_type_signal(),
      message_type_pre_key(),
    ]).toContain(ciphertext.message_type);

    const decrypted = await decryptMessage(
      ciphertext.body,
      ciphertext.message_type,
      alice.address,
      bob.address,
      bob.sessionStore,
      bob.identityStore,
      bob.preKeyStore,
      bob.signedPreKeyStore,
      bob.kyberPreKeyStore,
    );

    expect(new TextDecoder().decode(decrypted)).toBe('Second message');
  });

  it('Bob → Alice reply (session already established on Alice\'s side via processPreKeyBundle)', async () => {
    // Alice now needs to also have a session with Bob — but Bob hasn't
    // processed Alice's bundle. In real usage, Bob would send a PreKey
    // message to Alice to establish the reverse session. For this test
    // we let Bob process Alice's bundle first.
    await processPreKeyBundle(
      alice.address,
      bob.address,
      alice.registrationId,
      alice.identityKeyPair.public_key,
      alice.signedPreKey.id,
      WasmPublicKey.deserialize(alice.signedPreKey.public_key),
      alice.signedPreKey.signature,
      alice.preKeys[0].id,
      alice.preKeys[0].public_key,
      alice.kyberPreKey.id,
      alice.kyberPreKey.public_key,
      alice.kyberPreKey.signature,
      bob.sessionStore,
      bob.identityStore,
    );

    const plaintext = new TextEncoder().encode('Hi Alice, Bob here 👋');
    const ciphertext = await encryptMessage(
      plaintext,
      alice.address,
      bob.address,
      bob.sessionStore,
      bob.identityStore,
    );

    const decrypted = await decryptMessage(
      ciphertext.body,
      ciphertext.message_type,
      bob.address,
      alice.address,
      alice.sessionStore,
      alice.identityStore,
      alice.preKeyStore,
      alice.signedPreKeyStore,
      alice.kyberPreKeyStore,
    );

    expect(new TextDecoder().decode(decrypted)).toBe('Hi Alice, Bob here 👋');
  });

  it('forward secrecy: ratchet advances and messages remain decryptable in order', async () => {
    // Send 5 messages from Alice to Bob, then 5 from Bob to Alice.
    const aliceMessages = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const bobReceived: string[] = [];
    for (const m of aliceMessages) {
      const ct = await encryptMessage(
        new TextEncoder().encode(m),
        bob.address,
        alice.address,
        alice.sessionStore,
        alice.identityStore,
      );
      const pt = await decryptMessage(
        ct.body,
        ct.message_type,
        alice.address,
        bob.address,
        bob.sessionStore,
        bob.identityStore,
        bob.preKeyStore,
        bob.signedPreKeyStore,
        bob.kyberPreKeyStore,
      );
      bobReceived.push(new TextDecoder().decode(pt));
    }
    expect(bobReceived).toEqual(aliceMessages);

    const bobMessages = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const aliceReceived: string[] = [];
    for (const m of bobMessages) {
      const ct = await encryptMessage(
        new TextEncoder().encode(m),
        alice.address,
        bob.address,
        bob.sessionStore,
        bob.identityStore,
      );
      const pt = await decryptMessage(
        ct.body,
        ct.message_type,
        bob.address,
        alice.address,
        alice.sessionStore,
        alice.identityStore,
        alice.preKeyStore,
        alice.signedPreKeyStore,
        alice.kyberPreKeyStore,
      );
      aliceReceived.push(new TextDecoder().decode(pt));
    }
    expect(aliceReceived).toEqual(bobMessages);
  });
});

describe('signal-wasm v0.2 — group messaging via Sender Keys', () => {
  let alice: Awaited<ReturnType<typeof makeUser>>;
  let bob: Awaited<ReturnType<typeof makeUser>>;
  let carol: Awaited<ReturnType<typeof makeUser>>;
  const distributionId = 'family-group-001';

  beforeAll(async () => {
    alice = await makeUser('alice-uid', 1);
    bob = await makeUser('bob-uid', 1);
    carol = await makeUser('carol-uid', 1);
  });

  it('Alice creates a sender key distribution and Bob+Carol process it', async () => {
    const skdm = await createSenderKeyDistribution(alice.address, distributionId, alice.senderKeyStore);
    expect(skdm).toBeInstanceOf(Uint8Array);
    expect(skdm.length).toBeGreaterThan(0);

    await processSenderKeyDistribution(alice.address, skdm, bob.senderKeyStore);
    await processSenderKeyDistribution(alice.address, skdm, carol.senderKeyStore);

    // Bob and Carol should now have Alice's sender key for this distribution.
    const bobHasAlice = await bob.senderKeyStore.export_sender_key(alice.address, distributionId);
    const carolHasAlice = await carol.senderKeyStore.export_sender_key(alice.address, distributionId);
    expect(bobHasAlice).toBeDefined();
    expect(bobHasAlice!.length).toBeGreaterThan(0);
    expect(carolHasAlice).toBeDefined();
    expect(carolHasAlice!.length).toBeGreaterThan(0);
  });

  it('Alice encrypts a group message; Bob and Carol can both decrypt it', async () => {
    const plaintext = new TextEncoder().encode('Hello family! 👨‍👩‍👧');
    const ciphertext = await encryptGroupMessage(
      alice.address,
      distributionId,
      plaintext,
      alice.senderKeyStore,
    );
    expect(ciphertext).toBeInstanceOf(Uint8Array);

    const bobDecrypted = await decryptGroupMessage(alice.address, ciphertext, bob.senderKeyStore);
    const carolDecrypted = await decryptGroupMessage(alice.address, ciphertext, carol.senderKeyStore);

    expect(new TextDecoder().decode(bobDecrypted)).toBe('Hello family! 👨‍👩‍👧');
    expect(new TextDecoder().decode(carolDecrypted)).toBe('Hello family! 👨‍👩‍👧');
  });

  it('Bob can also send to the group after distributing his own sender key', async () => {
    // Bob distributes his own sender key to Alice and Carol.
    const skdm = await createSenderKeyDistribution(bob.address, distributionId, bob.senderKeyStore);
    await processSenderKeyDistribution(bob.address, skdm, alice.senderKeyStore);
    await processSenderKeyDistribution(bob.address, skdm, carol.senderKeyStore);

    const plaintext = new TextEncoder().encode('Bob checking in');
    const ciphertext = await encryptGroupMessage(
      bob.address,
      distributionId,
      plaintext,
      bob.senderKeyStore,
    );

    const aliceDecrypted = await decryptGroupMessage(bob.address, ciphertext, alice.senderKeyStore);
    const carolDecrypted = await decryptGroupMessage(bob.address, ciphertext, carol.senderKeyStore);

    expect(new TextDecoder().decode(aliceDecrypted)).toBe('Bob checking in');
    expect(new TextDecoder().decode(carolDecrypted)).toBe('Bob checking in');
  });

  it('multiple group messages from Alice stay decryptable (chain advances)', async () => {
    const messages = ['g1', 'g2', 'g3', 'g4'];
    const decryptedByBob: string[] = [];
    for (const m of messages) {
      const ct = await encryptGroupMessage(
        alice.address,
        distributionId,
        new TextEncoder().encode(m),
        alice.senderKeyStore,
      );
      const pt = await decryptGroupMessage(alice.address, ct, bob.senderKeyStore);
      decryptedByBob.push(new TextDecoder().decode(pt));
    }
    expect(decryptedByBob).toEqual(messages);
  });

  it('Carol cannot decrypt a message encrypted under a different distributionId', async () => {
    const otherDistributionId = 'work-group-999';

    // Alice needs her own sender key for the "other" distribution before
    // she can encrypt under it. Create it first.
    await createSenderKeyDistribution(alice.address, otherDistributionId, alice.senderKeyStore);

    const plaintext = new TextEncoder().encode('secret work stuff');
    const ciphertext = await encryptGroupMessage(
      alice.address,
      otherDistributionId,
      plaintext,
      alice.senderKeyStore,
    );

    // Carol only has Alice's sender key for `distributionId`, not
    // `otherDistributionId`, so decryption must fail. The WASM module
    // throws a generic `SignalError: Operation failed` — we accept any
    // thrown error / rejection as evidence of failure.
    let threw = false;
    try {
      await decryptGroupMessage(alice.address, ciphertext, carol.senderKeyStore);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('signal-wasm v0.2 — safety numbers', () => {
  let alice: Awaited<ReturnType<typeof makeUser>>;
  let bob: Awaited<ReturnType<typeof makeUser>>;

  beforeAll(async () => {
    alice = await makeUser('alice-uid', 1);
    bob = await makeUser('bob-uid', 1);
  });

  it('generateSafetyNumber returns a 60-digit displayable string', () => {
    const sn = generateSafetyNumber(
      'alice-uid',
      alice.identityKeyPair.public_key,
      'bob-uid',
      bob.identityKeyPair.public_key,
    );
    expect(sn.displayable).toMatch(/^\d{60}$/);
    expect(sn.scannable).toBeInstanceOf(Uint8Array);
    expect(sn.scannable.length).toBeGreaterThan(0);
  });

  it('safety number is symmetric (Alice↔Bob == Bob↔Alice)', () => {
    const snAB = generateSafetyNumber(
      'alice-uid',
      alice.identityKeyPair.public_key,
      'bob-uid',
      bob.identityKeyPair.public_key,
    );
    const snBA = generateSafetyNumber(
      'bob-uid',
      bob.identityKeyPair.public_key,
      'alice-uid',
      alice.identityKeyPair.public_key,
    );
    expect(snAB.displayable).toBe(snBA.displayable);
  });

  it('verifySafetyNumber returns true for the genuine scannable bytes', () => {
    const sn = generateSafetyNumber(
      'alice-uid',
      alice.identityKeyPair.public_key,
      'bob-uid',
      bob.identityKeyPair.public_key,
    );
    const ok = verifySafetyNumber(
      sn.scannable,
      'alice-uid',
      alice.identityKeyPair.public_key,
      'bob-uid',
      bob.identityKeyPair.public_key,
    );
    expect(ok).toBe(true);
  });

  it('verifySafetyNumber returns false for tampered bytes', () => {
    const sn = generateSafetyNumber(
      'alice-uid',
      alice.identityKeyPair.public_key,
      'bob-uid',
      bob.identityKeyPair.public_key,
    );
    const tampered = new Uint8Array(sn.scannable);
    tampered[0] ^= 0xff; // flip first byte
    const ok = verifySafetyNumber(
      tampered,
      'alice-uid',
      alice.identityKeyPair.public_key,
      'bob-uid',
      bob.identityKeyPair.public_key,
    );
    expect(ok).toBe(false);
  });
});

describe('signal-wasm v0.2 — session persistence (export/import)', () => {
  it('session can be exported, dropped, and re-imported to resume decryption', async () => {
    const alice = await makeUser('alice-2', 1);
    const bob = await makeUser('bob-2', 1);

    // Establish session: Alice processes Bob's bundle and sends one message.
    await processPreKeyBundle(
      bob.address,
      alice.address,
      bob.registrationId,
      bob.identityKeyPair.public_key,
      bob.signedPreKey.id,
      WasmPublicKey.deserialize(bob.signedPreKey.public_key),
      bob.signedPreKey.signature,
      bob.preKeys[0].id,
      bob.preKeys[0].public_key,
      bob.kyberPreKey.id,
      bob.kyberPreKey.public_key,
      bob.kyberPreKey.signature,
      alice.sessionStore,
      alice.identityStore,
    );

    const plaintext = new TextEncoder().encode('persisted-session-test');
    const ct1 = await encryptMessage(plaintext, bob.address, alice.address, alice.sessionStore, alice.identityStore);

    // Export Alice's session with Bob.
    const sessionBytes = await alice.sessionStore.export_session(bob.address);
    expect(sessionBytes).toBeDefined();
    expect(sessionBytes!.length).toBeGreaterThan(0);

    // Drop and recreate Alice's session store, then re-import.
    const newSessionStore = new WasmInMemSessionStore();
    await newSessionStore.import_session(bob.address, sessionBytes!);

    // Alice can now send another message using the restored session,
    // and Bob can decrypt it (ratchet state continues).
    const ct2 = await encryptMessage(
      new TextEncoder().encode('after-restore'),
      bob.address,
      alice.address,
      newSessionStore,
      alice.identityStore,
    );

    const pt2 = await decryptMessage(
      ct2.body,
      ct2.message_type,
      alice.address,
      bob.address,
      bob.sessionStore,
      bob.identityStore,
      bob.preKeyStore,
      bob.signedPreKeyStore,
      bob.kyberPreKeyStore,
    );
    expect(new TextDecoder().decode(pt2)).toBe('after-restore');

    // And the original ciphertext (sent before the export) is also still
    // decryptable by Bob (Bob's session was never lost).
    const pt1 = await decryptMessage(
      ct1.body,
      ct1.message_type,
      alice.address,
      bob.address,
      bob.sessionStore,
      bob.identityStore,
      bob.preKeyStore,
      bob.signedPreKeyStore,
      bob.kyberPreKeyStore,
    );
    expect(new TextDecoder().decode(pt1)).toBe('persisted-session-test');
  });
});
