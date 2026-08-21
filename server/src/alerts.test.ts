// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// WHERE EACH ADMIN ALERT GOES.
//
// Two things are being protected here. The first is that an existing masjid's alerts keep arriving
// after an upgrade, without anyone visiting a new settings screen — which is entirely a question of
// what the DEFAULTS are. The second is that the masjid's WhatsApp number is never used by accident:
// it is their real number, its reputation is what keeps their messages being delivered at all, and
// switching a channel on is a decision a human has to make per alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALERT_IDS,
  ALERT_META,
  alertEmailLooksValid,
  DEFAULT_ROUTE,
  defaultRoutes,
  isAlertId,
  normalisePhone,
  phoneLooksValid,
  routeSummary,
  sanitizeRoute,
  WHATSAPP_MIN_GAP_MS,
  whatsappGate,
  withSuppressedNote,
  type AlertRoute,
  type WhatsAppGateState,
} from './alerts';
import { Store } from './store';

const mem = () => new Store(':memory:');

test('a fresh install emails through OpenMasjidOS and says nothing on WhatsApp', () => {
  // The upgrade contract. Someone relying on reader-offline alerts today must keep getting them
  // tomorrow without touching anything, and must NOT suddenly have their masjid's number in play.
  assert.equal(DEFAULT_ROUTE.os, true);
  assert.equal(DEFAULT_ROUTE.whatsapp, false);
  assert.equal(DEFAULT_ROUTE.email, '');
  assert.equal(DEFAULT_ROUTE.phone, '');

  const routes = defaultRoutes();
  for (const id of ALERT_IDS) {
    assert.equal(routes[id].os, true, `${id} should relay through the platform by default`);
    assert.equal(routes[id].whatsapp, false, `${id} must not WhatsApp by default`);
  }
});

test('the defaults survive a round trip through the database', () => {
  const s = mem();
  const routes = s.getAlertRoutes();
  for (const id of ALERT_IDS) {
    assert.equal(routes[id].os, true, id);
    assert.equal(routes[id].whatsapp, false, id);
  }
});

test('an alert added in a later release arrives at its default, not missing', () => {
  // The saved blob is whatever was written when the admin last pressed something. A new alert id
  // will not be in it, and must come back as "platform on, WhatsApp off" rather than undefined —
  // which would have read as "off" and silently dropped it.
  const s = mem();
  s.setAlertRoute('reader-offline', { os: false, whatsapp: true, phone: '447700900123' });
  const routes = s.getAlertRoutes();
  assert.equal(routes['reader-offline'].os, false, 'the saved one is respected');
  assert.equal(routes['donation-refunded'].os, true, 'an untouched one is still at its default');
  assert.equal(Object.keys(routes).length, ALERT_IDS.length, 'every declared alert is present');
});

test('settings persist exactly as entered', () => {
  const s = mem();
  s.setAlertRoute('donation-refunded', { os: false, email: 'treasurer@masjid.example', whatsapp: true, phone: '+44 7700 900123' });
  const r = s.getAlertRoutes()['donation-refunded'];
  assert.equal(r.os, false);
  assert.equal(r.email, 'treasurer@masjid.example');
  assert.equal(r.whatsapp, true);
  assert.equal(r.phone, '447700900123', 'stored in the form the platform wants');
});

