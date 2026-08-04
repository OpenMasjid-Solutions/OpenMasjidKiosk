// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashSecret, verifySecret, makeToken, verifyToken, hashPin, verifyPin, makePairingCode, makeDeviceToken } from './auth';

test('scrypt hash verifies the right secret and rejects the wrong one', () => {
  const cred = hashSecret('correct horse battery staple');
  assert.equal(verifySecret('correct horse battery staple', cred), true);
  assert.equal(verifySecret('wrong password', cred), false);
  // Salt is random → two hashes of the same secret differ.
  const cred2 = hashSecret('correct horse battery staple');
  assert.notEqual(cred.hash, cred2.hash);
});

test('a hash created with a legacy cost (no n) still verifies at the default N', () => {
  // Simulate an older credential without a stored cost by recomputing at N=16384.
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync('pin1234', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const legacy = { hash: dk.toString('hex'), salt: salt.toString('hex') }; // no `n`
  assert.equal(verifySecret('pin1234', legacy), true);
  assert.equal(verifySecret('nope', legacy), false);
});

test('session token round-trips and enforces signature, expiry and audience', () => {
  const secret = crypto.randomBytes(32);
  const other = crypto.randomBytes(32);

  const good = makeToken(secret, 60_000);
  assert.equal(verifyToken(secret, good, 'admin'), true);

  // Wrong signing key.
  assert.equal(verifyToken(other, good, 'admin'), false);
  // Tampered payload.
  assert.equal(verifyToken(secret, good.replace(/^./, 'X'), 'admin'), false);
  // Missing / malformed.
  assert.equal(verifyToken(secret, undefined, 'admin'), false);
  assert.equal(verifyToken(secret, 'nodot', 'admin'), false);

  // Expired.
  const expired = makeToken(secret, -1);
  assert.equal(verifyToken(secret, expired, 'admin'), false);
});

test('kiosk PIN hash (portable scrypt$ string) verifies, rejects wrong/garbage', () => {
  const h = hashPin('1379');
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(verifyPin('1379', h), true);
  assert.equal(verifyPin('0000', h), false);
  assert.equal(verifyPin('1379', 'garbage'), false);
});

test('pairing code is 6 digits; device token is 256-bit hex', () => {
  assert.match(makePairingCode(), /^\d{6}$/);
  assert.match(makeDeviceToken(), /^[a-f0-9]{64}$/);
});


// ── Rate limiting (KIOSK-006, KIOSK-009) ─────────────────────────────────────
import { GlobalAttemptBudget, LoginLimiter } from './rateLimit';

test('the per-peer limiter gives a few free attempts, then backs off', () => {
  const l = new LoginLimiter();
  // Backoff starts once fails EXCEEDS the free allowance, so the 6th attempt is the last free one.
  for (let i = 0; i < 6; i++) {
    assert.equal(l.retryAfterMs('10.0.0.1'), 0, `attempt ${i + 1} should be free`);
    l.fail('10.0.0.1');
  }
  assert.ok(l.retryAfterMs('10.0.0.1') > 0, 'the 7th attempt must be throttled');
  assert.equal(l.retryAfterMs('10.0.0.2'), 0, 'a different peer is unaffected');
  l.succeed('10.0.0.1');
  assert.equal(l.retryAfterMs('10.0.0.1'), 0, 'a success clears the counter');
});

test('the per-peer limiter evicts lapsed entries instead of keeping them forever', () => {
  // The old sweep required `fails <= MAX_FREE`, which could only ever match entries that had never
  // been throttled (those always have next === 0) — so precisely the entries taking up room, the
  // throttled ones, were kept for the life of the process.
  const l = new LoginLimiter();
  const internals = l as unknown as { map: Map<string, { fails: number; next: number }> };
  // Seed 6000 THROTTLED entries whose backoff has already lapsed. Under the old condition every
  // one of these was un-evictable.
  const lapsed = Date.now() - 1;
  for (let i = 0; i < 6000; i++) internals.map.set(`peer-${i}`, { fails: 9, next: lapsed });
  assert.equal(internals.map.size, 6000);
  l.fail('trigger'); // any failure runs the sweep
  assert.ok(internals.map.size < 100, `expected the lapsed entries to be swept, still holding ${internals.map.size}`);
});

test('a peer still inside its backoff is NOT swept away', () => {
  // The sweep must not hand an active attacker their free attempts back early.
  const l = new LoginLimiter();
  const internals = l as unknown as { map: Map<string, { fails: number; next: number }> };
  for (let i = 0; i < 6000; i++) internals.map.set(`old-${i}`, { fails: 9, next: Date.now() - 1 });
  internals.map.set('attacker', { fails: 9, next: Date.now() + 60_000 });
  l.fail('trigger');
  assert.ok(l.retryAfterMs('attacker') > 0, 'the attacker must still be throttled after a sweep');
});

test('the global budget caps total failures however many peers there are', () => {
  // A per-peer limiter alone gives every source address its own free attempts; this is what stops
  // an attacker with a thousand addresses walking the 6-digit pairing space.
  const b = new GlobalAttemptBudget(50, 10 * 60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 50; i++) {
    assert.equal(b.retryAfterMs(t0), 0, `failure ${i + 1} should still be inside the budget`);
    b.fail(t0);
  }
  assert.ok(b.retryAfterMs(t0) > 0, 'the 51st failure must be refused, whoever it comes from');
  assert.equal(b.retryAfterMs(t0 + 10 * 60_000 + 1), 0, 'and it refills once the window passes');
});

test('the global budget only ever spends on FAILURES', () => {
  // A masjid pairing twenty tablets in a row must not throttle itself — only wrong codes call fail().
  const b = new GlobalAttemptBudget(50, 10 * 60_000);
  const t0 = 2_000_000;
  for (let i = 0; i < 200; i++) assert.equal(b.retryAfterMs(t0), 0);
});
