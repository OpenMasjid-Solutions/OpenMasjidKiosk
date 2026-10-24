// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Minor units → a string a person reads, for everything the server writes: receipts, refund notes,
 * alerts, WhatsApp replies, the donor's cancel page, the tuition floor message.
 *
 * THE SCALE COMES FROM STRIPE'S TABLE (stripe.ts currencyDecimals), NEVER FROM ICU. The formatter this
 * replaced let `Intl.NumberFormat` pick the fraction digits, and ICU disagrees with Stripe for
 * currencies the app offers: a Rs 25.50 gift (2550 minor) printed as "PKR 26", and IQD — three
 * decimals to Stripe, none to ICU — lost its decimals entirely. The web formatter
 * (web/src/money.ts) follows the same rule, and a whole amount drops its decimals on both: "$25".
 *
 * `locale` is the masjid's (dates.ts localeForCountry), so the symbol, its placement and the digit
 * grouping are the currency's own conventions — and the same on the panel and in the email.
 */
import { currencyDecimals } from './stripe';

const cache = new Map<string, Intl.NumberFormat | null>();

function formatterFor(locale: string, currency: string, digits: number, max: number): Intl.NumberFormat | null {
  const key = `${locale}|${currency}|${digits}|${max}`;
  if (!cache.has(key)) {
    let f: Intl.NumberFormat | null = null;
    try {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: max });
    } catch {
      f = null;
    }
    cache.set(key, f);
  }
  return cache.get(key) ?? null;
}

/** Every ISO 4217 currency this runtime knows — the full-ICU list Node ships in the image. */
const KNOWN_CURRENCIES: ReadonlySet<string> | null = (() => {
  try {
    return new Set(Intl.supportedValuesOf('currency'));
  } catch {
    return null; // a runtime without the list: fall back to "can Intl format it at all"
  }
})();

/**
 * A currency a masjid can actually be set to.
 *
 * "Can Intl format it" is not enough on its own: Intl accepts ANY well-formed three-letter code, so
 * `ZZZ` passed and was stored, and every amount then read "ZZZ 10.00". Checked against the runtime's
 * own list of real currencies as well, which is exact and needs no table of ours to keep up to date.
 */
export function isKnownCurrency(code: string): boolean {
  if (!/^[A-Za-z]{3}$/.test(code ?? '')) return false;
  const c = code.toUpperCase();
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: c });
  } catch {
    return false;
  }
  return KNOWN_CURRENCIES ? KNOWN_CURRENCIES.has(c) : true;
}

export function formatMoney(minor: number, currency: string, locale = 'en-US'): string {
  const c = (currency || '').toUpperCase();
  const d = currencyDecimals(c || 'USD');
  const factor = 10 ** d;
  const n = Math.round(Number(minor) || 0);
  const whole = n % factor === 0;
  const f = formatterFor(locale, c, whole ? 0 : d, d);
  if (f) return f.format(n / factor);
  const major = d === 0 ? String(n) : whole ? String(n / factor) : (n / factor).toFixed(d);
  return `${major} ${c}`.trim();
}
