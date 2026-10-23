// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// DO THE PANEL AND THE EMAIL SHOW THE SAME DATE AND THE SAME AMOUNT?
//
// Dates and money are formatted in two places — the admin panel (web/src/dates.ts, money.ts) and the
// server (server/src/dates.ts, money.ts) for receipts, the CSV and WhatsApp replies. A trustee reads
// both, so they must agree to the character. This runs both over the same inputs.
//
// It also pins the three bugs this pair replaced:
//   · the receipt formatter combined `dateStyle` with `timeZoneName`, which throws — every receipt
//     ever sent printed a raw ISO timestamp;
//   · every date was in the container's zone (UTC), so an evening gift in Chicago was dated tomorrow;
//   · the server let ICU pick a currency's decimals, printing a Rs 25.50 gift as "PKR 26".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from './dates';
import { formatMoney as serverMoney } from './money';
import * as W from '../../web/src/dates';
import { formatMoney as webMoney } from '../../web/src/money';
import { setClock } from '../../web/src/locale';

const CLOCKS: S.ClockSettings[] = [
  { timeZone: 'America/Chicago', clock24h: false, hijriOffset: 0, locale: 'en-US' },
  { timeZone: 'Europe/London', clock24h: true, hijriOffset: 1, locale: 'en-GB' },
  { timeZone: 'Asia/Karachi', clock24h: false, hijriOffset: -1, locale: 'en-PK' },
  { timeZone: 'Asia/Kuwait', clock24h: true, hijriOffset: 0, locale: 'en-KW' },
  { timeZone: 'Australia/Sydney', clock24h: false, hijriOffset: 2, locale: 'en-AU' },
];
const INSTANTS = ['2026-09-30T23:30:00Z', '2026-03-29T00:30:00Z', '2026-11-01T06:59:59Z', '2027-01-01T00:00:00Z', '2026-02-18T12:00:00Z'];

test('the panel and the server format every date identically', () => {
  for (const c of CLOCKS) {
    for (const t of INSTANTS) {
      assert.equal(W.formatDate(t, c), S.formatDate(t, c), `formatDate ${t} ${c.timeZone}`);
      assert.equal(W.formatDateTime(t, c), S.formatDateTime(t, c), `formatDateTime ${t} ${c.timeZone}`);
      assert.equal(W.formatTime(t, c), S.formatTime(t, c), `formatTime ${t} ${c.timeZone}`);
      assert.equal(W.hijriDate(t, c), S.hijriDate(t, c), `hijriDate ${t} ${c.timeZone}`);
    }
    assert.equal(W.formatCalendarDate('2026-07-01', c), S.formatCalendarDate('2026-07-01', c));
  }
});

test('a date is Gregorian AND Hijri, never an ISO timestamp', () => {
  const c = CLOCKS[0];
  const out = S.formatDateTime('2026-09-30T18:03:11.123Z', c);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(out), `looks like ISO: ${out}`);
  assert.match(out, / · .*AH$/, `no Hijri half: ${out}`);
  assert.equal(out, 'Sep 30, 2026, 1:03 PM · Rabiʻ II 19, 1448 AH');
});

test('the masjid’s zone decides the day, not the container’s', () => {
  // 23:30 UTC on the 30th is 6:30 PM on the 30th in Chicago, and 00:30 on the 1st in London.
  assert.match(S.formatDate('2026-09-30T23:30:00Z', CLOCKS[0]), /^Sep 30, 2026/);
  assert.match(S.formatDate('2026-09-30T23:30:00Z', CLOCKS[1]), /^1 Oct 2026/);
});

test('the 12/24-hour choice is honoured, each written the way it is read', () => {
  assert.equal(S.formatTime('2026-09-30T14:05:00Z', { ...CLOCKS[1], timeZone: 'UTC' }), '14:05');
  assert.equal(S.formatTime('2026-09-30T00:30:00Z', { ...CLOCKS[1], timeZone: 'UTC' }), '00:30');
  assert.equal(S.formatTime('2026-09-30T14:05:00Z', { ...CLOCKS[0], timeZone: 'UTC' }), '2:05 PM');
});

test('the Hijri adjustment moves the Hijri date only', () => {
  const base = { ...CLOCKS[0], hijriOffset: 0 };
  const plus = { ...base, hijriOffset: 1 };
  assert.equal(S.gregorianDate('2026-09-30T18:00:00Z', base), S.gregorianDate('2026-09-30T18:00:00Z', plus));
  assert.match(S.hijriDate('2026-09-30T18:00:00Z', base), /Rabiʻ II 19, 1448/);
  assert.match(S.hijriDate('2026-09-30T18:00:00Z', plus), /Rabiʻ II 20, 1448/);
});

