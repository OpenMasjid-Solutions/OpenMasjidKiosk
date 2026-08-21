// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePublishable, looksLikeSecret, stripeMode, stripeConfigured, toMinor, toMajor, currencyDecimals, addIntervals, scheduledEndSec } from './stripe';

test('key format detection', () => {
  assert.equal(looksLikePublishable('pk_test_abc123'), true);
  assert.equal(looksLikePublishable('pk_live_abc123'), true);
  assert.equal(looksLikePublishable('sk_test_abc'), false);
  assert.equal(looksLikeSecret('sk_live_abc123'), true);
  assert.equal(looksLikeSecret('rk_test_abc123'), true); // restricted keys allowed
  assert.equal(looksLikeSecret('pk_test_abc'), false);
});

test('mode + configured require a matching test/live pair', () => {
  assert.equal(stripeMode({ publishableKey: 'pk_test_x', secretKey: 'sk_test_y' }), 'test');
  assert.equal(stripeMode({ publishableKey: 'pk_live_x', secretKey: 'sk_live_y' }), 'live');
  assert.equal(stripeMode({ publishableKey: '', secretKey: '' }), 'unknown');
  assert.equal(stripeConfigured({ publishableKey: 'pk_test_x', secretKey: 'sk_test_y' }), true);
  assert.equal(stripeConfigured({ publishableKey: 'pk_test_x', secretKey: 'sk_live_y' }), false); // mode mismatch
  assert.equal(stripeConfigured({ publishableKey: '', secretKey: '' }), false);
});

test('currency minor units incl. zero-decimal currencies', () => {
  assert.equal(currencyDecimals('USD'), 2);
  assert.equal(currencyDecimals('jpy'), 0); // case-insensitive
  assert.equal(toMinor(10.5, 'USD'), 1050);
  assert.equal(toMinor(500, 'JPY'), 500);
  assert.equal(toMajor(1050, 'USD'), 10.5);
  assert.equal(toMajor(500, 'JPY'), 500);
});

// ── Recurring plans: "stop after N more payments" ──
// The trap: a cancel_at landing exactly ON a renewal makes Stripe cancel INSTEAD of charging. Ending
// at payment N's own boundary therefore collects N-1, and "one more payment" collects nothing —
// which is the wrong answer to give an admin promising a donor a fixed number of gifts.
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

test('scheduledEndSec ends AFTER the Nth payment, never on it', () => {
  const t0 = sec('2026-09-01T00:00:00Z'); // the next payment
  // One more payment: it happens at T0, so the plan must run past T0 to the following boundary.
  assert.equal(iso(scheduledEndSec(t0, 'month', 1, 1)), '2026-10-01');
  assert.equal(iso(scheduledEndSec(t0, 'month', 1, 3)), '2026-12-01');
  assert.equal(iso(scheduledEndSec(t0, 'year', 1, 1)), '2027-09-01');
});

test('scheduledEndSec honors an interval_count (a quarterly plan)', () => {
  const t0 = sec('2026-09-01T00:00:00Z');
  assert.equal(iso(scheduledEndSec(t0, 'month', 3, 1)), '2026-12-01'); // one more quarter
  assert.equal(iso(scheduledEndSec(t0, 'month', 3, 2)), '2027-03-01');
});

test('a month-end plan is clamped, not skidded into the next month', () => {
  // 31 Jan + 1 month is 28 Feb, not 3 March — the same clamp the subscription anchor uses.
  assert.equal(iso(addIntervals(sec('2027-01-31T00:00:00Z'), 'month', 1)), '2027-02-28');
  // …and it must not then STAY on the 28th: the clamp is per hop from the original day.
  assert.equal(iso(addIntervals(sec('2027-01-31T00:00:00Z'), 'month', 2)), '2027-03-31');
});

test('day and week intervals add plainly', () => {
  assert.equal(iso(scheduledEndSec(sec('2026-09-01T00:00:00Z'), 'week', 1, 2)), '2026-09-15');
  assert.equal(iso(scheduledEndSec(sec('2026-09-01T00:00:00Z'), 'day', 1, 10)), '2026-09-11');
});
