// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { formatTime, gregorianDate, hijriDate, type ClockSettings } from './dates';
import { toMajor } from './stripe';
import type { DonationRecord } from './store';

/** Escape one CSV cell. Two ordered stages (mirrors OpenMasjidDonations):
 *  1. **Formula/DDE-injection guard.** Donor name/email are attacker-controllable and would execute
 *     when an admin opens the export in Excel/Sheets/LibreOffice. If the value STARTS with = + - @,
 *     a TAB or a CR, prefix a single quote to neutralise it (OWASP mitigation). LF is intentionally
 *     not a trigger; the guard is position-0 only (so "A-1" is untouched).
 *  2. **Standard CSV quoting** of the (possibly prefixed) string: if it contains a quote, comma, CR
 *     or LF, wrap in double quotes and double any embedded quotes. */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header + rows (every cell escaped). Rows are CRLF-joined per RFC 4180. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/**
 * The byte-order mark the donations export starts with.
 *
 * Excel on Windows opens a CSV that has none in the machine's ANSI code page, not UTF-8, so every
 * name with a character outside ASCII — an Arabic or Urdu donor name, "Masjid al-Nūr", a "£" in a
 * campaign title — arrives in the treasurer's spreadsheet as mojibake. The app spec's rule is to
 * render names as given; corrupting them is worse than any re-casing. LibreOffice, Google Sheets and
 * Numbers all ignore the mark, and Python reads it with 'utf-8-sig'.
 *
 * Prepended by the ROUTE, not by toCsv: toCsv is a general cell/row escaper whose exact output
 * csv.test.ts pins, and a BOM is a property of a downloaded file rather than of a CSV document.
 */
export const CSV_BOM = '﻿';

/**
 * A donation's Stripe status, in words a treasurer reads.
 *
 * The row records Stripe's PaymentIntent status verbatim ('succeeded', 'requires_payment_method',
 * 'canceled'), which is the right thing to STORE and the wrong thing to hand a volunteer — the
 * spreadsheet is read by the same people as the panel. The Stripe payment ID column beside it is
 * what reconciles a row with the dashboard, so nothing is lost by translating this one.
 *
 * The same wording as the Donations screen (web/src/donations.tsx), so a row reads the same in both.
 */
export function donationStatusWords(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'Paid';
    case 'requires_payment_method':
      return 'Card didn’t go through — no money taken';
    case 'canceled':
      return 'Canceled — no money taken';
    case 'requires_capture':
    case 'processing':
      return 'Still being confirmed with Stripe';
    case 'requires_action':
      return 'Waiting on the donor’s bank';
    default:
      return 'Not completed';
  }
}

/** The donations export's columns, in order. */
export const DONATION_CSV_HEADER = [
  // The instant as stored — UTC, ISO 8601 — so a spreadsheet can still sort and filter on it exactly.
  // Labelled as UTC now that it sits beside the masjid's own clock, or the two read as a contradiction.
  'Date (UTC)',
  // The same instant on the masjid's clock, which is the one a person means by "Friday's takings".
  // Without it a Friday-evening gift in the Americas lands on Saturday for anyone reading the sheet.
  'Date (masjid time)',
  'Hijri date',
  'Amount',
  'Refunded',
  'Net',
  'Currency',
  'Type',
  'Campaign',
  'Status',
  'Donor name',
  'Donor email',
  'Kiosk',
  // Stripe's own id for the payment, for finding a row in the Stripe dashboard. It used to be headed
  // "PaymentIntent", which is the Stripe API's word for it and means nothing to a treasurer.
  'Stripe payment ID',
  'Refund ID',
  'Refunded at (UTC)',
];

/**
 * The donations export as rows, header first.
 *
 * 'Amount' stays the amount GIVEN, so an export never rewrites history; 'Refunded' and 'Net' carry
 * what came back and what was kept. A spreadsheet summing the wrong column would otherwise report
 * money the masjid no longer has — so Net is provided rather than left as an exercise. Each row is
 * scaled by ITS OWN currency, never the page's current one: a masjid that switched currency keeps
 * the old rows at the scale they were taken in.
 *
 * `clock` is read once by the caller rather than per row, because it is a database read and an
 * export can run to thousands of rows.
 */
export function donationCsvRows(donations: readonly DonationRecord[], clock: ClockSettings): string[][] {
  const rows: string[][] = [DONATION_CSV_HEADER.slice()];
  for (const d of donations) {
    // Composed rather than taken from formatDateTime, whose Hijri half has a column of its own here.
    // An unreadable stamp gives '' from both halves, so the cell is blank rather than "Invalid Date".
    const day = gregorianDate(d.createdAt, clock);
    const time = formatTime(d.createdAt, clock);
    rows.push([
      d.createdAt,
      day && time ? `${day}, ${time}` : day,
      hijriDate(d.createdAt, clock),
      String(toMajor(d.amountMinor, d.currency)),
      String(toMajor(d.refundedMinor, d.currency)),
      String(toMajor(d.amountMinor - d.refundedMinor, d.currency)),
      d.currency,
      d.kind === 'monthly' ? 'Monthly' : 'One-time',
      d.campaignTitle,
      donationStatusWords(d.status),
      d.donorName,
      d.donorEmail,
      d.deviceName || '',
      d.paymentIntentId,
      d.refundId,
      d.refundedAt,
    ]);
  }
  return rows;
}
