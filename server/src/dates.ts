// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Every date the SERVER writes for a person — receipts, refund and monthly emails, the donor's cancel
 * page, the CSV, WhatsApp replies, the Students due date — goes through here.
 *
 * The rules are the app UI spec's (§10), and they are the same as the admin panel's
 * (web/src/dates.ts), which server/src/dates-parity.test.ts checks by running both over the same
 * inputs:
 *
 *   1. Hijri AND Gregorian together wherever a date appears.
 *   2. The MASJID'S time zone and 12/24-hour choice — never the container's. A Docker container runs
 *      in UTC unless told otherwise, so before this every receipt stamped a Friday-evening gift in
 *      Chicago with Saturday's date.
 *   3. The Hijri date is that of the masjid's civil day, through the Umm al-Qura calendar, nudged by
 *      the masjid's own adjustment — the same method as OpenMasjidDisplay, so the two agree.
 *
 * Built from explicit component options, never `dateStyle`/`timeStyle`. The receipt formatter this
 * replaced combined `dateStyle` with `timeZoneName`, which ECMA-402 forbids: it threw on every call,
 * and every receipt ever sent fell back to a raw ISO timestamp ("2026-09-30T18:03:11.123Z").
 */

export interface ClockSettings {
  /** IANA zone. '' = not chosen yet, which formats in the runtime's own zone. */
  timeZone: string;
  clock24h: boolean;
  /** −3..3 days. */
  hijriOffset: number;
  /** BCP-47, e.g. "en-GB". */
  locale: string;
}

export const DEFAULT_CLOCK: ClockSettings = { timeZone: '', clock24h: false, hijriOffset: 0, locale: 'en-US' };

/** English in the masjid's own region — see web/src/locale.ts for why. */
export function localeForCountry(country: string): string {
  const cc = (country ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? `en-${cc}` : 'en-US';
}

/** True for a zone this runtime can format in. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type When = string | number | Date;

function toDate(v: When): Date | null {
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : Date.parse(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function zoneOf(s: ClockSettings): string | undefined {
  return s.timeZone && isValidTimeZone(s.timeZone) ? s.timeZone : undefined;
}

/** Y-M-D of an instant, in a zone. */
export function ymdIn(d: Date, timeZone: string | undefined): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function hijriOfCivil(y: number, m: number, day: number, s: ClockSettings): string {
  try {
    const f = new Intl.DateTimeFormat(`${s.locale}-u-ca-islamic-umalqura`, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    // A runtime without the calendar silently hands back Gregorian — say nothing rather than print
    // the same date twice.
    if (!/islamic/.test(f.resolvedOptions().calendar)) return '';
    return f.format(new Date(Date.UTC(y, m - 1, day + (s.hijriOffset || 0), 12)));
  } catch {
    return '';
  }
}

export function hijriDate(v: When, s: ClockSettings): string {
  const d = toDate(v);
  if (!d) return '';
  const { y, m, d: day } = ymdIn(d, zoneOf(s));
  return hijriOfCivil(y, m, day, s);
}

export function gregorianDate(v: When, s: ClockSettings): string {
  const d = toDate(v);
  if (!d) return '';
  return new Intl.DateTimeFormat(s.locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: zoneOf(s) }).format(d);
}

const join = (a: string, b: string) => (b ? `${a} · ${b}` : a);

/** "Sep 30, 2026 · Rabiʻ II 19, 1448 AH". An unreadable input gives '' rather than "Invalid Date". */
export function formatDate(v: When, s: ClockSettings): string {
  const d = toDate(v);
  if (!d) return '';
  return join(gregorianDate(d, s), hijriDate(d, s));
}

/** "3:04 PM" / "15:04". */
export function formatTime(v: When, s: ClockSettings): string {
  const d = toDate(v);
  if (!d) return '';
  return new Intl.DateTimeFormat(s.locale, { hour: s.clock24h ? '2-digit' : 'numeric', minute: '2-digit', hourCycle: s.clock24h ? 'h23' : 'h12', timeZone: zoneOf(s) }).format(d);
}

/** "Sep 30, 2026, 3:04 PM · Rabiʻ II 19, 1448 AH". */
export function formatDateTime(v: When, s: ClockSettings): string {
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

/** A zone-less calendar date ("2026-07-01", a Students due date) — that very day, never shifted. */
export function formatCalendarDate(ymd: string, s: ClockSettings): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd ?? '').trim());
  if (!m) return ymd ?? '';
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const g = new Intl.DateTimeFormat(s.locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, day, 12)));
  return join(g, hijriOfCivil(y, mo, day, s));
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

/** The instant a wall-clock time happens in a zone (resolved twice, so a DST change in between is
 *  accounted for). */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, ss: number, timeZone: string | undefined): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

/** Midnight at the start of the masjid's day containing `at`, as an instant. "Today's takings" and
 *  "this month" are the masjid's today and month — computing them with the container's clock put the
 *  boundary at UTC midnight, seven hours into a Friday evening in Chicago. */
export function startOfDay(at: Date, s: ClockSettings): Date {
  const tz = zoneOf(s);
  const { y, m, d } = ymdIn(at, tz);
  return new Date(zonedTime(y, m, d, 0, 0, 0, tz));
}

export function startOfMonth(at: Date, s: ClockSettings): Date {
  const tz = zoneOf(s);
  const { y, m } = ymdIn(at, tz);
  return new Date(zonedTime(y, m, 1, 0, 0, 0, tz));
}

/** Same calendar day in the masjid's zone? */
export function sameDay(a: When, b: When, s: ClockSettings): boolean {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return false;
  const x = ymdIn(da, zoneOf(s));
  const y = ymdIn(db, zoneOf(s));
  return x.y === y.y && x.m === y.m && x.d === y.d;
}
