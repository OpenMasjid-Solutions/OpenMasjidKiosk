// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Currency helpers shared by the giving designer and the donations log (mirrors the server/tablet:
 *  integer MINOR units everywhere so no float ever reaches Stripe; zero-decimal currencies handled). */
const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'XAF', 'XOF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV', 'XPF',
]);
export const decimals = (ccy: string) => (ZERO_DECIMAL.has(ccy.toUpperCase()) ? 0 : 2);
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
  let body: string;
  if (d === 0) body = String(Math.round(minor));
  else if (minor % 100 === 0) body = String(Math.round(minor / 100));
  else body = (minor / 100).toFixed(2);
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
  if (d === 0) return String(minor);
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}