test('a zone-less calendar date is never shifted a day', () => {
  // Parsed as an instant, "2026-07-01" is midnight UTC — June 30th anywhere west of London.
  // Every locale writes July 1st (en-AU spells the month out), never June 30th.
  for (const c of CLOCKS) assert.match(S.formatCalendarDate('2026-07-01', c), /^(1 Jul|Jul 1)/);
  assert.equal(S.formatCalendarDate('not a date', CLOCKS[0]), 'not a date');
});

test('"today" and "this month" start at the masjid’s midnight, across a DST change', () => {
  const chi = CLOCKS[0];
  assert.equal(S.startOfDay(new Date('2026-09-30T23:30:00Z'), chi).toISOString(), '2026-09-30T05:00:00.000Z'); // CDT
  assert.equal(S.startOfDay(new Date('2026-11-01T12:00:00Z'), chi).toISOString(), '2026-11-01T05:00:00.000Z'); // day DST ends
  assert.equal(S.startOfDay(new Date('2026-11-02T12:00:00Z'), chi).toISOString(), '2026-11-02T06:00:00.000Z'); // CST
  assert.equal(S.startOfMonth(new Date('2026-09-30T23:30:00Z'), chi).toISOString(), '2026-09-01T05:00:00.000Z');
  const syd = CLOCKS[4];
  assert.equal(S.startOfDay(new Date('2026-09-30T23:30:00Z'), syd).toISOString(), '2026-09-30T14:00:00.000Z'); // AEST, Oct 1
});

test('the panel’s end-of-day for a plan is the masjid’s, whatever the browser’s zone', () => {
  assert.equal(W.endOfDayFromInput('2026-10-05', CLOCKS[0]), '2026-10-06T04:59:59.000Z');
  assert.equal(W.toDateInputValue('2026-10-06T04:59:59.000Z', CLOCKS[0]), '2026-10-05');
  assert.equal(W.endOfDayFromInput('garbage', CLOCKS[0]), '');
});

test('an unset or invalid zone never throws', () => {
  const unset = { ...CLOCKS[0], timeZone: '' };
  assert.ok(S.formatDateTime('2026-09-30T18:00:00Z', unset));
  const junk = { ...CLOCKS[0], timeZone: 'Not/AZone' };
  assert.ok(S.formatDateTime('2026-09-30T18:00:00Z', junk));
  assert.equal(S.formatDate('nope', CLOCKS[0]), '');
});

test('money: the panel and the server print the same string, at Stripe’s scale', () => {
  const cases: [number, string, string][] = [
    [2500, 'USD', 'en-US'],
    [2550, 'USD', 'en-US'],
    [123450000, 'USD', 'en-US'],
    [0, 'GBP', 'en-GB'],
    [2550, 'GBP', 'en-GB'],
    [2550, 'PKR', 'en-PK'],
    [1500, 'IQD', 'en-US'],
    [2500, 'KWD', 'en-KW'],
    [2000, 'KWD', 'en-KW'],
    [500, 'JPY', 'en-JP'],
    [10000000, 'INR', 'en-IN'],
    [2500, 'CAD', 'en-CA'],
    [2599, 'EUR', 'en-IE'],
  ];
  for (const [minor, ccy, locale] of cases) {
    setClock({ locale });
    assert.equal(webMoney(minor, ccy), serverMoney(minor, ccy, locale), `${minor} ${ccy} ${locale}`);
  }
  setClock({ locale: 'en-US' });
});

test('money keeps the decimals ICU would have dropped', () => {
  assert.match(serverMoney(2550, 'PKR', 'en-PK'), /25\.50/, 'a Rs 25.50 gift is not "PKR 26"');
  assert.match(serverMoney(1500, 'IQD', 'en-US'), /1\.500/, 'IQD is three-decimal to Stripe');
  assert.equal(serverMoney(2500, 'USD', 'en-US'), '$25', 'a whole amount drops its decimals');
  assert.equal(serverMoney(123450000, 'USD', 'en-US'), '$1,234,500', 'grouped');
  assert.equal(serverMoney(2500, 'CAD', 'en-CA'), '$25', 'a Canadian masjid sees $, not CA$');
  // A well-formed code ICU has never heard of is still formatted (with the code), not thrown.
  // (Intl puts a no-break space between a code and its number — \s matches it.)
  assert.match(serverMoney(1234, 'XYZ', 'en-US'), /^XYZ\s12\.34$/);
  assert.equal(serverMoney(1234, '', 'en-US'), '12.34', 'no code at all falls back without throwing');
});
