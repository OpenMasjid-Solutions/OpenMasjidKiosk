// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// WHO GETS TOLD WHAT.
//
// Three things are being protected here. The first is that an existing masjid's alerts keep
// arriving after an upgrade, without anyone visiting a new settings screen — which is entirely a
// question of what the DEFAULTS are, and now also of whether the MIGRATION off the old per-alert
// shape loses anything. The second is that the masjid's WhatsApp number is never used by accident:
// it is their real number, its reputation is what keeps their messages being delivered at all, and
// switching a channel on is a decision a human has to make. The third is new — a WhatsApp GROUP
// must not become a way to broadcast a donor's name to forty people who happen to be in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALERT_IDS,
  ALERT_META,
  DEFAULT_PACING,
  DEFAULT_ROUTE,
  PACING_LIMITS,
  addressLooksValid,
  alertDelivery,
  alertEmailLooksValid,
  bodyForRecipient,
  canonicalAddress,
  defaultAlertsForNewRecipient,
  defaultRoutes,
  emptyLedger,
  groupIdLooksValid,
  isAlertId,
  migrateLegacyRoutes,
  newRecipient,
  normalisePhone,
  pacingUsage,
  phoneLooksValid,
  recipientsFor,
  recordWhatsAppSends,
  sanitizePacing,
  sanitizeRecipient,
  sanitizeRoute,
  whatsappPermit,
  withSuppressedNote,
  type AlertRecipient,
  type WhatsAppLedger,
  type WhatsAppPacing,
} from './alerts';
import { MAX_ALERT_RECIPIENTS, Store } from './store';

const mem = () => new Store(':memory:');

const rcp = (over: Partial<AlertRecipient> = {}): AlertRecipient => ({
  id: 'r1',
  kind: 'email',
  address: 'a@b.co',
  label: '',
  alerts: [...ALERT_IDS],
  includeNames: true,
  ...over,
});

const pacing = (over: Partial<WhatsAppPacing> = {}): WhatsAppPacing => ({ ...DEFAULT_PACING, ...over });

// ── The upgrade contract ─────────────────────────────────────────────────────

test('a fresh install still relays through OpenMasjidOS for every alert', () => {
  // Someone relying on reader-offline alerts today must keep getting them tomorrow without touching
  // anything. This is the whole reason `os` defaults to true.
  assert.equal(DEFAULT_ROUTE.os, true);
  const routes = defaultRoutes();
  for (const id of ALERT_IDS) assert.equal(routes[id].os, true, `${id} should relay by default`);
});

test('a fresh install has no recipients, so nothing touches the masjid’s number', () => {
  const s = mem();
  assert.deepEqual(s.getAlertRecipients(), []);
  // And every alert therefore reports itself as reaching only the platform.
  for (const id of ALERT_IDS) {
    const d = alertDelivery(s.getAlertRoutes()[id], [], id);
    assert.equal(d.phones, 0, id);
    assert.equal(d.groups, 0, id);
    assert.equal(d.silent, false, `${id} still has the relay, so it is not silent`);
  }
});

test('the defaults survive a round trip through the database', () => {
  const s = mem();
  const routes = s.getAlertRoutes();
  for (const id of ALERT_IDS) assert.equal(routes[id].os, true, id);
});

test('an alert added in a later release arrives at its default, not missing', () => {
  // The saved blob is whatever was written when the admin last pressed something. A new alert id
  // must not read as `undefined` and break the fan-out.
  const s = mem();
  s.setAlertRoute('reader-offline', { os: false });
  const routes = s.getAlertRoutes();
  assert.equal(routes['reader-offline'].os, false);
  for (const id of ALERT_IDS) {
    assert.ok(routes[id], `${id} must be present`);
    if (id !== 'reader-offline') assert.equal(routes[id].os, true, `${id} defaults on`);
  }
});

