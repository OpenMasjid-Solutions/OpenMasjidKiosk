// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Entering a WhatsApp number: a country picker plus an as-you-type mask.
 *
 * WHY A PICKER RATHER THAN A TEXT BOX. The server refuses a number with no country code and will not
 * guess one, because a UK admin typing `07700 900123` obviously means +44 and assuming that would
 * one day message a stranger in another country (`normalisePhone` in the server's `alerts.ts` — do
 * not soften it). That refusal is correct and it was also a papercut: the admin had to know to type
 * `+1` and the error only appeared after they pressed save. Choosing the country supplies the code
 * STRUCTURALLY, so what reaches the server is already `1` + ten digits and the strict rule never
 * fires in ordinary use.
 *
 * The formatter is ported from OpenMasjidStudents (`packages/web/src/lib/phone.ts`) rather than
 * written again, because it had already solved the awkward part: a mask that runs on every keystroke
 * has to accept the half-finished states, so `(555) 12` is a legitimate thing to be looking at and
 * not an error. Kiosk uses it for entry only — a stored number is displayed through
 * [formatE164ForDisplay], which knows the dial code.
 *
 * STORAGE IS ALWAYS DIGITS ONLY, no plus, dial code included — exactly what the platform's WhatsApp
 * endpoint takes. The country is NOT stored beside it: it is recovered by longest-prefix match when
 * a saved number is shown again, so there is no second field that can drift out of step with the
 * first.
 */

export interface Country {
  /** ISO-ish key, only used as a React key and a `<select>` value. */
  code: string;
  /** What the dropdown says. */
  label: string;
  /** Dial code, digits only, no plus. */
  dial: string;
  /** Format the national part the American way — `(555) 010-1234`. NANP only. */
  nanp?: boolean;
  /** Roughly how many digits the national part has, for the placeholder and a gentle nudge. */
  nationalDigits?: number;
}

/**
 * The countries offered, US first.
 *
 * Deliberately a short list rather than all ~200. This is a masjid admin choosing where their own
 * caretaker's phone is, not an international dialling reference — and a 200-row dropdown is worse at
 * that job than a 12-row one. `Other` keeps the long tail reachable by letting them type the full
 * international number themselves, which is what the box did before this existed.
 *
 * `+1` is shown as "US / CA" because the NANP is genuinely shared; splitting it into two rows that
 * produce identical output would only invite a pointless decision.
 */
export const COUNTRIES: readonly Country[] = [
  { code: 'US', label: 'US / CA (+1)', dial: '1', nanp: true, nationalDigits: 10 },
  { code: 'GB', label: 'UK (+44)', dial: '44', nationalDigits: 10 },
  { code: 'PK', label: 'Pakistan (+92)', dial: '92', nationalDigits: 10 },
  { code: 'IN', label: 'India (+91)', dial: '91', nationalDigits: 10 },
  { code: 'BD', label: 'Bangladesh (+880)', dial: '880', nationalDigits: 10 },
  { code: 'AE', label: 'UAE (+971)', dial: '971', nationalDigits: 9 },
  { code: 'SA', label: 'Saudi Arabia (+966)', dial: '966', nationalDigits: 9 },
  { code: 'MY', label: 'Malaysia (+60)', dial: '60', nationalDigits: 9 },
  { code: 'ZA', label: 'South Africa (+27)', dial: '27', nationalDigits: 9 },
  { code: 'AU', label: 'Australia (+61)', dial: '61', nationalDigits: 9 },
  { code: 'TR', label: 'Türkiye (+90)', dial: '90', nationalDigits: 10 },
  { code: 'NG', label: 'Nigeria (+234)', dial: '234', nationalDigits: 10 },
  // No dial code of its own: the admin types the whole international number, which is what happened
  // before there was a picker at all.
  { code: 'OTHER', label: 'Somewhere else', dial: '' },
];

export const DEFAULT_COUNTRY = COUNTRIES[0];

/** Every digit in the string, in order. */
export function digits(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * Format a national number the American way, as you type.
 *
 * Ported from Students. Deliberately forgiving: a partial number formats as far as it goes, so
 * `(555) 12` is an ordinary intermediate state rather than something to complain about. Never
 * destroys what somebody typed — more digits than a NANP number holds are handed back untouched
 * rather than squeezed into a shape they do not fit.
 */
export function formatNanp(raw: string): string {
  const d = digits(raw);
  if (!d) return '';
  if (d.length > 10) return d;
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Space the national part in even groups — a readable default for everywhere that isn't the NANP. */
export function formatGrouped(raw: string): string {
  const d = digits(raw);
  return d.replace(/(\d{1,4})(?=(\d{3})+$)/g, '$1 ').trim() || d;
}

/** The mask for one country. */
export function formatNational(country: Country, raw: string): string {
  return country.nanp ? formatNanp(raw) : formatGrouped(raw);
}

/**
 * What to store: dial code + national digits, no plus, no punctuation.
 *
 * For `Other` the admin typed the whole international number, so it is taken as-is (minus
 * punctuation) and the server has the final say on whether it is usable.
 */
export function toE164Digits(country: Country, national: string): string {
  const nat = digits(national);
  if (!nat) return '';
  if (!country.dial) return nat;
  // Someone pasting `+1 555 010 1234` into the national box while +1 is selected should not get
  // `11555…`. If what they typed already starts with the dial code AND is too long to be a national
  // number on its own, treat it as already-international.
  if (country.nationalDigits && nat.startsWith(country.dial) && nat.length > country.nationalDigits) {
    return nat;
  }
  return `${country.dial}${nat}`;
}

/** Longest-prefix match, so `15550101234` recovers "US / CA" and `447700900123` recovers "UK". */
export function countryForE164(stored: string): Country {
  const d = digits(stored);
  let best: Country | null = null;
  for (const c of COUNTRIES) {
    if (!c.dial || !d.startsWith(c.dial)) continue;
    if (!best || c.dial.length > best.dial.length) best = c;
  }
  return best ?? COUNTRIES[COUNTRIES.length - 1];
}

/** The national part of a stored number, for putting back in the input. */
export function nationalForE164(stored: string): string {
  const d = digits(stored);
  const c = countryForE164(stored);
  return c.dial && d.startsWith(c.dial) ? d.slice(c.dial.length) : d;
}

/** A stored number, written out for a human: `+1 (555) 010-1234`. */
export function formatE164ForDisplay(stored: string): string {
  const d = digits(stored);
  if (!d) return '';
  const c = countryForE164(stored);
  if (!c.dial || !d.startsWith(c.dial)) return `+${d}`;
  return `+${c.dial} ${formatNational(c, d.slice(c.dial.length))}`.trim();
}

/** A placeholder that matches the country, so the shape being asked for is never a guess. */
export function placeholderFor(country: Country): string {
  if (country.nanp) return '(555) 010-1234';
  if (!country.dial) return '+### ### ### ####';
  return '7700 900123';
}

/**
 * The same rule the server enforces, so the button can be disabled before a round trip.
 *
 * KEPT IN STEP WITH `normalisePhone` ON THE SERVER DELIBERATELY, and the server is still the
 * authority — this is only here so an admin is not told about a problem after pressing save. The
 * two rules that matter: 8–15 digits (E.164), and no leading zero, because a leading zero is a
 * national trunk prefix and the surest sign the country code is missing.
 */
export function e164LooksValid(stored: string): boolean {
  const d = digits(stored);
  return d.length >= 8 && d.length <= 15 && !d.startsWith('0');
}