test('the alert ids match manifest.yaml exactly', () => {
  // The platform refuses an alert it was not told about, so a mismatch is an alert that silently
  // never arrives. Parsed rather than hard-coded so adding one to only a single side fails here.
  const manifest = readFileSync(new URL('../../manifest.yaml', import.meta.url), 'utf8');
  const block = manifest.slice(manifest.indexOf('\nalerts:'), manifest.indexOf('\n# Things an authorised admin'));
  const declared = [...block.matchAll(/^\s+- id:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(declared.slice().sort(), [...ALERT_IDS].sort());
  // And every one has admin-facing wording, or the settings screen would show a blank row.
  assert.deepEqual(ALERT_META.map((m) => m.id).sort(), [...ALERT_IDS].sort());
  for (const m of ALERT_META) {
    assert.ok(m.label.trim().length > 0, `${m.id} needs a label`);
    assert.ok(m.description.trim().length > 0, `${m.id} needs a description`);
  }
});

test('isAlertId gates the admin route', () => {
  assert.equal(isAlertId('reader-offline'), true);
  assert.equal(isAlertId('nope'), false);
  assert.equal(isAlertId('__proto__'), false);
  assert.equal(isAlertId(''), false);
});

// ── Phone numbers ────────────────────────────────────────────────────────────

test('a number without a country code is REFUSED, not guessed at', () => {
  // The platform refuses one rather than guessing, and so must we: a UK admin typing 07700 900123
  // means +44, but assuming that would one day message a stranger in another country.
  assert.equal(normalisePhone('07700 900123'), '', 'a national number with a trunk zero');
  assert.equal(normalisePhone('07700900123'), '');
  assert.equal(normalisePhone('555 0123'), '', 'too short to carry a country code');
  assert.equal(phoneLooksValid('07700 900123'), false);
});

test('the usual ways of writing an international number all work', () => {
  assert.equal(normalisePhone('+44 7700 900123'), '447700900123');
  assert.equal(normalisePhone('+447700900123'), '447700900123');
  assert.equal(normalisePhone('447700900123'), '447700900123');
  assert.equal(normalisePhone('+1 (555) 010-1234'), '15550101234');
  assert.equal(normalisePhone('+1-555-010-1234'), '15550101234');
  // 00 is the international access prefix and means the same thing as +.
  assert.equal(normalisePhone('0044 7700 900123'), '447700900123');
});

test('nonsense is rejected rather than silently truncated to digits', () => {
  assert.equal(normalisePhone(''), '');
  assert.equal(normalisePhone('   '), '');
  assert.equal(normalisePhone('not a number'), '');
  assert.equal(normalisePhone('+44 7700 900123 ext 4'), '', 'letters mean this is not a bare number');
  assert.equal(normalisePhone('12345678901234567890'), '', 'longer than E.164 allows');
  assert.equal(normalisePhone('1234567'), '', 'shorter than any country code plus subscriber');
});

test('a refused phone number does not wipe the one already saved', () => {
  // A box that empties itself on a bad save looks like the app lost the number, and the admin
  // retypes the same one. Keep what was there; the route returns 400 and the UI says why.
  const current: AlertRoute = { os: true, email: '', whatsapp: true, phone: '447700900123' };
  const after = sanitizeRoute({ phone: '07700 900123' }, current);
  assert.equal(after.phone, '447700900123');
  // Explicitly clearing it, though, must work.
  assert.equal(sanitizeRoute({ phone: '' }, current).phone, '');
});

// ── Emails ───────────────────────────────────────────────────────────────────

test('the email box accepts an address or nothing, and nothing else', () => {
  assert.equal(alertEmailLooksValid('treasurer@masjid.example'), true);
  assert.equal(alertEmailLooksValid('a@b.co'), true);
  assert.equal(alertEmailLooksValid(''), false);
  assert.equal(alertEmailLooksValid('not-an-email'), false);
  assert.equal(alertEmailLooksValid('two @spaces.com'), false);
  assert.equal(alertEmailLooksValid('no@tld'), false);

  const current: AlertRoute = { os: true, email: 'good@masjid.example', whatsapp: false, phone: '' };
  assert.equal(sanitizeRoute({ email: 'rubbish' }, current).email, 'good@masjid.example', 'a bad address is not saved over a good one');
  assert.equal(sanitizeRoute({ email: '' }, current).email, '', 'but clearing it works');
});

// ── What a route will actually DO ────────────────────────────────────────────

test('"WhatsApp on" with no number is reported as sending nothing', () => {
  // The exact trap this summary exists for: a switch that looks on, a channel that is off. The
  // settings screen shows this so an admin is never told an alert is covered when it is not.
  const s = routeSummary({ os: false, email: '', whatsapp: true, phone: '' });
  assert.equal(s.whatsapp, false);
  assert.equal(s.silent, true, 'and the row is flagged as going nowhere');
});

test('an alert with every channel off is flagged as silent', () => {
  assert.equal(routeSummary({ os: false, email: '', whatsapp: false, phone: '' }).silent, true);
  assert.equal(routeSummary({ os: true, email: '', whatsapp: false, phone: '' }).silent, false);
  assert.equal(routeSummary({ os: false, email: 'a@b.co', whatsapp: false, phone: '' }).silent, false);
  assert.equal(routeSummary({ os: false, email: '', whatsapp: true, phone: '447700900123' }).silent, false);
});

test('the channels are additive — one being on never turns another off', () => {
  // A masjid wanting the platform alert AND a WhatsApp to the caretaker gets both. Nothing here
  // picks a "best" channel, because a channel quietly not firing is the failure that matters.
  const all = routeSummary({ os: true, email: 'a@b.co', whatsapp: true, phone: '447700900123' });
  assert.deepEqual(all, { os: true, email: true, whatsapp: true, silent: false });
});

test('unknown keys in a patch are ignored', () => {
  const current: AlertRoute = { os: true, email: '', whatsapp: false, phone: '' };
  const after = sanitizeRoute({ os: false, nonsense: true, __proto__: { evil: 1 } } as never, current);
  assert.deepEqual(after, { os: false, email: '', whatsapp: false, phone: '' });
});

// ── Pacing WhatsApp ourselves, now that the platform stopped ────────────────
// OpenMasjidOS 0.51.1 removed every limit it used to impose (per-recipient cooldown, hourly and
// daily caps, quiet hours, the warm-up ramp, the random gap). Ban risk still attaches to the phone
// NUMBER, that number is shared by every app on the box, and a blocked number cannot be recovered.
// So these tests are about the one failure in this app nobody can undo.

test('a burst of the same alert sends once and counts the rest', () => {
  // `payment-failed` is the alert that made this necessary: it fires on every PaymentIntent Stripe
  // refuses, so expired keys on a Friday used to mean one message per person who tried to give.
  let st: WhatsAppGateState | undefined;
  const t0 = 1_000_000;
  const first = whatsappGate('payment-failed', st, t0);
  assert.equal(first.send, true, 'the first one always goes');
  st = first.next;

  let sent = 0;
  for (let i = 1; i <= 40; i++) {
    const g = whatsappGate('payment-failed', st, t0 + i * 30_000); // one every 30s for 20 minutes
    if (g.send) sent++;
    st = g.next;
  }
  assert.equal(sent, 0, '40 failures inside the window must not become 40 messages');
  assert.equal(st?.suppressed, 40, 'and every one of them is counted');
});

test('the window reopens, and the next message carries what was held back', () => {
  const t0 = 1_000_000;
  let st = whatsappGate('payment-failed', undefined, t0).next;
  for (let i = 1; i <= 5; i++) st = whatsappGate('payment-failed', st, t0 + i * 60_000).next;
  assert.equal(st.suppressed, 5);

  const after = whatsappGate('payment-failed', st, t0 + WHATSAPP_MIN_GAP_MS + 1);
  assert.equal(after.send, true);
  assert.equal(after.suppressedBefore, 5, 'the next message knows what it stands for');
  assert.equal(after.next.suppressed, 0, 'and the count resets once it has been reported');

  const note = withSuppressedNote('The card reader is offline.', after.suppressedBefore);
  assert.match(note, /5 more alerts/);
  assert.match(note, /held back/i);
  // Suppression must never be silent: the reader has to be able to tell there were others.
  assert.notEqual(note, 'The card reader is offline.');
});

test('a single alert is never annotated', () => {
  assert.equal(withSuppressedNote('The card reader is offline.', 0), 'The card reader is offline.');
});

test('the test message is never throttled', () => {
  // An admin pressed a button and is watching the screen. Throttling it makes the button look broken.
  let st: WhatsAppGateState | undefined;
  for (let i = 0; i < 5; i++) {
    const g = whatsappGate('test', st, 1_000_000 + i * 1_000);
    assert.equal(g.send, true, `press ${i + 1} must send`);
    st = g.next;
  }
});

test('alerts are paced independently of one another', () => {
  // A reader going offline must not be swallowed because Stripe was failing a minute earlier.
  const t0 = 1_000_000;
  const a = whatsappGate('payment-failed', undefined, t0);
  const b = whatsappGate('reader-offline', undefined, t0 + 1_000);
  assert.equal(a.send, true);
  assert.equal(b.send, true, 'a different alert has its own window');
});

test('the gap is long enough to matter and short enough to be useful', () => {
  // Documented as a real decision rather than a magic number: half an hour is long enough that a
  // sustained outage cannot spend the number, and short enough that a caretaker hears about a
  // genuinely new problem within one prayer.
  assert.ok(WHATSAPP_MIN_GAP_MS >= 10 * 60_000, 'too short to protect the number');
  assert.ok(WHATSAPP_MIN_GAP_MS <= 60 * 60_000, 'too long and a real outage goes unreported');
});

test('a fresh process always sends the first alert, whatever the clock says', () => {
  // Regression: "never sent" used to be encoded as lastSentAt:0 and decided by subtraction, which is
  // only correct because Date.now() happens to be far larger than the window. Right by luck.
  for (const now of [1, 1_000, 60_000, 1_000_000, Date.now()]) {
    assert.equal(whatsappGate('payment-failed', undefined, now).send, true, `now=${now}`);
    assert.equal(whatsappGate('reader-offline', { lastSentAt: 0, suppressed: 3 }, now).send, true, `stale zero, now=${now}`);
  }
});
