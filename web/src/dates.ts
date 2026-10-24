// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Every date a person reads in the panel goes through here.
 *
 * THREE RULES, all from the app UI spec §10, and the reason each exists:
 *
 *   1. Hijri AND Gregorian, together, wherever a date appears. A relative "5 min ago" is not a date
 *      and stays as it is (relativeTime below).
 *   2. The masjid's time zone and 12/24-hour choice, never the viewer's device — see locale.ts.
 *   3. The Hijri date is the Hijri date OF THE MASJID'S CIVIL DAY, nudged by the masjid's own
 *      adjustment. Worked out as "which Y-M-D is it in the masjid's zone", then that day at UTC noon
 *      through the Umm al-Qura calendar — so a gift at 11pm in Chicago lands on Chicago's Hijri date,
 *      not London's. The same method as OpenMasjidDisplay's `hijri()`, so the kiosk and the masjid's
 *      screens agree.
 *
 * Built from explicit component options, never `dateStyle`/`timeStyle`: combining a style with
 * `timeZoneName` or `hourCycle` throws, and the server's receipt formatter did exactly that for every
 * receipt it ever sent, silently falling back to a raw ISO timestamp.
 *
 * KEEP IN STEP WITH server/src/dates.ts. The server formats the same dates for receipts, the CSV and
 * WhatsApp replies; server/src/dates-parity.test.ts runs both over the same inputs.
 */
import { getClock, type ClockSettings } from './locale';

type When = string | number | Date;

function toDate(v: When): Date | null {
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : Date.parse(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The zone to format in: the masjid's, or — only while it is unset — the runtime's own. */
function zoneOf(s: ClockSettings): string | undefined {
  return s.timeZone || undefined;
}

/** Y-M-D of an instant, in a zone. */
export function ymdIn(d: Date, timeZone: string | undefined): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** The Hijri date of a civil Y-M-D, shifted by the masjid's adjustment. '' if the runtime can't. */
function hijriOfCivil(y: number, m: number, day: number, s: ClockSettings): string {
  try {
    const f = new Intl.DateTimeFormat(`${s.locale}-u-ca-islamic-umalqura`, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    // A runtime without the calendar silently hands back Gregorian — which would print the same
    // date twice. Say nothing rather than something wrong.
    if (!/islamic/.test(f.resolvedOptions().calendar)) return '';
    return f.format(new Date(Date.UTC(y, m - 1, day + (s.hijriOffset || 0), 12)));
  } catch {
    return '';
  }
}

/** Just the Hijri date of an instant, in the masjid's zone: "Rabiʻ II 19, 1448 AH". */
export function hijriDate(v: When, s: ClockSettings = getClock()): string {
  const d = toDate(v);
  if (!d) return '';
  const { y, m, d: day } = ymdIn(d, zoneOf(s));
  return hijriOfCivil(y, m, day, s);
}

/** Just the Gregorian date: "Sep 30, 2026" (en-US) / "30 Sept 2026" (en-GB). */
export function gregorianDate(v: When, s: ClockSettings = getClock()): string {
  const d = toDate(v);
  if (!d) return '';
  return new Intl.DateTimeFormat(s.locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: zoneOf(s) }).format(d);
}

const join = (a: string, b: string) => (b ? `${a} · ${b}` : a);

/** A date: "Sep 30, 2026 · Rabiʻ II 19, 1448 AH". */
export function formatDate(v: When, s: ClockSettings = getClock()): string {
  const d = toDate(v);
  if (!d) return '';
  return join(gregorianDate(d, s), hijriDate(d, s));
}

/** A time of day, in the masjid's zone and hour cycle: "3:04 PM" / "15:04". */
export function formatTime(v: When, s: ClockSettings = getClock()): string {
  const d = toDate(v);
  if (!d) return '';
  return new Intl.DateTimeFormat(s.locale, { hour: s.clock24h ? '2-digit' : 'numeric', minute: '2-digit', hourCycle: s.clock24h ? 'h23' : 'h12', timeZone: zoneOf(s) }).format(d);
}

/** A moment: "Sep 30, 2026, 3:04 PM · Rabiʻ II 19, 1448 AH". */
export function formatDateTime(v: When, s: ClockSettings = getClock()): string {
  const d = toDate(v);
  if (!d) return '';
  const g = new Intl.DateTimeFormat(s.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    // "09:05" on a 24-hour clock, "9:05 AM" on a 12-hour one — each written the way it is read.
    hour: s.clock24h ? '2-digit' : 'numeric',
    minute: '2-digit',
    hourCycle: s.clock24h ? 'h23' : 'h12',
    timeZone: zoneOf(s),
  }).format(d);
  return join(g, hijriDate(d, s));
}

/**
 * A calendar date that has no time and no zone — a Students due date, "2026-07-01". Formatted as that
 * very day everywhere: parsing it as an instant would move it back a day for anyone west of UTC.
 */
export function formatCalendarDate(ymd: string, s: ClockSettings = getClock()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd ?? '').trim());
  if (!m) return ymd ?? '';
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const g = new Intl.DateTimeFormat(s.locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, day, 12)));
  return join(g, hijriOfCivil(y, mo, day, s));
}

/** Are two instants on the same day in the masjid's zone? */
export function sameDay(a: When, b: When, s: ClockSettings = getClock()): boolean {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return false;
  const x = ymdIn(da, zoneOf(s));
  const y = ymdIn(db, zoneOf(s));
  return x.y === y.y && x.m === y.m && x.d === y.d;
}

/** Milliseconds a zone is ahead of UTC at an instant. */
function offsetAt(ms: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in a zone — e.g. 23:59:59 on the day a plan should end, in
 * the masjid's zone, whatever zone the admin's browser is in. Resolved twice so a DST change between
 * the guess and the answer is accounted for.
 */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, ss: number, timeZone: string | undefined): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  // A wall time that never happens — midnight on the day Santiago or Havana springs forward at 00:00
  // — reads back as a different time; the later candidate is the first moment that does exist.
  // Without this, "today" there began at 23:00 the evening before.
  if (second + offsetAt(second, timeZone) !== guess) return Math.max(first, second);
  return second;
}

/** Y-M-D as the `value` of an <input type="date">, in the masjid's zone. */
export function toDateInputValue(v: When, s: ClockSettings = getClock()): string {
  const d = toDate(v);
  if (!d) return '';
  const { y, m, d: day } = ymdIn(d, zoneOf(s));
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The last second of a date-input day, in the masjid's zone, as ISO. '' for an unreadable value. */
export function endOfDayFromInput(value: string, s: ClockSettings = getClock()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!m) return '';
  return new Date(zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, 59, zoneOf(s))).toISOString();
}

/** "just now" · "5 min ago" · "3 h ago" · "2 days ago" — not a date, so no Hijri and no zone. */
export function relativeTime(v: When, now = Date.now()): string {
  const d = toDate(v);
  if (!d) return '';
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
