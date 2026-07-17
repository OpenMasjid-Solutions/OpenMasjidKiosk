// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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

test('campaign TYPE drives the fee rule (deriveFees): zakat forces, donation offers, tuition = require toggle', () => {
  const s = freshStore();

  // Zakat: always forces the fee (offering implied) — even if the client sends forceCoverFees:false.
  const zakat = s.createCampaign({ title: 'Zakat', type: 'zakat', coverFees: false, forceCoverFees: false })!;
  assert.equal(zakat.type, 'zakat');
  assert.equal(zakat.forceCoverFees, true);
  assert.equal(zakat.coverFees, true);
  // Survives round-trip + getKioskConfig (with the type projected for the tablet's wording).
  const { config } = s.getKioskConfig('acct_primary');
  const camp = (config.campaigns as { id: string; type: string; coverFees: boolean; forceCoverFees: boolean }[]).find((x) => x.id === zakat.id)!;
  assert.equal(camp.type, 'zakat');
  assert.equal(camp.forceCoverFees, true);
  assert.equal(camp.coverFees, true);

  // Donation: never forces; coverFees stays the admin's optional offer (forcing is ignored).
  const don = s.createCampaign({ title: 'General', type: 'donation', coverFees: true, forceCoverFees: true })!;
  assert.equal(don.forceCoverFees, false);
  assert.equal(don.coverFees, true);
  const donOff = s.updateCampaign(don.id, { coverFees: false })!;
  assert.equal(donOff.coverFees, false);
  assert.equal(donOff.forceCoverFees, false);

  // Tuition: the require toggle drives both — offered iff required.
  const tuiReq = s.createCampaign({ title: 'Tuition', type: 'tuition', forceCoverFees: true })!;
  assert.equal(tuiReq.forceCoverFees, true);
  assert.equal(tuiReq.coverFees, true);
  const tuiOff = s.updateCampaign(tuiReq.id, { forceCoverFees: false })!;
  assert.equal(tuiOff.forceCoverFees, false);
  assert.equal(tuiOff.coverFees, false);

  // An unknown/missing type falls back to 'donation'.
  const legacy = s.createCampaign({ title: 'Legacy', coverFees: true } as never)!;
  assert.equal(legacy.type, 'donation');
});

test('per-device: campaign targeting filters getKioskConfig, and orientation is delivered per device', () => {
  const s = freshStore();
  const a = s.createDevice({ name: 'Foyer', platform: 'android', tokenHash: 'h_a' });
  const b = s.createDevice({ name: 'Hall', platform: 'android', tokenHash: 'h_b' });

  // A campaign targeted only at device A; an untargeted one (all kiosks).
  const targeted = s.createCampaign({ title: 'Foyer only', deviceIds: [a.id] })!;
  assert.deepEqual(targeted.deviceIds, [a.id]);
  const everyone = s.createCampaign({ title: 'Everywhere' })!;
  assert.deepEqual(everyone.deviceIds, []);

  const idsFor = (dev: string) => (s.getKioskConfig('', dev).config.campaigns as { id: string }[]).map((c) => c.id);
  // Device A sees main + targeted + everyone; device B sees main + everyone (NOT the A-targeted one).
  assert.ok(idsFor(a.id).includes(targeted.id));
  assert.ok(idsFor(a.id).includes(everyone.id));
  assert.ok(!idsFor(b.id).includes(targeted.id));
  assert.ok(idsFor(b.id).includes(everyone.id));

  // Orientation: set from the "web", delivered to that device's config; invalid falls back to 'auto'.
  assert.equal(s.getKioskConfig('', a.id).config.orientation, 'auto'); // default
  s.setDeviceOrientation(a.id, 'portrait');
  assert.equal(s.getKioskConfig('', a.id).config.orientation, 'portrait');
  assert.equal(s.getKioskConfig('', b.id).config.orientation, 'auto'); // per-device, B unaffected
  s.setDeviceOrientation(a.id, 'nonsense');
  assert.equal(s.getDevice(a.id)!.orientation, 'auto'); // invalid rejected

  // Revoking a device scrubs its id from every campaign's targeting, so a campaign aimed only at it
  // doesn't silently vanish fleet-wide — it falls back to "all kiosks" ([] = all).
  const both = s.createCampaign({ title: 'Both', deviceIds: [a.id, b.id] })!;
  const onlyB = s.createCampaign({ title: 'B only', deviceIds: [b.id] })!;
  s.revokeDevice(b.id);
  assert.deepEqual(s.getCampaign(both.id)!.deviceIds, [a.id]); // b pruned, still targeted at a
  assert.deepEqual(s.getCampaign(onlyB.id)!.deviceIds, []); // its only kiosk gone → all kiosks
  assert.ok(idsFor(a.id).includes(onlyB.id)); // and it now shows on the surviving kiosk
});

