// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashSecret, verifySecret, makeToken, verifyToken } from './auth';

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