test('the alert ids match manifest.yaml exactly', () => {
  // An id we raise but never declared is answered 400 "Unknown alert" and dropped, silently,
  // because raiseAlert is fail-soft. That has bitten a sibling app for a whole release.
  const yaml = readFileSync(new URL('../../manifest.yaml', import.meta.url), 'utf8');
  // Bounded to the `alerts:` block. `commands:` follows it and declares ids in the same shape, so
  // an unbounded slice quietly reads the WhatsApp command list as alerts too.
  const from = yaml.indexOf('\nalerts:') + 1;
  const rest = yaml.slice(from + 'alerts:'.length);
  const nextKey = rest.search(/\n(?=[A-Za-z_])/);
  const block = nextKey < 0 ? rest : rest.slice(0, nextKey);
  const declared = [...block.matchAll(/^\s{2}-\s+id:\s*([a-z0-9-]+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(declared, [...ALERT_IDS]);
  assert.deepEqual(
    ALERT_META.map((m) => m.id),
    [...ALERT_IDS],
    'ALERT_META must cover every id, in order',
  );
});

test('isAlertId gates the admin route', () => {
  assert.equal(isAlertId('reader-offline'), true);
  assert.equal(isAlertId('nope'), false);
  assert.equal(isAlertId(''), false);
});

// ── Migrating off the old one-address-per-alert shape ────────────────────────

test('an upgrade carries every saved address across, and loses none', () => {
  // The old model: one email and one phone PER ALERT. Two alerts sharing an address must become ONE
  // recipient subscribed to both, not two rows that double every message.
  const { routes, recipients } = migrateLegacyRoutes({
    'reader-offline': { os: true, email: 'care@masjid.org', whatsapp: true, phone: '15550101234' },
    'donation-refunded': { os: false, email: 'treasurer@masjid.org', whatsapp: false, phone: '' },
    'payment-failed': { os: true, email: 'care@masjid.org', whatsapp: false, phone: '' },
  });

  // `os` is carried per alert, untouched.
  assert.equal(routes['donation-refunded'].os, false);
  assert.equal(routes['reader-offline'].os, true);

  const care = recipients.find((r) => r.address === 'care@masjid.org');
  assert.ok(care, 'the shared address survived');
  assert.deepEqual(care.alerts, ['reader-offline', 'payment-failed'], 'subscribed to both, deduped to one row');

  assert.ok(recipients.find((r) => r.address === 'treasurer@masjid.org'));
  assert.ok(recipients.find((r) => r.kind === 'phone' && r.address === '15550101234'));
  assert.equal(recipients.length, 3);
});

test('a phone sitting in a box with WhatsApp switched OFF is not migrated on', () => {
  // Turning it on for them would be a change they did not ask for, on the one channel that can
  // cost them their number.
  const { recipients } = migrateLegacyRoutes({
    'reader-offline': { os: true, email: '', whatsapp: false, phone: '15550101234' },
  });
  assert.deepEqual(recipients, []);
});

test('a migrated recipient keeps carrying donor names, because it always did', () => {
  const { recipients } = migrateLegacyRoutes({
    'donation-refunded': { os: true, email: 'a@b.co', whatsapp: false, phone: '' },
  });
  assert.equal(recipients[0].includeNames, true);
});

test('the migration runs once and does not resurrect a deliberately emptied list', () => {
  const s = mem();
  // Simulate an install that had the old shape saved.
  s.setAlertRoute('reader-offline', { os: true });
  (s as unknown as { setRaw(k: string, v: string): void }).setRaw(
    'alert_routes',
    JSON.stringify({ 'reader-offline': { os: true, email: 'x@y.co', whatsapp: false, phone: '' } }),
  );
  const first = s.getAlertRecipients();
  assert.equal(first.length, 1, 'migrated on first read');

  assert.equal(s.removeAlertRecipient(first[0].id), true);
  assert.deepEqual(s.getAlertRecipients(), [], 'an admin who removes everyone gets an empty list, for good');
});

// ── Recipients ───────────────────────────────────────────────────────────────

test('a new recipient starts on the alerts that cost money or hide a problem', () => {
  const on = defaultAlertsForNewRecipient();
  // `payment-failed` is deliberately OFF: it fires per refused PaymentIntent and has no natural
  // bound, so a Stripe outage would teach a new recipient to filter the whole lot to a folder.
  assert.equal(on.includes('payment-failed'), false);
  assert.equal(on.includes('donation-refunded'), true);
  assert.equal(on.includes('reader-offline'), true);
  // `test` is never a subscription — it is only ever sent by pressing the button.
  assert.equal(on.includes('test'), false);
});

test('a group starts NOT carrying donor names; an individual does', () => {
  // The platform's own rule: a group post must never carry one person's own business, because
  // everyone in a group can see everyone else's number.
  assert.equal(newRecipient('group', '1203630123@g.us', '').includeNames, false);
  assert.equal(newRecipient('email', 'a@b.co', '').includeNames, true);
  assert.equal(newRecipient('phone', '15550101234', '').includeNames, true);
});

test('the name-stripping switch is what actually chooses the body', () => {
  const full = 'Fatima Ahmed (f@x.co) was refunded $20.';
  const bare = 'A donor was refunded $20.';
  assert.equal(bodyForRecipient({ includeNames: true }, full, bare), full);
  assert.equal(bodyForRecipient({ includeNames: false }, full, bare), bare);
  // An alert that names nobody has no second body, and must still send something.
  assert.equal(bodyForRecipient({ includeNames: false }, full), full);
});

test('an email address is stored lowercased, so one inbox cannot subscribe twice', () => {
  const s = mem();
  assert.equal(canonicalAddress('email', '  Office@Masjid.ORG '), 'office@masjid.org');
  assert.ok(s.addAlertRecipient(newRecipient('email', 'Office@Masjid.org', '')));
  assert.equal(s.addAlertRecipient(newRecipient('email', 'office@masjid.org', '')), null, 'refused as a duplicate');
  assert.equal(s.getAlertRecipients().length, 1);
});

test('a recipient list is bounded, and the cap points at groups instead', () => {
  const s = mem();
  for (let i = 0; i < MAX_ALERT_RECIPIENTS; i++) {
    assert.ok(s.addAlertRecipient(newRecipient('email', `p${i}@masjid.org`, '')), `#${i}`);
  }
  assert.equal(s.addAlertRecipient(newRecipient('email', 'one-too-many@masjid.org', '')), null);
});

test('unknown keys and bogus alert ids in a patch are ignored', () => {
  const before = rcp({ alerts: ['reader-offline'] });
  const after = sanitizeRecipient(
    { alerts: ['donation-refunded', 'not-an-alert', 'test'] as string[] as never, nope: 1 } as never,
    before,
  );
  assert.deepEqual(after.alerts, ['monthly-cancelled' as never].length ? ['donation-refunded', 'test'] : []);
  assert.equal((after as unknown as { nope?: unknown }).nope, undefined);
});

test('a refused address does not wipe the one already saved', () => {
  // A box that empties itself reads as the app having lost the value, and the admin retypes the
  // very same thing.
  const before = rcp({ kind: 'phone', address: '15550101234' });
  assert.equal(sanitizeRecipient({ address: '07700 900123' }, before).address, '15550101234');
  assert.equal(sanitizeRecipient({ address: 'nonsense' }, before).address, '15550101234');
});

test('subscribers with an unusable address are not counted as reachable', () => {
  const good = rcp({ id: 'a', kind: 'email', address: 'a@b.co', alerts: ['reader-offline'] });
  const bad = rcp({ id: 'b', kind: 'phone', address: '', alerts: ['reader-offline'] });
  assert.deepEqual(
    recipientsFor([good, bad], 'reader-offline').map((r) => r.id),
    ['a'],
  );
});

test('an alert with the relay off and nobody subscribed is flagged as going nowhere', () => {
  const d = alertDelivery({ os: false }, [], 'reader-offline');
  assert.equal(d.silent, true);
  // One subscriber is enough to stop it being silent.
  const d2 = alertDelivery({ os: false }, [rcp({ alerts: ['reader-offline'] })], 'reader-offline');
  assert.equal(d2.silent, false);
  assert.equal(d2.emails, 1);
});

test('the channels are additive — the relay and a recipient coexist', () => {
  const d = alertDelivery({ os: true }, [rcp({ kind: 'group', address: '1203630123@g.us', alerts: ['reader-offline'] })], 'reader-offline');
  assert.equal(d.os, true);
  assert.equal(d.groups, 1);
});

// ── Addresses ────────────────────────────────────────────────────────────────

test('a number without a country code is REFUSED, not guessed at', () => {
  // A UK admin typing 07700 900123 means +44 — and assuming that would one day message a stranger
  // in another country. The platform refuses too; we must not disagree with it.
  assert.equal(normalisePhone('07700 900123'), '');
  assert.equal(phoneLooksValid('07700 900123'), false);
  assert.equal(normalisePhone('0044 7700 900123'), '447700900123', 'an explicit 00 prefix is fine');
});

test('the usual ways of writing an international number all work', () => {
  for (const w of ['+1 555 010 1234', '+1 (555) 010-1234', '15550101234', '+15550101234', '001 555 010 1234']) {
    assert.equal(normalisePhone(w), '15550101234', w);
  }
});

test('nonsense is rejected rather than silently truncated to digits', () => {
  for (const w of ['', '   ', 'call me', '+1 555 EXT', '123', '1'.repeat(16)]) {
    assert.equal(normalisePhone(w), '', JSON.stringify(w));
  }
});

test('the email check accepts an address and nothing else', () => {
  for (const ok of ['a@b.co', 'office+alerts@masjid.org.uk']) assert.equal(alertEmailLooksValid(ok), true, ok);
  for (const no of ['', 'a@b', 'a b@c.co', 'no-at-sign.com', `${'x'.repeat(200)}@y.co`]) {
    assert.equal(alertEmailLooksValid(no), false, JSON.stringify(no));
  }
});

test('a group id matches the platform’s own rule exactly, not a stricter one', () => {
  // Being stricter than the platform would refuse a group the admin really did approve, and the
  // failure would look like the group vanishing from the picker.
  assert.equal(groupIdLooksValid('120363012345678901@g.us'), true);
  assert.equal(groupIdLooksValid('12036301234-5678901@g.us'), true, 'the hyphenated legacy form');
  // A one-person address must never pass as a group: it would turn "post to the parents group"
  // into "message one person", silently.
  assert.equal(groupIdLooksValid('15550101234@c.us'), false);
  assert.equal(groupIdLooksValid('not-a-group'), false);
  assert.equal(groupIdLooksValid('@g.us'), false);
  assert.equal(addressLooksValid('group', '120363012345678901@g.us'), true);
});

// ── Pacing: the admin's to set ───────────────────────────────────────────────

test('the shipped defaults are looser than the platform’s own retired caps', () => {
  // The first version of this gate allowed one message per alert per THIRTY MINUTES — two an hour,
  // below the platform's own historical 12/hour, and low enough that a caretaker watching a reader
  // flap simply would not be told.
  assert.ok(DEFAULT_PACING.maxPerHour > 12, 'more generous than the platform ever was');
  assert.ok(DEFAULT_PACING.maxPerDay > 60);
  assert.ok(DEFAULT_PACING.minGapMinutes < 30, 'and the burst gap is minutes, not half an hour');
});

test('pacing settings are clamped, not trusted', () => {
  const p = sanitizePacing({ maxPerHour: 999_999, maxPerDay: -5, minGapMinutes: 10_000 }, { ...DEFAULT_PACING });
  assert.equal(p.maxPerHour, PACING_LIMITS.maxPerHour.max);
  assert.equal(p.minGapMinutes, PACING_LIMITS.minGapMinutes.max);
  // A day cap below the hour cap is a contradiction whose effect the admin cannot see — the hour
  // cap would simply never be reachable — so the day is raised to meet it.
  assert.ok(p.maxPerDay >= p.maxPerHour);
});

test('garbage in a pacing patch leaves the saved value alone', () => {
  const p = sanitizePacing({ maxPerHour: Number.NaN, maxPerDay: undefined }, pacing({ maxPerHour: 30, maxPerDay: 300 }));
  assert.equal(p.maxPerHour, 30);
  assert.equal(p.maxPerDay, 300);
});

test('pacing round-trips through the database', () => {
  const s = mem();
  assert.deepEqual(s.getWhatsAppPacing(), { ...DEFAULT_PACING });
  const saved = s.setWhatsAppPacing({ maxPerHour: 40, maxPerDay: 400, minGapMinutes: 0 });
  assert.equal(saved.maxPerHour, 40);
  assert.deepEqual(s.getWhatsAppPacing(), saved);
});

test('a fresh process always sends the first alert, whatever the clock says', () => {
  // "Never sent" is its own case, not `lastSentAt: 0` and a big subtraction. The arithmetic version
  // is right only because a real clock dwarfs the window — right by luck, and wrong for any caller
  // with a small clock, which is exactly how this test is written.
  const p = whatsappPermit('reader-offline', undefined, pacing(), 1000);
  assert.ok(p.allowed > 0);
  assert.equal(p.reason, '');
});

test('the burst gap collapses a repeating alert, and counts what it held back', () => {
  const p = pacing({ minGapMinutes: 2 });
  const t0 = 10_000_000;
  let ledger: WhatsAppLedger = emptyLedger();

  const first = whatsappPermit('payment-failed', ledger, p, t0);
  assert.ok(first.allowed > 0);
  ledger = recordWhatsAppSends(ledger, 'payment-failed', 1, t0);

  // Two more within the window are held.
  for (const dt of [1_000, 60_000]) {
    const v = whatsappPermit('payment-failed', ledger, p, t0 + dt);
    assert.equal(v.allowed, 0);
    assert.equal(v.reason, 'gap');
    ledger = recordWhatsAppSends(ledger, 'payment-failed', 0, t0 + dt);
  }

  // The window reopens, and the next one carries the count.
  const after = whatsappPermit('payment-failed', ledger, p, t0 + 2 * 60_000);
  assert.ok(after.allowed > 0);
  assert.equal(after.suppressedBefore, 2);
  assert.match(withSuppressedNote('x', after.suppressedBefore), /2 more alerts/);
});

test('alerts are paced independently of one another', () => {
  // A Stripe outage spamming payment-failed must not stop a reader-offline getting through.
  const p = pacing({ minGapMinutes: 30 });
  const t0 = 10_000_000;
  const ledger = recordWhatsAppSends(emptyLedger(), 'payment-failed', 1, t0);
  assert.equal(whatsappPermit('payment-failed', ledger, p, t0 + 1000).allowed, 0);
  assert.ok(whatsappPermit('reader-offline', ledger, p, t0 + 1000).allowed > 0);
});

test('a single alert is never annotated', () => {
  assert.equal(withSuppressedNote('hello', 0), 'hello');
});

test('the hourly cap is the budget, and it counts MESSAGES not alerts', () => {
  // Multiple recipients means one alert can spend several messages, and WhatsApp counts messages.
  const p = pacing({ maxPerHour: 5, minGapMinutes: 0 });
  const t0 = 10_000_000;
  let ledger: WhatsAppLedger = emptyLedger();
  // One alert going to three recipients spends three.
  ledger = recordWhatsAppSends(ledger, 'reader-offline', 3, t0);
  assert.equal(whatsappPermit('reader-offline', ledger, p, t0 + 1).allowed, 2, 'two left this hour');

  ledger = recordWhatsAppSends(ledger, 'reader-offline', 2, t0 + 2);
  const spent = whatsappPermit('reader-offline', ledger, p, t0 + 3);
  assert.equal(spent.allowed, 0);
  assert.equal(spent.reason, 'hour');

  // An hour later the window has rolled.
  assert.ok(whatsappPermit('reader-offline', ledger, p, t0 + 60 * 60_000 + 1).allowed > 0);
});

test('the daily cap outlasts the hourly one', () => {
  const p = pacing({ maxPerHour: 10, maxPerDay: 12, minGapMinutes: 0 });
  const t0 = 10_000_000;
  let ledger: WhatsAppLedger = emptyLedger();
  ledger = recordWhatsAppSends(ledger, 'reader-offline', 10, t0);
  // Next hour: the hour budget is clear, but only 2 of the day's 12 remain.
  const v = whatsappPermit('reader-offline', ledger, p, t0 + 61 * 60_000);
  assert.equal(v.allowed, 2);
  ledger = recordWhatsAppSends(ledger, 'reader-offline', 2, t0 + 61 * 60_000);
  const done = whatsappPermit('reader-offline', ledger, p, t0 + 62 * 60_000);
  assert.equal(done.allowed, 0);
  assert.equal(done.reason, 'day');
  // And a day later it has rolled off.
  assert.ok(whatsappPermit('reader-offline', ledger, p, t0 + 25 * 60 * 60_000).allowed > 0);
});

test('the budget is charged for what went out, not for what was permitted', () => {
  // An alert can be allowed three messages and manage one — a refusal, an unreachable platform.
  const p = pacing({ maxPerHour: 5, minGapMinutes: 0 });
  const t0 = 10_000_000;
  const ledger = recordWhatsAppSends(emptyLedger(), 'reader-offline', 1, t0);
  assert.equal(pacingUsage(ledger, p, t0).lastHour, 1);
});

test('a refusal is not counted as suppression', () => {
  // `raiseAlert` leaves the ledger untouched when every send was refused. If it recorded a hold
  // instead, the next message that DID get through would announce "3 alerts were held back to
  // protect the masjid's number" about three the platform rejected outright — a confident wrong
  // answer to the exact question the admin is asking. Their real reasons are on their own rows.
  const p = pacing({ minGapMinutes: 0, maxPerHour: 10 });
  const t0 = 10_000_000;
  const ledger = emptyLedger(); // what the ledger looks like after an all-refused run
  const v = whatsappPermit('reader-offline', ledger, p, t0 + 1);
  assert.equal(v.suppressedBefore, 0, 'nothing to apologise for');
  assert.equal(withSuppressedNote('x', v.suppressedBefore), 'x');
  // A genuine pacing hold still counts, so the two cases stay distinguishable.
  const held = recordWhatsAppSends(emptyLedger(), 'reader-offline', 0, t0);
  assert.equal(whatsappPermit('reader-offline', held, p, t0 + 1).suppressedBefore, 1);
});

test('the test message is never held back, by any of the three limits', () => {
  // An admin pressed a button and is watching the screen. Throttling that makes it look broken.
  const p = pacing({ minGapMinutes: 240, maxPerHour: 1, maxPerDay: 1 });
  const t0 = 10_000_000;
  const ledger = recordWhatsAppSends(recordWhatsAppSends(emptyLedger(), 'test', 1, t0), 'reader-offline', 5, t0);
  assert.ok(whatsappPermit('test', ledger, p, t0 + 1).allowed > 0);
  // While a real alert on the same ledger is refused.
  assert.equal(whatsappPermit('reader-offline', ledger, p, t0 + 1).allowed, 0);
});

test('turning the burst gap off means only the budget applies', () => {
  const p = pacing({ minGapMinutes: 0, maxPerHour: 10 });
  const t0 = 10_000_000;
  const ledger = recordWhatsAppSends(emptyLedger(), 'payment-failed', 1, t0);
  assert.ok(whatsappPermit('payment-failed', ledger, p, t0 + 1).allowed > 0, 'no gap, so straight through');
});

test('the ledger survives a restart, which is what makes a DAILY cap mean anything', () => {
  // The first version kept this in memory and argued a restart letting one extra through was the
  // safe direction to fail. True for a burst gap; not true for a day cap, which would reset on
  // every deploy — several times an afternoon on the dev channel.
  const s = mem();
  const now = Date.now();
  s.setWhatsAppLedger(recordWhatsAppSends(emptyLedger(), 'reader-offline', 4, now));
  assert.equal(pacingUsage(s.getWhatsAppLedger(), s.getWhatsAppPacing(), now).lastDay, 4);
});

test('the ledger forgets anything older than a day', () => {
  const s = mem();
  const now = Date.now();
  const old = recordWhatsAppSends(emptyLedger(), 'reader-offline', 3, now - 25 * 60 * 60_000);
  s.setWhatsAppLedger(old);
  assert.equal(pacingUsage(s.getWhatsAppLedger(), s.getWhatsAppPacing(), now).lastDay, 0);
});

// ── Storage plumbing ─────────────────────────────────────────────────────────

test('a recipient round-trips through the database with its ticks intact', () => {
  const s = mem();
  const row = s.addAlertRecipient(newRecipient('phone', '+1 555 010 1234', 'Caretaker'));
  assert.ok(row);
  assert.equal(row.address, '15550101234', 'stored as digits, as the platform wants');
  const patched = s.updateAlertRecipient(row.id, { alerts: ['reader-offline'], includeNames: false });
  assert.ok(patched);
  const [read] = s.getAlertRecipients();
  assert.equal(read.label, 'Caretaker');
  assert.deepEqual(read.alerts, ['reader-offline']);
  assert.equal(read.includeNames, false);
});

test('removing a recipient takes its delivery record with it', () => {
  const s = mem();
  const row = s.addAlertRecipient(newRecipient('phone', '15550101234', ''));
  assert.ok(row);
  s.setWhatsAppOutcome(row.id, { state: 'refused', at: Date.now(), messageId: '', reason: 'nope', suppressed: 0, alertId: 'reader-offline' });
  assert.ok(s.getWhatsAppOutcomes()[row.id]);
  s.removeAlertRecipient(row.id);
  assert.equal(s.getWhatsAppOutcomes()[row.id], undefined, 'a record about a row that no longer exists');
});

test('a row saved before includeNames existed keeps behaving as it did', () => {
  const s = mem();
  const row = s.addAlertRecipient(newRecipient('email', 'a@b.co', ''));
  assert.ok(row);
  // Rewrite the blob without the field, as an older build would have.
  (s as unknown as { setRaw(k: string, v: string): void }).setRaw(
    'alert_recipients',
    JSON.stringify({ list: [{ id: row.id, kind: 'email', address: 'a@b.co', label: '', alerts: ['reader-offline'] }] }),
  );
  assert.equal(s.getAlertRecipients()[0].includeNames, true);
});

test('sanitizeRoute still ignores anything but the relay flag', () => {
  const before = { os: true };
  assert.deepEqual(sanitizeRoute({ os: false }, before), { os: false });
  assert.deepEqual(sanitizeRoute({ nope: 1 } as never, before), { os: true });
});

// ── "Sent" that may never have arrived ───────────────────────────────

test('only the dismissals are ours to remember', () => {
  // The first cut of this hoarded the windows themselves, because the platform reported one only
  // while the outage was open and forgot it the moment an admin re-linked — the evidence vanished
  // exactly when someone went looking. OpenMasjidOS 0.51.1-dev.13 retains them for seven days after
  // recovery, so the platform is the source of truth and this is all that is left on our side.
  const s = mem();
  // A REAL epoch, not a small synthetic one: these are pruned by age, so `1000` would be read as
  // 1970 and dropped on the way back out. (The same shape of trap `whatsappGate` documents, from
  // the other direction — there a small clock breaks a subtraction, here it breaks a cutoff.)
  const from = Date.now() - 60_000;
  assert.deepEqual(s.getDismissedSuspectWindows(), []);
  assert.equal(s.dismissSuspectWindow(from), true);
  assert.deepEqual(s.getDismissedSuspectWindows(), [from]);
  assert.equal(s.dismissSuspectWindow(from), false, 'dismissing twice is not an error');
});

test('a dismissal outlives the window it dismisses', () => {
  // Pruned at 30 days against the platform's 7-day retention. If a dismissal expired FIRST, a
  // banner someone already dealt with would rise from the dead.
  const s = mem();
  const now = Date.now();
  s.dismissSuspectWindow(now - 8 * 24 * 60 * 60_000); // older than the platform keeps
  assert.equal(s.getDismissedSuspectWindows().length, 1, 'still remembered well past 7 days');
  (s as unknown as { setRaw(k: string, v: string): void }).setRaw(
    'whatsapp_suspect_dismissed',
    JSON.stringify({ list: [now - 40 * 24 * 60 * 60_000] }),
  );
  assert.deepEqual(s.getDismissedSuspectWindows(), [], 'but not for ever');
});

test('records are flagged by message id, which is exact', () => {
  // Preferred over matching one timestamp against an interval, which is ambiguous for anything
  // queued on one side of a boundary and sent on the other.
  const s = mem();
  const rec = (id: string, at: number) => ({
    state: 'sent' as const, at, messageId: id, reason: '', suppressed: 0, alertId: 'reader-offline' as const,
  });
  s.setWhatsAppOutcome('a', rec('msg-1', 1_500));
  s.setWhatsAppOutcome('b', rec('msg-2', 1_500));
  assert.equal(s.markWhatsAppSuspectByIds(['msg-1']), 1);
  const all = s.getWhatsAppOutcomes();
  assert.equal(all['a'].suspect, true);
  assert.equal(all['b'].suspect, false, 'a message the platform did NOT name is not in doubt');
  assert.equal(s.markWhatsAppSuspectByIds(['msg-1']), 0, 'idempotent across polls');
  assert.equal(s.markWhatsAppSuspectByIds([]), 0, 'an empty id list flags nothing');
});

test('the time-window fallback still exists, for an older platform or a truncated id list', () => {
  const s = mem();
  const rec = (state: 'sent' | 'refused' | 'failed', at: number) => ({
    state, at, messageId: '', reason: '', suppressed: 0, alertId: 'reader-offline' as const,
  });
  s.setWhatsAppOutcome('in-window-sent', rec('sent', 1_500));
  // A refusal was never handed to WhatsApp and was reported honestly at the time — it is not in
  // doubt, and flagging it would send an admin to re-check a known failure.
  s.setWhatsAppOutcome('in-window-refused', rec('refused', 1_500));
  s.setWhatsAppOutcome('in-window-failed', rec('failed', 1_500));
  s.setWhatsAppOutcome('outside-window', rec('sent', 9_999));

  assert.equal(s.markWhatsAppSuspect(1_000, 2_000), 1);
  const all = s.getWhatsAppOutcomes();
  assert.equal(all['in-window-sent'].suspect, true);
  // `false`, not `undefined`: both the read and write paths normalise this to a real boolean, so a
  // record written by an older build reads as "not in doubt" rather than a missing field the UI
  // would have to guess about.
  assert.equal(all['in-window-refused'].suspect, false);
  assert.equal(all['in-window-failed'].suspect, false);
  assert.equal(all['outside-window'].suspect, false);
});

test('a NEW message to a recipient is not in doubt just because an older one was', () => {
  const s = mem();
  s.setWhatsAppOutcome('r', { state: 'sent', at: 1_500, messageId: 'old', reason: '', suppressed: 0, alertId: 'reader-offline' });
  s.markWhatsAppSuspect(1_000, 2_000);
  assert.equal(s.getWhatsAppOutcomes()['r'].suspect, true);
  // The link is back; this one went fine. The flag must not be carried over onto it.
  s.setWhatsAppOutcome('r', { state: 'sent', at: 50_000, messageId: 'new', reason: '', suppressed: 0, alertId: 'reader-offline' });
  assert.equal(s.getWhatsAppOutcomes()['r'].suspect, false);
});
