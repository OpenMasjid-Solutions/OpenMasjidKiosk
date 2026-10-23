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
    // The same-origin relay for the masjid's logo, which the appearance answer now points at. Public
    // on the platform too, and needed wherever the appearance is — a remote kiosk's setup page.
    '/api/public/logo',
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

// Remote administration (OpenMasjidOS 0.51.2+). These pass the PATH guard; what lets a request in
// is OpenMasjidOS vouching for it on every call (requireAdmin), pinned end to end against a running
// server in remote-access.test.ts.
test('the remote admin surface passes the path guard', () => {
  for (const p of ['/api/session', '/api/logout', '/api/admin/plans', '/api/admin/donations.csv', '/api/admin/upload']) {
    assert.equal(blockedOverTunnel(p), false, `${p} must be reachable`);
  }
});

test('everything that turns a password into a session, the Fabric and unlisted /api stay refused', () => {
  for (const p of [
    '/api/login',
    '/api/setup',
    '/api/fabric/anything',
    '/api',
    '/api/',
    '/api/admin', // only the routes UNDER it are allowed
    '/api/sessions',
    '/api/session/x',
    '/api/logout/x',
    '/api/something-new',
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
    '/%61pi/login', // 'a'
    '/a%70i/login', // 'p'
    '/ap%69/login', // 'i'
    '/%61%70%69/login', // all three
    '/%61pi/setup',
    '/api/%6cogin',
    '/%61pi/fabric/stripe',
    '/api/%61dmin/plans', // raw form is an unlisted /api path — fail closed
    '/%2561pi/login', // double-encoded
  ]) {
    assert.equal(blockedOverTunnel(p), true, `${p} must be refused`);
  }
});

// Allowing /api/admin/* made a prefix that is allowed AS WRITTEN and the password login once `..` is
// resolved. Every resolved spelling is judged too.
test('dot-segment spellings cannot reach the password routes', () => {
  for (const p of [
    '/api/admin/../login',
    '/api/admin/%2e%2e/login',
    '/api/admin/%2E%2E/setup',
    '/api/kiosk/../login',
    '/api/kiosk/../../api/setup',
    '/api/admin/./../../api/login',
    '/x/../api/login',
    '//api/login',
    '/api//login',
    '/api/admin/../fabric/stripe',
  ]) {
    assert.equal(blockedOverTunnel(p), true, `${p} must be refused`);
  }
  // …while an admin path that resolves to another admin path is still just an admin path.
  assert.equal(blockedOverTunnel('/api/admin/../admin/plans'), false);
});

test('an encoded spelling of an ALLOWED path is still allowed (no false positives)', () => {
  // The kiosk prefixes contain nothing that percent-decoding can change, so every form still
  // matches the allowlist — a remote kiosk must not start 404ing because of this guard.
  for (const p of ['/api/kiosk/payment-intents/pi_%2e%2e/complete', '/api/kiosk/tuition/lookup', '/api/public/appearance', '/api/public/logo']) {
    assert.equal(blockedOverTunnel(p), false, `${p} must stay reachable`);
  }
});

test('query strings and fragments never smuggle a path past the guard', () => {
  assert.equal(blockedOverTunnel('/api/login?x=1'), true);
  assert.equal(blockedOverTunnel('/%61pi/login?x=1'), true);
  assert.equal(blockedOverTunnel('/api/kiosk/config?v=3'), false);
  // A query value that merely LOOKS like a refused path must not block a legitimate call.
  assert.equal(blockedOverTunnel('/api/kiosk/config?next=/api/login'), false);
});

test('a malformed percent-escape still gets the raw check, and never throws', () => {
  assert.equal(blockedOverTunnel('/api/setup/%zz'), true);
  assert.equal(blockedOverTunnel('/api/kiosk/%zz'), false);
  assert.equal(blockedOverTunnel('/%'), false); // not an /api path in any reading
});

test('empty and odd inputs are handled', () => {
  assert.equal(blockedOverTunnel(''), false);
  assert.equal(blockedOverTunnel('/'), false);
  assert.equal(blockedOverTunnel('/apiary'), false); // '/api' is a segment, not a prefix
  assert.equal(blockedOverTunnel('/api-docs'), false);
});
