// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, grossUpForFees, FEE_BPS, FEE_FIXED_MINOR } from './store';

/** A fresh in-memory store per test (better-sqlite3 supports ':memory:'). */
function freshStore(): Store {
  return new Store(':memory:');
}

test('a fresh store seeds exactly one main campaign (migration from single giving)', () => {
  const s = freshStore();
  const list = s.listCampaigns();
  assert.equal(list.length, 1);
  assert.equal(list[0].isMain, true);
  assert.equal(list[0].live, true);
  // Seeded from the giving defaults.
  assert.deepEqual(list[0].presetsMinor, [500, 1000, 2000, 5000, 10000, 25000]);
  assert.equal(s.getMainCampaign()?.id, list[0].id);
});

test('createCampaign adds a non-main appeal, appended after main, with incrementing sort order', () => {
  const s = freshStore();
  const a = s.createCampaign({ title: 'Zakat' });
  const b = s.createCampaign({ title: 'Building Fund' });
  assert.equal(a.isMain, false);
  assert.equal(b.isMain, false);
  assert.ok(b.sortOrder > a.sortOrder);
  const list = s.listCampaigns();
  assert.equal(list.length, 3);
  assert.equal(list[0].isMain, true); // main always first
  assert.deepEqual(list.slice(1).map((c) => c.title), ['Zakat', 'Building Fund']);
});

test('updateCampaign sanitises hex colour, caps presets to 6, and clamps custom bounds', () => {
  const s = freshStore();
  const c = s.createCampaign({ title: 'X' });
  const up = s.updateCampaign(c.id, {
    accentColor: 'not-a-colour',
    presetsMinor: [100, 200, 300, 400, 500, 600, 700, 800],
    customMinMinor: 500,
    customMaxMinor: 100, // below min → clamped up to min
  })!;
  assert.equal(up.accentColor, ''); // invalid hex dropped
  assert.equal(up.presetsMinor.length, 6);
  assert.equal(up.customMinMinor, 500);
  assert.equal(up.customMaxMinor, 500);
  const good = s.updateCampaign(c.id, { accentColor: '#1FA37A' })!;
  assert.equal(good.accentColor, '#1fa37a'); // normalised to lower-case
});

test('updateCampaign keeps only /uploads or http(s) image URLs, rejecting others', () => {
  const s = freshStore();
  const c = s.createCampaign({ title: 'X' });
  const up = s.updateCampaign(c.id, {
    backgroundImage: '/uploads/img_abcd1234.png',
    coverImage: 'javascript:alert(1)',
    logo: 'https://example.org/logo.png',
  })!;
  assert.equal(up.backgroundImage, '/uploads/img_abcd1234.png');
  assert.equal(up.coverImage, ''); // rejected
  assert.equal(up.logo, 'https://example.org/logo.png');
});

test('the main campaign cannot be deleted; a normal campaign can', () => {
  const s = freshStore();
  const main = s.getMainCampaign()!;
  const c = s.createCampaign({ title: 'Temp' });
  assert.equal(s.deleteCampaign(main.id), false);
  assert.equal(s.deleteCampaign(c.id), true);
  assert.equal(s.getCampaign(c.id), null);
  assert.ok(s.getMainCampaign()); // main survives
});

test('setMainCampaign switches which campaign is main (and forces it live)', () => {
  const s = freshStore();
  const oldMain = s.getMainCampaign()!;
  const c = s.createCampaign({ title: 'New Main', live: false });
  assert.equal(s.setMainCampaign(c.id), true);
  assert.equal(s.getMainCampaign()?.id, c.id);
  assert.equal(s.getCampaign(c.id)?.live, true); // main is always live
  assert.equal(s.getCampaign(oldMain.id)?.isMain, false);
});

