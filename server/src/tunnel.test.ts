// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedOverTunnel } from './tunnel';

// These run against the path AFTER rewriteUrl has stripped the tunnel's base prefix, which is
// exactly what the onRequest guard sees.

test('the kiosk surface is reachable over the tunnel', () => {
  for (const p of [
    '/api/app',
    '/api/public/appearance',
    '/api/kiosk/pair',
    '/api/kiosk/heartbeat',
    '/api/kiosk/config',
    '/api/kiosk/connection-token',
    '/api/kiosk/payment-intents',
    '/api/kiosk/payment-intents/pi_123/complete',
    '/api/kiosk/tuition/identify',
    '/api/kiosk/tuition/payment-intents/pi_9/complete',
  ]) {
    assert.equal(blockedOverTunnel(p), false, `${p} must stay reachable`);
  }
});

test('non-API paths (the SPA, /new, the APK, uploads) are reachable over the tunnel', () => {
  for (const p of ['/', '/new', '/download/openmasjidkiosk.apk', '/uploads/img_abc.png', '/assets/index-x.js', '/healthz']) {
    assert.equal(blockedOverTunnel(p), false, `${p} must stay reachable`);
  }
});

test('the admin surface is refused over the tunnel', () => {
  for (const p of [
    '/api/admin/plans',
    '/api/admin/donations.csv',
    '/api/admin/devices',
    '/api/admin/payments',
    '/api/login',
    '/api/logout',
    '/api/setup',
    '/api/session',
    '/api/fabric/anything',
    '/api',
  ]) {
    assert.equal(blockedOverTunnel(p), true, `${p} must be refused`);
  }
});

// ── The regression this module exists for ──
// Fastify's router percent-decodes path segments before matching, so a guard reading only the raw
// path could be walked past by encoding one letter of the FIRST segment. Confirmed live against a
// running server before the fix: /kiosk/%61pi/login reached the real password login with HTTP 400,
// while /kiosk/api/login correctly 404'd.
test('percent-encoded spellings of /api cannot slip the guard', () => {
  for (const p of [
    '/%61pi/admin/plans', // 'a'
    '/a%70i/admin/plans', // 'p'
    '/ap%69/admin/plans', // 'i'
    '/%61%70%69/admin/plans', // all three
    '/%61pi/login',
    '/%61pi/session',
    '/%61pi/setup',
    '/%61pi/admin/donations.csv',
    '/api/%61dmin/plans', // this one the raw check already caught — keep it caught
    '/%2561pi/admin/plans', // double-encoded
  ]) {
    assert.equal(blockedOverTunnel(p), true, `${p} must be refused`);
  }
});

test('an encoded spelling of an ALLOWED path is still allowed (no false positives)', () => {
  // The kiosk prefixes contain nothing that percent-decoding can change, so every form still
  // matches the allowlist — a remote kiosk must not start 404ing because of this guard.
  for (const p of ['/api/kiosk/payment-intents/pi_%2e%2e/complete', '/api/kiosk/tuition/lookup', '/api/public/appearance']) {
    assert.equal(blockedOverTunnel(p), false, `${p} must stay reachable`);
  }
});

test('query strings and fragments never smuggle a path past the guard', () => {
  assert.equal(blockedOverTunnel('/api/admin/plans?x=1'), true);
  assert.equal(blockedOverTunnel('/%61pi/admin/plans?x=1'), true);
  assert.equal(blockedOverTunnel('/api/kiosk/config?v=3'), false);
  // A query value that merely LOOKS like an admin path must not block a legitimate call.
  assert.equal(blockedOverTunnel('/api/kiosk/config?next=/api/admin/plans'), false);
});

test('a malformed percent-escape still gets the raw check, and never throws', () => {
  assert.equal(blockedOverTunnel('/api/admin/%zz'), true);
  assert.equal(blockedOverTunnel('/api/kiosk/%zz'), false);
  assert.equal(blockedOverTunnel('/%'), false); // not an /api path in any reading
});

test('empty and odd inputs are handled', () => {
  assert.equal(blockedOverTunnel(''), false);
  assert.equal(blockedOverTunnel('/'), false);
  assert.equal(blockedOverTunnel('/apiary'), false); // '/api' is a segment, not a prefix
  assert.equal(blockedOverTunnel('/api-docs'), false);
});
