// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

// Every currency's minor units, and the smallest amount Stripe can charge in it. The panel's table
// (web/src/money.ts) must equal the server's, or the admin types an amount the server reads at a
// different scale — which is how UGX went to Stripe at a hundredth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimals as webDecimals } from '../../web/src/money';
import { currencyDecimals, minorStep } from './stripe';
import { grossUpForFees, Store } from './store';

test('the panel and the server agree on every currency Node knows', () => {
  const all = Intl.supportedValuesOf('currency');
  assert.ok(all.length > 100);
  for (const c of all) assert.equal(webDecimals(c), currencyDecimals(c), c);
});

test('UGX and ISK are two-decimal values in whole units; the dinars end in 0', () => {
  for (const c of ['UGX', 'ISK']) {
    assert.equal(currencyDecimals(c), 2, c);
    assert.equal(minorStep(c), 100, c);
  }
  for (const c of ['KWD', 'BHD', 'OMR', 'JOD', 'TND']) assert.equal(minorStep(c), 10, c);
  for (const c of ['USD', 'GBP', 'JPY', 'PKR']) assert.equal(minorStep(c), 1, c);
});

test('a cover-the-fee total is always an amount Stripe can charge, and still covers the fee', () => {
  for (const c of ['KWD', 'BHD', 'UGX', 'ISK', 'USD', 'JPY']) {
    for (const base of [100, 5_000, 10_000, 250_000, 1_000_000]) {
      const total = grossUpForFees(base, c);
      assert.equal(total % minorStep(c), 0, `${c} ${base} -> ${total}`);
      assert.ok(total > base, `${c} ${base} -> ${total}`);
    }
  }
});

test('amounts Stripe cannot charge are refused, and presets are saved onto the step', () => {
  const s = new Store(':memory:');
  s.setCurrency('KWD');
  const main = s.listCampaigns()[0];
  s.updateCampaign(main.id, { presetsMinor: [5_125, 10_000], allowCustom: true, customMinMinor: 1_005, customMaxMinor: 99_995 });
  const c = s.getCampaign(main.id)!;
  assert.deepEqual(c.presetsMinor, [5_130, 10_000], 'rounded to a last 0');
  assert.equal(c.customMinMinor, 1_010, 'the floor moves up');
  assert.equal(c.customMaxMinor, 99_990, 'the ceiling moves down');
  assert.equal(s.isAllowedAmountForCampaign(c, 5_130), true);
  assert.equal(s.isAllowedAmountForCampaign(c, 12_345), false, '12.345 KWD');
  assert.equal(s.isAllowedAmountForCampaign(c, 12_340), true);
});

test('an existing UGX install keeps what its amounts meant, once', () => {
  const s = new Store(':memory:');
  // Before 0.14.0: UGX zero-decimal, a USh 10,000 tile stored as 10000. Recreate that state.
  s['setRaw']('currency', 'UGX');
  const main = s.listCampaigns()[0];
  s['writeCampaign']({ ...main, presetsMinor: [10_000, 50_000], customMinMinor: 1_000, customMaxMinor: 1_000_000 });
  s['db'].prepare("DELETE FROM kv WHERE key = 'ugx_two_decimal'").run();
  s['migrateUgxScale']();
  const c = s.getCampaign(main.id)!;
  assert.deepEqual(c.presetsMinor, [1_000_000, 5_000_000], 'USh 10,000 is now 1,000,000 hundredths');
  assert.equal(c.customMinMinor, 100_000);
  s['migrateUgxScale']();
  assert.deepEqual(s.getCampaign(main.id)!.presetsMinor, [1_000_000, 5_000_000], 'never twice');
});
