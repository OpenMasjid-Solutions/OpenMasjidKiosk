// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePublishable, looksLikeSecret, stripeMode, stripeConfigured, toMinor, toMajor, currencyDecimals } from './stripe';

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