test('isAllowedAmountForCampaign accepts presets and in-range custom, rejects the rest', () => {
  const s = freshStore();
  const c = s.createCampaign({ title: 'X', presetsMinor: [1000, 5000], allowCustom: true, customMinMinor: 200, customMaxMinor: 9000 });
  assert.equal(s.isAllowedAmountForCampaign(c, 1000), true); // preset
  assert.equal(s.isAllowedAmountForCampaign(c, 250), true); // custom in range
  assert.equal(s.isAllowedAmountForCampaign(c, 100), false); // below min
  assert.equal(s.isAllowedAmountForCampaign(c, 12000), false); // above max
  assert.equal(s.isAllowedAmountForCampaign(c, 10.5), false); // non-integer
  const noCustom = s.createCampaign({ title: 'Y', presetsMinor: [1000], allowCustom: false, customMinMinor: 100, customMaxMinor: 100000 });
  assert.equal(s.isAllowedAmountForCampaign(noCustom, 250), false); // custom disabled
  assert.equal(s.isAllowedAmountForCampaign(noCustom, 1000), true); // preset still ok
});

test('grossUpForFees adds an estimated fee so the net after fee ≈ the base, and never shrinks it', () => {
  for (const base of [500, 1000, 2500, 100000]) {
    const total = grossUpForFees(base);
    assert.ok(total >= base, 'total is at least the base');
    // Net after the estimated fee should land at or just above the base (never short-changing the masjid).
    const feeOnTotal = Math.round((total * FEE_BPS) / 10000) + FEE_FIXED_MINOR;
    assert.ok(total - feeOnTotal >= base - 1, `net (${total - feeOnTotal}) covers base (${base})`);
  }
  assert.equal(grossUpForFees(0), 0);
  assert.equal(grossUpForFees(-5), -5);
});

test('getKioskConfig exposes live campaigns (main first) with readerCapable + fee estimate', () => {
  const s = freshStore();
  const main = s.getMainCampaign()!;
  const same = s.createCampaign({ title: 'Same acct', stripeAccountId: '' });
  const other = s.createCampaign({ title: 'Other acct', stripeAccountId: 'acct_other' });
  const hidden = s.createCampaign({ title: 'Hidden', live: false });
  const { config } = s.getKioskConfig('acct_primary');
  const campaigns = config.campaigns as { id: string; isMain: boolean; readerCapable: boolean }[];
  const ids = campaigns.map((c) => c.id);
  assert.equal(campaigns[0].isMain, true); // main first
  assert.ok(ids.includes(same.id));
  assert.ok(ids.includes(other.id));
  assert.ok(!ids.includes(hidden.id)); // hidden (non-live, non-main) excluded
  // Empty account id → primary/reader-capable; a different account id → keyed-only.
  assert.equal(campaigns.find((c) => c.id === same.id)?.readerCapable, true);
  assert.equal(campaigns.find((c) => c.id === other.id)?.readerCapable, false);
  assert.equal(campaigns.find((c) => c.id === main.id)?.readerCapable, true);
  assert.equal(config.feeBps, FEE_BPS);
  assert.equal(config.feeFixedMinor, FEE_FIXED_MINOR);
  assert.equal(config.mainCampaignId, main.id);
});

test('a donation records its campaign id + title and surfaces them in the log', () => {
  const s = freshStore();
  const c = s.createCampaign({ title: 'Zakat' });
  s.recordDonation({
    paymentIntentId: 'pi_test_123',
    deviceId: 'dev_x',
    campaignId: c.id,
    campaignTitle: 'Zakat',
    amountMinor: 2000,
    currency: 'USD',
    kind: 'one_time',
    status: 'succeeded',
  });
  const log = s.listDonations();
  assert.equal(log.length, 1);
  assert.equal(log[0].campaignId, c.id);
  assert.equal(log[0].campaignTitle, 'Zakat');
});

test('rememberPiAccount round-trips and falls back to empty for unknown PIs', () => {
  const s = freshStore();
  s.rememberPiAccount('pi_abc', 'acct_123');
  assert.equal(s.getPiAccount('pi_abc'), 'acct_123');
  assert.equal(s.getPiAccount('pi_unknown'), '');
});