test('setGiving clamps the large-donation threshold to ≥0 and only keeps valid alternative images', () => {
  const s = freshStore();
  s.setGiving({ largeAmountThresholdMinor: -50, largeAmountNote: '  give by bank  ', largeAmountImage: 'javascript:alert(1)' });
  let g = s.getGiving();
  assert.equal(g.largeAmountThresholdMinor, 0); // negatives clamped
  assert.equal(g.largeAmountImage, ''); // unsafe URL rejected
  s.setGiving({ largeAmountThresholdMinor: 25000, largeAmountImage: '/uploads/qr_abcd1234.png' });
  g = s.getGiving();
  assert.equal(g.largeAmountThresholdMinor, 25000);
  assert.equal(g.largeAmountImage, '/uploads/qr_abcd1234.png');
  const { config } = s.getKioskConfig('acct_primary');
  assert.equal(config.largeAmountThresholdMinor, 25000);
  assert.equal(config.largeAmountImage, '/uploads/qr_abcd1234.png');
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

test('upgrading a PRE-campaigns install (donations table with no campaign columns) migrates, does not throw', () => {
  // Regression for the v0.9.0 startup crash: an existing donations table isn't recreated by
  // CREATE TABLE IF NOT EXISTS, so campaign_id must be added by ALTER *before* any index on it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-mig-'));
  const dbPath = path.join(dir, 'kiosk.db');
  const legacy = new Database(dbPath);
  legacy.exec(
    `CREATE TABLE donations (
       id TEXT PRIMARY KEY, payment_intent_id TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '',
       amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'one_time',
       status TEXT NOT NULL DEFAULT '', donor_name TEXT NOT NULL DEFAULT '', donor_email TEXT NOT NULL DEFAULT '',
       charge_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
     );`,
  );
  legacy
    .prepare(`INSERT INTO donations (id, payment_intent_id, amount_minor, currency, status, created_at) VALUES ('pi_old','pi_old',500,'USD','succeeded',?)`)
    .run(new Date().toISOString());
  legacy.close();

  let s: Store | undefined;
  assert.doesNotThrow(() => {
    s = new Store(dbPath);
  });
  const log = s!.listDonations();
  assert.equal(log.length, 1); // the legacy donation survives
  assert.equal(log[0].campaignId, ''); // new columns default cleanly
  assert.equal(log[0].campaignTitle, '');
  assert.ok(s!.getMainCampaign()); // a main campaign was seeded on upgrade
  s!.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrading a legacy campaign with force_cover_fees=1 (pre-`type`) maps it to type=zakat', () => {
  // Regression: v0.9.8–v0.9.11 had a force-fee toggle before the `type` field existed. On upgrade a
  // force=1 row must become type='zakat' (consistent + intent-preserving), NOT type='donation' + force=1
  // (which would keep the kiosk forcing the fee while the admin panel shows it as optional).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-type-'));
  const dbPath = path.join(dir, 'kiosk.db');
  const legacy = new Database(dbPath);
  // A v0.9.11-era campaigns table: has force_cover_fees but NO `type` column.
  legacy.exec(
    `CREATE TABLE campaigns (
       id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
       primary_color TEXT NOT NULL DEFAULT '', accent_color TEXT NOT NULL DEFAULT '',
       background_image TEXT NOT NULL DEFAULT '', cover_image TEXT NOT NULL DEFAULT '', logo TEXT NOT NULL DEFAULT '',
       presets_minor TEXT NOT NULL DEFAULT '[]', allow_custom INTEGER NOT NULL DEFAULT 1,
       custom_min_minor INTEGER NOT NULL DEFAULT 100, custom_max_minor INTEGER NOT NULL DEFAULT 1000000,
       monthly_enabled INTEGER NOT NULL DEFAULT 1, cover_fees INTEGER NOT NULL DEFAULT 0,
       force_cover_fees INTEGER NOT NULL DEFAULT 0, thank_you_message TEXT NOT NULL DEFAULT '',
       theme TEXT NOT NULL DEFAULT 'auto', stripe_account_id TEXT NOT NULL DEFAULT '',
       live INTEGER NOT NULL DEFAULT 1, is_main INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     );`,
  );
  const now = new Date().toISOString();
  legacy.prepare(`INSERT INTO campaigns (id, title, cover_fees, force_cover_fees, is_main, sort_order, created_at) VALUES ('cmp_z','Zakat',1,1,1,0,?)`).run(now);
  legacy.prepare(`INSERT INTO campaigns (id, title, cover_fees, force_cover_fees, is_main, sort_order, created_at) VALUES ('cmp_d','General',0,0,0,1,?)`).run(now);
  legacy.close();

  let s: Store | undefined;
  assert.doesNotThrow(() => {
    s = new Store(dbPath);
  });
  const z = s!.getCampaign('cmp_z')!;
  assert.equal(z.type, 'zakat'); // legacy forced row → zakat (intent preserved, row consistent)
  assert.equal(z.forceCoverFees, true);
  assert.equal(z.coverFees, true);
  const d = s!.getCampaign('cmp_d')!;
  assert.equal(d.type, 'donation'); // a non-forced legacy row stays a donation
  assert.equal(d.forceCoverFees, false);
  s!.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
