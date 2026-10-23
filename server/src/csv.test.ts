// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_BOM, DONATION_CSV_HEADER, csvCell, donationCsvRows, donationStatusWords, toCsv } from './csv';
import type { DonationRecord } from './store';
import type { ClockSettings } from './dates';

/** Strip outer quotes + unescape "" so we can assert the EFFECTIVE cell value (what a spreadsheet
 *  sees), including the leading-quote injection guard. */
function decode(cell: string): string {
  if (cell.startsWith('"') && cell.endsWith('"')) return cell.slice(1, -1).replace(/""/g, '"');
  return cell;
}

test('formula/DDE triggers are neutralised with a leading quote', () => {
  for (const v of ['=1+1', '=HYPERLINK("http://evil","x")', "=cmd|'/C calc'!A1", '+1', '-1', '@SUM(A1)', '\ttab', '\rcr']) {
    assert.ok(decode(csvCell(v)).startsWith("'"), `expected guard for: ${JSON.stringify(v)}`);
  }
});

test('a dangerous value that also needs quoting is both prefixed and quoted', () => {
  assert.equal(csvCell('=1,2'), '"\'=1,2"');
});

test('ordinary values pass through unchanged', () => {
  for (const v of ['Aisha Khan', 'aisha@example.com', '$50.00', '', 'A-1', 'one_time']) {
    assert.equal(csvCell(v), v);
  }
});

