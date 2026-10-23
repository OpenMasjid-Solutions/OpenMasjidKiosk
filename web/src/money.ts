// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Money, shared by the giving designer, the donations log and the plans screen.
 *
 * Integer MINOR units everywhere, so no float ever reaches Stripe — and the scale of a minor unit
 * comes from THIS table, which follows Stripe's rules, never from ICU's idea of a currency's
 * decimals. The two disagree (ICU gives PKR no decimals and IQD none; Stripe uses two and three), and
 * letting ICU decide printed a Rs 25.50 gift as "PKR 26" on the server before this was fixed.
 *
 * Formatting goes through `Intl.NumberFormat` with the masjid's own locale (locale.ts), so the
 * symbol, its position and the digit grouping are the currency's real conventions: "$1,234,500",
 * "₹1,00,000", "KWD 2.500". A whole amount drops its decimals — "$25", not "$25.00" — which reads
 * better down a list and is pinned by server/src/refund-amount.test.ts.
 *
 * REACT-FREE on purpose: that test imports this file directly.
 */
import { getClock } from './locale';

// Stripe's minor units — the same table as server/src/stripe.ts, which money-tables.test.ts checks.
// UGX is NOT here: Stripe takes it as two-decimal, always ending 00 (like ISK).
const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'XAF', 'XOF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'VUV', 'XPF',
]);
// Three-decimal currencies (Gulf/Maghreb): 1 major unit = 1000 minor units.
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
export const decimals = (ccy: string) => {
  const c = (ccy ?? '').toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
};
export const factor = (ccy: string) => 10 ** decimals(ccy);

/** One formatter per (locale, currency, fraction digits) — Intl.NumberFormat is not free to build,
 *  and a donations list formats hundreds of amounts per poll. */
const cache = new Map<string, Intl.NumberFormat | null>();
function formatterFor(locale: string, ccy: string, digits: number): Intl.NumberFormat | null {
  const key = `${locale}|${ccy}|${digits}`;
  if (!cache.has(key)) {
    let f: Intl.NumberFormat | null = null;
    try {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency: ccy, minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, decimals(ccy)) });
    } catch {
      f = null; // not an ISO currency this runtime knows — the caller falls back to "12.50 XYZ"
    }
    cache.set(key, f);
  }
  return cache.get(key) ?? null;
}

/** Minor units → a display string: 2500 USD → "$25", 2550 → "$25.50", 2500 KWD → "KWD 2.500". */
export function formatMoney(minor: number, ccy: string): string {
  const c = (ccy ?? '').toUpperCase();
  const d = decimals(c);
  const f = factor(c);
  const n = Math.round(Number(minor) || 0);
  const whole = n % f === 0;
  const fmt = formatterFor(getClock().locale, c, whole ? 0 : d);
  if (fmt) return fmt.format(n / f);
  return `${toMajorStr(n, c)} ${c}`.trim();
}

/** The currency's symbol as the masjid's locale writes it ("$", "£", "KWD"), for an amount box's
 *  prefix. Falls back to the code. */
export function symbolFor(ccy: string): string {
  const c = (ccy ?? '').toUpperCase();
  const fmt = formatterFor(getClock().locale, c, 0);
  return fmt?.formatToParts(0).find((p) => p.type === 'currency')?.value ?? c;
}

/**
 * A typed amount as a plain "1234.50". The decimal point is read the way people TYPE it, not from the
 * locale: `.` always is one; with both signs present, the last one is; a lone comma is one unless
 * exactly three digits follow it, which is how English writes thousands. Spaces go.
 *
 * Before this every comma was simply dropped, so "12,50" — how a masjid in South Africa, Indonesia or
 * most of Europe writes twelve and a half — became 1250, a hundred times the refund that was typed.
 * Not from the locale on purpose: the boxes are filled by toMajorStr, which always writes a dot, and
 * reading the dot as a thousands sign where the locale uses one would turn "12.5" into 125.
 */
export function plainAmount(text: string): string {
  let s = String(text ?? '').replace(/[\s\u00a0\u202f]/g, '');
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) {
    s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (comma >= 0) {
    const single = s.indexOf(',') === comma;
    s = single && s.length - comma - 1 !== 3 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  return s;
}

/** A "major unit" text field (e.g. "5", "10.50", "12,50") → integer minor units, or 0 if not a valid amount. */
export function toMinor(major: string, ccy: string): number {
  const n = Number(plainAmount(major));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * factor(ccy));
}

/** Integer minor units → an editable major-unit string (no trailing ".00"). */
export function toMajorStr(minor: number, ccy: string): string {
  const d = decimals(ccy);
  const f = factor(ccy);
  if (d === 0) return String(minor);
  return minor % f === 0 ? String(minor / f) : (minor / f).toFixed(d);
}
