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
  DEFAULT_ROUTE,
  alertEmailLooksValid,
  defaultRoutes,
  isAlertId,
  normalisePhone,
  phoneLooksValid,
  routeSummary,
  sanitizeRoute,
  type AlertRoute,
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