test('standard CSV quoting for commas, quotes and newlines', () => {
  assert.equal(csvCell('Khan, Aisha'), '"Khan, Aisha"');
  assert.equal(csvCell('she said "hi"'), '"she said ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('phone-like leading + is guarded, not executed', () => {
  assert.equal(csvCell('+1 555 0100'), "'+1 555 0100");
});

test('toCsv joins cells with commas and rows with CRLF, escaping every cell', () => {
  assert.equal(toCsv([['a', 'b'], ['=x', 'y,z']]), "a,b\r\n'=x,\"y,z\"");
});

// ── The donations export ──────────────────────────────────────────────────────
// A treasurer's spreadsheet is read by the same people as the admin panel, so it follows the same
// rules: plain words rather than Stripe's codes, the masjid's own clock beside the UTC stamp, the
// Hijri date with the Gregorian, each row at its own currency's scale, and names exactly as given.


const CHICAGO: ClockSettings = { timeZone: 'America/Chicago', clock24h: false, hijriOffset: 0, locale: 'en-US' };

function donation(over: Partial<DonationRecord> = {}): DonationRecord {
  return {
    id: 'd1',
    paymentIntentId: 'pi_3Pabc',
    deviceId: 'dev1',
    deviceName: 'Foyer kiosk',
    campaignId: 'c1',
    campaignTitle: 'Roof Appeal',
    amountMinor: 2550,
    currency: 'USD',
    kind: 'one_time',
    status: 'succeeded',
    donorName: 'Aisha',
    donorEmail: 'aisha@example.com',
    cardBrand: 'visa',
    cardLast4: '4242',
    receipt: 'stripe',
    chargeId: 'ch_1',
    refundedMinor: 0,
    refundId: '',
    refundedAt: '',
    refundReason: '',
    // Friday 9 p.m. in Chicago — already SATURDAY in UTC, which is the whole reason for the column.
    createdAt: '2026-09-26T02:00:00.000Z',
    ...over,
  };
}

const col = (name: string) => DONATION_CSV_HEADER.indexOf(name);

test('the header names things the way a treasurer would', () => {
  const [header] = donationCsvRows([], CHICAGO);
  assert.deepEqual(header, DONATION_CSV_HEADER);
  assert.ok(header.includes('Stripe payment ID'), 'not the Stripe API word "PaymentIntent"');
  assert.ok(!header.includes('PaymentIntent'));
  for (const c of ['Date (UTC)', 'Date (masjid time)', 'Hijri date', 'Amount', 'Refunded', 'Net', 'Status']) {
    assert.ok(header.includes(c), c);
  }
});

test('the masjid-time column is the masjid’s day; the UTC column is kept exactly for sorting', () => {
  const [, row] = donationCsvRows([donation()], CHICAGO);
  assert.equal(row[col('Date (UTC)')], '2026-09-26T02:00:00.000Z', 'the stored instant, untouched');
  const local = row[col('Date (masjid time)')];
  assert.match(local, /Sep 25, 2026/, `a Friday-evening gift stays on Friday, got ${local}`);
  assert.match(local, /9:00\s?PM/, 'on the masjid’s 12-hour clock');
  assert.ok(!/T\d\d:/.test(local), 'never an ISO stamp');
  assert.match(row[col('Hijri date')], /1448/, 'the Hijri date of that same civil day');
  // A 24-hour masjid reads its own clock.
  const [, row24] = donationCsvRows([donation()], { ...CHICAGO, clock24h: true });
  assert.match(row24[col('Date (masjid time)')], /21:00/);
});

test('Status is plain words, not Stripe’s codes', () => {
  assert.equal(donationStatusWords('succeeded'), 'Paid');
  assert.match(donationStatusWords('requires_payment_method'), /no money taken/);
  assert.match(donationStatusWords('canceled'), /no money taken/);
  assert.match(donationStatusWords('processing'), /confirmed/);
  assert.match(donationStatusWords('requires_capture'), /confirmed/);
  assert.equal(donationStatusWords('something_new_from_stripe'), 'Not completed', 'unknown never leaks a code');
  const [, row] = donationCsvRows([donation({ status: 'requires_payment_method' })], CHICAGO);
  assert.ok(!row.includes('requires_payment_method'), 'the raw code is not in the row');
  assert.equal(row[col('Stripe payment ID')], 'pi_3Pabc', 'the id that reconciles a row with Stripe is still there');
});

test('each row is scaled by ITS OWN currency, and Net is what was kept', () => {
  const rows = donationCsvRows(
    [
      donation({ amountMinor: 2550, refundedMinor: 550, currency: 'USD' }),
      donation({ id: 'd2', amountMinor: 25500, refundedMinor: 0, currency: 'KWD' }),
      donation({ id: 'd3', amountMinor: 500, refundedMinor: 0, currency: 'JPY' }),
    ],
    CHICAGO,
  );
  assert.deepEqual([rows[1][col('Amount')], rows[1][col('Refunded')], rows[1][col('Net')]], ['25.5', '5.5', '20']);
  assert.equal(rows[2][col('Amount')], '25.5', 'KWD has three decimals — 25500 minor is 25.500, not 255');
  assert.equal(rows[3][col('Amount')], '500', 'JPY has none — 500 minor is ¥500, not ¥5');
});

test('names reach the spreadsheet as given — and the file tells Excel it is UTF-8', () => {
  const name = 'عائشة Nūr-Ḥasan';
  const [, row] = donationCsvRows([donation({ donorName: name, campaignTitle: 'Masjid al-Nūr — £ appeal' })], CHICAGO);
  assert.equal(row[col('Donor name')], name);
  assert.equal(row[col('Campaign')], 'Masjid al-Nūr — £ appeal');
  // Without the mark, Excel on Windows opens the file in the ANSI code page and that name is mojibake.
  assert.equal(CSV_BOM, '\uFEFF');
  assert.equal(CSV_BOM.length, 1, 'one invisible character, nothing else');
});

test('the export still guards against formula injection in donor-typed fields', () => {
  const rows = donationCsvRows([donation({ donorName: '=HYPERLINK("http://evil","x")' })], CHICAGO);
  const csv = toCsv(rows);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), 'neutralised and quoted');
});

test('an unreadable stamp leaves the date cells blank rather than printing "Invalid Date"', () => {
  const [, row] = donationCsvRows([donation({ createdAt: '' })], CHICAGO);
  assert.equal(row[col('Date (masjid time)')], '');
  assert.equal(row[col('Hijri date')], '');
});
