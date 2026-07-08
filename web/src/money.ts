// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Currency helpers shared by the giving designer and the donations log (mirrors the server/tablet:
 *  integer MINOR units everywhere so no float ever reaches Stripe; zero-decimal currencies handled). */
const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'XAF', 'XOF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV', 'XPF',
]);
// Three-decimal currencies (Gulf/Maghreb): 1 major unit = 1000 minor units.
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
export const decimals = (ccy: string) => {
  const c = ccy.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
};
export const factor = (ccy: string) => 10 ** decimals(ccy);

export function symbolFor(ccy: string): string {
  switch (ccy.toUpperCase()) {
    case 'USD': case 'CAD': case 'AUD': case 'NZD': return '$';
    case 'GBP': return '£';
    case 'EUR': return '€';
    case 'PKR': return '₨';
    case 'INR': return '₹';
    case 'MYR': return 'RM';
    case 'AED': return 'AED ';
    case 'SAR': return 'SAR ';
    default: return '';
  }
}

/** Minor units → a display string, e.g. 2500 USD → "$25", 2550 → "$25.50". */
export function formatMoney(minor: number, ccy: string): string {
  const sym = symbolFor(ccy);
  const d = decimals(ccy);
  const f = factor(ccy);
  let body: string;
  if (d === 0) body = String(Math.round(minor));
  else if (minor % f === 0) body = String(Math.round(minor / f));
  else body = (minor / f).toFixed(d);
  return sym ? `${sym}${body}` : `${body} ${ccy.toUpperCase()}`;
}

/** A "major unit" text field (e.g. "5", "10.50") → integer minor units, or 0 if not a valid amount. */
export function toMinor(major: string, ccy: string): number {
  const n = Number(String(major).trim());
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
