// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store, grossUpForFees, feeFixedMinorFor, rescaleMinor, FEE_BPS, FEE_FIXED_MINOR } from './store';

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

test('updateCampaign sanitizes hex color, caps presets to 6, and clamps custom bounds', () => {
  const s = freshStore();
  const c = s.createCampaign({ title: 'X' });
  const up = s.updateCampaign(c.id, {
    accentColor: 'not-a-color',
    presetsMinor: [100, 200, 300, 400, 500, 600, 700, 800],
    customMinMinor: 500,
    customMaxMinor: 100, // below min → clamped up to min
  })!;
  assert.equal(up.accentColor, ''); // invalid hex dropped
  assert.equal(up.presetsMinor.length, 6);
  assert.equal(up.customMinMinor, 500);
  assert.equal(up.customMaxMinor, 500);
  const good = s.updateCampaign(c.id, { accentColor: '#1FA37A' })!;
  assert.equal(good.accentColor, '#1fa37a'); // normalized to lower-case
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

  // Orientation: a UI rotation in degrees, delivered to that device's config; default '0' (no rotation).
  assert.equal(s.getKioskConfig('', a.id).config.orientation, '0'); // default
  s.setDeviceOrientation(a.id, '90');
  assert.equal(s.getKioskConfig('', a.id).config.orientation, '90');
  assert.equal(s.getKioskConfig('', b.id).config.orientation, '0'); // per-device, B unaffected
  s.setDeviceOrientation(a.id, 'portrait'); // legacy named value normalizes to degrees
  assert.equal(s.getDevice(a.id)!.orientation, '90');
  s.setDeviceOrientation(a.id, 'nonsense');
  assert.equal(s.getDevice(a.id)!.orientation, '0'); // invalid → no rotation

  // Reader side (NFC hint): per-device, defaults off, only left/right/off are kept, reaches the config.
  assert.equal(s.getKioskConfig('', a.id).config.nfcSide, 'off'); // default
  s.setDeviceNfcSide(a.id, 'left');
  assert.equal(s.getKioskConfig('', a.id).config.nfcSide, 'left');
  assert.equal(s.getKioskConfig('', b.id).config.nfcSide, 'off'); // per-device, B unaffected
  s.setDeviceNfcSide(a.id, 'sideways'); // unknown → back to off
  assert.equal(s.getDevice(a.id)!.nfcSide, 'off');

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

test('setGiving keeps a valid tabSize (default medium) and rejects junk; it reaches the kiosk config', () => {
  const s = freshStore();
  assert.equal(s.getGiving().tabSize, 'medium'); // default: the original tab size
  s.setGiving({ tabSize: 'large' });
  assert.equal(s.getGiving().tabSize, 'large');
  assert.equal(s.getKioskConfig('acct_primary').config.tabSize, 'large'); // delivered to the tablet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  s.setGiving({ tabSize: 'gigantic' as any }); // unknown value → falls back to medium
  assert.equal(s.getGiving().tabSize, 'medium');
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
    const total = grossUpForFees(base, 'USD');
    assert.ok(total >= base, 'total is at least the base');
    // Net after the estimated fee should land at or just above the base (never short-changing the masjid).
    const feeOnTotal = Math.round((total * FEE_BPS) / 10000) + FEE_FIXED_MINOR;
    assert.ok(total - feeOnTotal >= base - 1, `net (${total - feeOnTotal}) covers base (${base})`);
  }
  assert.equal(grossUpForFees(0, 'USD'), 0);
  assert.equal(grossUpForFees(-5, 'USD'), -5);
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

test('branded receipt lifecycle: first-record sends once, a retried /complete never regresses or double-sends', () => {
  const s = freshStore();
  const base = { paymentIntentId: 'pi_r1', deviceId: 'dev_x', amountMinor: 2000, currency: 'USD', kind: 'one_time', status: 'succeeded' };
  // First recording of a branded (pending) donation.
  const first = s.recordDonation({ ...base, receipt: 'pending', cardBrand: 'visa', cardLast4: '4242' });
  assert.equal(first.firstRecord, true);
  assert.equal(first.receipt, 'pending');
  // The inline send succeeded → mark it sent.
  s.setDonationReceipt('pi_r1', 'sent');
  // A retried /complete records again with receipt='pending' — must NOT regress the 'sent' row and
  // must report firstRecord=false so the caller doesn't re-send.
  const retry = s.recordDonation({ ...base, receipt: 'pending', cardBrand: 'visa', cardLast4: '4242' });
  assert.equal(retry.firstRecord, false);
  assert.equal(retry.receipt, 'sent');
  const row = s.getDonationByPaymentIntent('pi_r1')!;
  assert.equal(row.receipt, 'sent');
  assert.equal(row.cardBrand, 'visa');
  assert.equal(row.cardLast4, '4242');
});

test('the retry outbox skips a just-recorded pending row (min-age floor) so it cannot race the inline send', () => {
  const s = freshStore();
  s.recordDonation({ paymentIntentId: 'pi_r2', deviceId: 'dev_x', amountMinor: 2000, currency: 'USD', kind: 'one_time', status: 'succeeded', donorEmail: 'a@b.co', receipt: 'pending' });
  // With no floor the fresh pending row is retryable…
  assert.equal(s.listPendingReceipts(3 * 24 * 3600_000, 0).length, 1);
  // …but with a 2-minute floor it is skipped (the inline /complete send still owns it → no double-send).
  assert.equal(s.listPendingReceipts(3 * 24 * 3600_000, 120_000).length, 0);
  // A 'sent' row is never picked up regardless.
  s.setDonationReceipt('pi_r2', 'sent');
  assert.equal(s.listPendingReceipts(3 * 24 * 3600_000, 0).length, 0);
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

// ── Admin audit trail (KIOSK-004) ────────────────────────────────────────────
// The actions recorded here end or alter a real donor's standing order. The properties that
// matter are: it records, it stays append-only, it never throws, and it never holds a secret.

test('audit records an action and reads it back newest-first', () => {
  const s = freshStore();
  assert.deepEqual(s.listAudit(), []); // nothing until something happens
  s.recordAudit({ action: 'plan.cancel', target: 'sub_A', detail: 'ends at the end of the paid period', actor: 'aisha (OpenMasjidOS)', source: '10.0.0.5' });
  s.recordAudit({ action: 'plan.pause', target: 'sub_B', detail: 'paused', actor: 'aisha (OpenMasjidOS)', source: '10.0.0.5' });
  const rows = s.listAudit();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'plan.pause'); // newest first
  assert.equal(rows[1].action, 'plan.cancel');
  assert.equal(rows[1].target, 'sub_A');
  assert.equal(rows[1].actor, 'aisha (OpenMasjidOS)');
  assert.equal(rows[1].source, '10.0.0.5');
  assert.match(rows[1].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('audit never throws, whatever it is handed', () => {
  const s = freshStore();
  // A failure to write the note must never take down the cancellation it describes.
  assert.doesNotThrow(() => s.recordAudit({ action: '' }));
  assert.doesNotThrow(() => s.recordAudit({ action: 'x', detail: 'y'.repeat(10_000), target: 'z'.repeat(10_000) }));
  assert.doesNotThrow(() => s.recordAudit({ action: 'plan.cancel', actor: undefined, source: undefined }));
  const rows = s.listAudit();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.detail.length <= 500 && r.target.length <= 200));
});

test('audit survives a store reopened on the same file (it is durable, not in-memory)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-audit-'));
  const file = path.join(dir, 'k.db');
  try {
    const a = new Store(file);
    a.recordAudit({ action: 'pin.set', detail: 'kiosk exit PIN changed' });
    a.close();
    const b = new Store(file);
    const rows = b.listAudit();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'pin.set');
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the audit table adds itself to an EXISTING database (upgrade path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-audit-mig-'));
  const file = path.join(dir, 'k.db');
  try {
    // A database that predates this release: the kv table exists, admin_audit does not.
    const old = new Database(file);
    old.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    old.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('currency', 'GBP');
    old.close();
    const s = new Store(file);
    assert.equal(s.getCurrency(), 'GBP'); // existing data untouched
    s.recordAudit({ action: 'device.revoke', target: 'dev_1' });
    assert.equal(s.listAudit()[0].action, 'device.revoke');
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listAudit clamps its limit (no unbounded read)', () => {
  const s = freshStore();
  for (let i = 0; i < 20; i++) s.recordAudit({ action: `a${i}` });
  assert.equal(s.listAudit(5).length, 5);
  assert.equal(s.listAudit(0).length, 1); // floored at 1, never 0 or negative
  assert.equal(s.listAudit(-3).length, 1);
  assert.equal(s.listAudit(99_999).length, 20); // ceiling applied, still returns what exists
});

test('a refundable donation keeps its Stripe account for as long as the donation exists', () => {
  // The pi_accounts prune was written when /complete was its only reader — "a PI is completed
  // within seconds, so 7 days is generous". Then refunds shipped and started reading the same
  // table to choose the key to refund WITH, days or weeks later. Every donation older than a week
  // that had been taken on a CAMPAIGN'S OWN Stripe account then refunded against the primary
  // account's key instead, and Stripe rightly answered "no such payment_intent" — a 502 the admin
  // could never get past. A donor asking for their money back a month later is the ordinary case.
  const s = new Store(':memory:');
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const db = (s as unknown as { db: Database.Database }).db;

  db.prepare('INSERT INTO donations (id, payment_intent_id, amount_minor, currency, status, created_at) VALUES (?,?,?,?,?,?)')
    .run('pi_kept', 'pi_kept', 5000, 'GBP', 'succeeded', old);
  db.prepare('INSERT INTO pi_accounts (pi, account, created_at) VALUES (?,?,?)').run('pi_kept', 'acct_campaign', old);
  // An attempt that never became anything — nobody can ever need its account again.
  db.prepare('INSERT INTO pi_accounts (pi, account, created_at) VALUES (?,?,?)').run('pi_abandoned', 'acct_campaign', old);

  s.rememberPiAccount('pi_new', 'acct_primary'); // any write runs the prune

  assert.equal(s.getPiAccount('pi_kept'), 'acct_campaign', 'a 30-day-old donation must still know which account to refund from');
  assert.equal(s.getPiAccount('pi_abandoned'), '', 'abandoned attempts are still pruned, so the table cannot grow forever');
  assert.equal(s.getPiAccount('pi_new'), 'acct_primary');
});

test('tuition payments and monthly first-payments keep their account too', () => {
  // Same lookup, two other long-lived readers: a tuition payment can be refunded, and a plan's
  // first payment is card-present and therefore not an invoice Stripe can find on its own.
  const s = new Store(':memory:');
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const db = (s as unknown as { db: Database.Database }).db;

  db.prepare('INSERT INTO tuition_outbox (payment_intent_id, family_id, amount_minor, currency, created_at) VALUES (?,?,?,?,?)')
    .run('pi_tuition', 'fam_1', 5000, 'GBP', old);
  db.prepare('INSERT INTO plans (subscription_id, first_payment_intent_id, created_at) VALUES (?,?,?)').run('sub_1', 'pi_plan', old);
  for (const pi of ['pi_tuition', 'pi_plan']) {
    db.prepare('INSERT INTO pi_accounts (pi, account, created_at) VALUES (?,?,?)').run(pi, 'acct_campaign', old);
  }

  s.rememberPiAccount('pi_new', 'acct_primary');

  assert.equal(s.getPiAccount('pi_tuition'), 'acct_campaign');
  assert.equal(s.getPiAccount('pi_plan'), 'acct_campaign');
});

// ── The masjid's clock and currency (app UI spec §10) ────────────────────────────────────────
// Two facts a server gets wrong by default: its clock is UTC (a Docker container's), and a minor unit
// is not the same size in every currency. Both used to leak straight onto a volunteer's screen.

/** Insert a succeeded donation at an exact instant — recordDonation always stamps "now". */
function donationAt(s: Store, id: string, iso: string, amountMinor: number, currency = 'USD'): void {
  const db = (s as unknown as { db: Database.Database }).db;
  db.prepare('INSERT INTO donations (id, payment_intent_id, amount_minor, currency, status, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, id, amountMinor, currency, 'succeeded', iso);
}

test('"today" and "this month" are the MASJID’S day and month, not the container’s UTC one', () => {
  // Friday 25 Sept 2026, 10 pm in Chicago — already Saturday 03:00 in UTC. Under the old
  // setHours(0,0,0,0) on a UTC server, the evening's gifts had rolled into "yesterday" at 7 pm.
  const s = freshStore();
  s.setMasjid({ timeZone: 'America/Chicago' });
  const now = new Date('2026-09-26T03:00:00Z');
  donationAt(s, 'pi_fri_evening', '2026-09-25T23:00:00Z', 1_000); // Fri 18:00 Chicago → today
  donationAt(s, 'pi_thu_night', '2026-09-25T04:00:00Z', 200); //      Thu 23:00 Chicago → not today
  donationAt(s, 'pi_aug_31', '2026-09-01T04:00:00Z', 30); //         Mon 31 Aug 23:00 Chicago → last month
  donationAt(s, 'pi_sep_1', '2026-09-01T06:00:00Z', 4); //           Tue 1 Sept 01:00 Chicago → this month
  const t = s.donationTotals(now);
  assert.equal(t.today, 1_000, 'Friday evening is still Friday in Chicago');
  assert.equal(t.thisMonth, 1_000 + 200 + 4, 'the 31st of August is not September, whatever UTC says');
  assert.equal(t.allTime, 1_234);
  assert.equal(t.thisWeek, 1_000 + 200, 'the week is a rolling seven days, which needs no zone');

  // And the other direction: east of UTC, the masjid's day starts BEFORE the container's.
  const k = freshStore();
  k.setMasjid({ timeZone: 'Asia/Karachi' }); // UTC+5
  const know = new Date('2026-09-25T20:00:00Z'); // Sat 26 Sept, 01:00 in Karachi
  donationAt(k, 'pi_after_midnight', '2026-09-25T19:30:00Z', 500); // 00:30 Saturday → today
  donationAt(k, 'pi_before_midnight', '2026-09-25T18:00:00Z', 70); // 23:00 Friday → not today (UTC calls it today)
  assert.equal(k.donationTotals(know).today, 500);
});

test('the kiosk config carries what the tablet reads of the masjid — and moves when either changes', () => {
  const s = freshStore();
  // Nothing chosen yet: US conventions.
  let c = s.getKioskConfig().config;
  assert.equal(c.locale, 'en-US');
  for (const unread of ['timeZone', 'clock24h', 'hijriOffset']) {
    assert.ok(!(unread in c), `${unread} is not sent: no tablet build reads it`);
  }

  let before = s.getConfigVersion();
  s.setMasjid({ address: { country: 'GB' } });
  assert.ok(s.getConfigVersion() > before, 'tablets refetch when the country (so the locale) changes');
  c = s.getKioskConfig().config;
  assert.equal(c.locale, 'en-GB', 'English copy, the masjid’s own conventions');

  // A rename alone used to leave every kiosk on the old name until something unrelated bumped it.
  before = s.getConfigVersion();
  s.setMasjid({ name: 'Al-Noor Masjid' });
  assert.ok(s.getConfigVersion() > before, 'tablets refetch when the masjid is renamed');
  assert.equal(s.getKioskConfig().config.masjidName, 'Al-Noor Masjid');

  // The clock is the panel's and the receipts' business; nothing on a tablet changes with it.
  before = s.getConfigVersion();
  s.setMasjid({ timeZone: 'Europe/London', clock24h: true, hijriOffset: -1 });
  assert.equal(s.getConfigVersion(), before, 'no refetch for settings no tablet reads');
  assert.equal(s.getClock().timeZone, 'Europe/London');

  // And saving the form unchanged pushes nothing.
  s.setMasjid({ name: 'Al-Noor Masjid', address: { country: 'GB' } });
  assert.equal(s.getConfigVersion(), before);
});

test('the fixed card fee is scaled to the currency — and unchanged, to the unit, for 2-decimal ones', () => {
  // The tablet adds `feeFixedMinor` to minor units as-is, so the old flat 30 was ¥30 and 0.030 KWD.
  assert.equal(feeFixedMinorFor('USD'), FEE_FIXED_MINOR);
  assert.equal(feeFixedMinorFor('gbp'), 30);
  assert.equal(feeFixedMinorFor('KWD'), 300);
  assert.equal(feeFixedMinorFor('JPY'), 0);
  for (const base of [1, 500, 1000, 2500, 99_999, 100_000]) {
    // Byte-identical to the flat 30 the tablet and server always used for 2-decimal currencies.
    const flat = Math.max(base, Math.ceil((base + FEE_FIXED_MINOR) / (1 - FEE_BPS / 10000)));
    assert.equal(grossUpForFees(base, 'USD'), flat, 'dollars are byte-identical');
    assert.equal(grossUpForFees(base, 'EUR'), flat);
  }
  assert.equal(grossUpForFees(5_000, 'KWD'), Math.ceil((5_000 + 300) / (1 - FEE_BPS / 10000)));
  assert.equal(grossUpForFees(5_000, 'JPY'), Math.ceil(5_000 / (1 - FEE_BPS / 10000)));

  const s = freshStore();
  assert.equal(s.getKioskConfig().config.feeFixedMinor, 30);
  s.setCurrency('KWD');
  assert.equal(s.getKioskConfig().config.feeFixedMinor, 300, 'the tablet shows the total the server will charge');
});

test('rescaleMinor moves minor units between scales, never turning a real amount into nothing', () => {
  assert.equal(rescaleMinor(500, 1), 5_000); //   $5.00 → 5.000 KWD
  assert.equal(rescaleMinor(500, -2), 5); //      $5.00 → ¥5
  assert.equal(rescaleMinor(1_500, -3), 2); //    1.500 KWD → ¥2 (rounded)
  assert.equal(rescaleMinor(100, -3), 1, 'a nonzero bound or threshold stays switched on');
  assert.equal(rescaleMinor(0, -3), 0, '0 means "off" and stays off');
  assert.equal(rescaleMinor(0, 2), 0);
  assert.equal(rescaleMinor(777, 0), 777);
});

test('new campaigns and unsaved giving defaults start in the CURRENT currency’s scale', () => {
  const s = freshStore();
  s.setCurrency('JPY');
  const yen = s.createCampaign({ title: 'Yen appeal' });
  assert.deepEqual(yen.presetsMinor, [5, 10, 20, 50, 100, 250], '¥5…¥250, not ¥500…¥25,000');
  assert.equal(yen.customMinMinor, 1);
  assert.equal(yen.customMaxMinor, 10_000);
  assert.deepEqual(s.getGiving().presetsMinor, [5, 10, 20, 50, 100, 250]);

  s.setCurrency('KWD');
  const dinar = s.createCampaign({ title: 'Dinar appeal' });
  assert.deepEqual(dinar.presetsMinor, [5_000, 10_000, 20_000, 50_000, 100_000, 250_000], '5…250 KWD, not 0.5…25');
  assert.equal(dinar.customMinMinor, 1_000);
  assert.equal(dinar.customMaxMinor, 10_000_000);

  // Dollars, pounds and euros are exactly what they always were.
  s.setCurrency('USD');
  assert.deepEqual(s.createCampaign({ title: 'Dollar appeal' }).presetsMinor, [500, 1000, 2000, 5000, 10000, 25000]);
});

test('changing the currency’s scale rescales every saved amount, so "5" still means five', () => {
  const s = freshStore();
  const main = s.getMainCampaign()!;
  const zakat = s.createCampaign({ title: 'Zakat', presetsMinor: [2_500], customMinMinor: 200, customMaxMinor: 90_000 });
  s.setGiving({ presetsMinor: [500, 1_500], customMinMinor: 100, customMaxMinor: 50_000, largeAmountThresholdMinor: 100_000, celebrateThresholdMinor: 0 });
  const v0 = s.getConfigVersion();

  assert.equal(s.rescaleAmountsForCurrency('USD', 'KWD'), true);
  s.setCurrency('KWD');
  assert.ok(s.getConfigVersion() > v0, 'tablets refetch the new tiles');
  assert.deepEqual(s.getCampaign(main.id)!.presetsMinor, [5_000, 10_000, 20_000, 50_000, 100_000, 250_000]);
  assert.equal(s.getCampaign(main.id)!.customMinMinor, 1_000);
  assert.deepEqual(s.getCampaign(zakat.id)!.presetsMinor, [25_000]);
  assert.equal(s.getCampaign(zakat.id)!.customMaxMinor, 900_000);
  let g = s.getGiving();
  assert.deepEqual(g.presetsMinor, [5_000, 15_000]);
  assert.equal(g.customMinMinor, 1_000);
  assert.equal(g.customMaxMinor, 500_000);
  assert.equal(g.largeAmountThresholdMinor, 1_000_000, 'the large-gift threshold means the same 1,000');
  assert.equal(g.celebrateThresholdMinor, 0, 'an OFF threshold stays off');

  // Down three places: rounded, floored at one, and two tiles that meet become one.
  s.updateCampaign(zakat.id, { presetsMinor: [500, 1_000, 2_000], customMinMinor: 100 }); // 0.5, 1, 2 KWD
  assert.equal(s.rescaleAmountsForCurrency('KWD', 'JPY'), true);
  s.setCurrency('JPY');
  assert.deepEqual(s.getCampaign(zakat.id)!.presetsMinor, [1, 2], '0.5 and 1 KWD both round to ¥1 — one tile, not two');
  assert.equal(s.getCampaign(zakat.id)!.customMinMinor, 1, 'never a zero minimum');
  g = s.getGiving();
  assert.deepEqual(g.presetsMinor, [5, 15]);
  assert.equal(g.largeAmountThresholdMinor, 1_000);

  // Same scale, nothing to do — and nothing is touched.
  const v1 = s.getConfigVersion();
  assert.equal(s.rescaleAmountsForCurrency('JPY', 'KRW'), false);
  assert.equal(s.getConfigVersion(), v1);
  assert.equal(s.rescaleAmountsForCurrency('USD', 'GBP'), false);
});

test('a rescale never double-scales defaults that were never saved, whichever order it runs in', () => {
  // Unsaved giving settings are derived from the defaults in the CURRENT currency on every read, so
  // they follow the currency on their own. Rescaling them as well would multiply twice.
  const before = freshStore(); // rescale, then set
  assert.equal(before.rescaleAmountsForCurrency('USD', 'JPY'), true, 'the seeded main campaign is saved, so it moves');
  before.setCurrency('JPY');
  assert.deepEqual(before.getGiving().presetsMinor, [5, 10, 20, 50, 100, 250]);
  assert.deepEqual(before.getMainCampaign()!.presetsMinor, [5, 10, 20, 50, 100, 250]);

  const after = freshStore(); // set, then rescale — what a route that saves first would do
  after.setCurrency('JPY');
  assert.equal(after.rescaleAmountsForCurrency('USD', 'JPY'), true);
  assert.deepEqual(after.getGiving().presetsMinor, [5, 10, 20, 50, 100, 250]);
  assert.deepEqual(after.getMainCampaign()!.presetsMinor, [5, 10, 20, 50, 100, 250]);
});
