// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The masjid's clock and conventions — time zone, 12/24-hour, the Hijri adjustment and a formatting
 * locale — held once for the whole panel.
 *
 * WHY THESE ARE THE MASJID'S AND NOT THE BROWSER'S. "Never assume the browser's locale is the
 * masjid's" (the app UI spec, §10): a trustee checking the donations log on holiday must not see
 * every gift shifted by their hotel's time zone, and "today's takings" must mean the masjid's today.
 * So every date on screen is formatted from these settings, which live with the masjid details on
 * the server (Settings → Payments → Masjid details) — the platform holds no masjid profile to ask.
 *
 * The one place the browser is still consulted is as a STAND-IN while the setting is empty, which is
 * only ever the first sign-in: App.tsx then saves this computer's zone as the masjid's, visibly, on
 * the settings form, where it can be changed. From then on the browser has no say.
 *
 * REACT-FREE, like money.ts: the server's test run imports these modules directly. The React hook
 * over this store lives in ui.tsx.
 */

export interface ClockSettings {
  /** IANA zone, e.g. "America/Chicago". '' = not chosen yet. */
  timeZone: string;
  clock24h: boolean;
  /** Days to nudge the Hijri date by (−3..3), for masjids that follow a local sighting. */
  hijriOffset: number;
  /** BCP-47 tag used for every date and amount, e.g. "en-GB". English, because the copy is. */
  locale: string;
}

/** English in the masjid's own region: `en-GB` writes "30 Sept 2026" and "£25", `en-IN` groups
 *  "₹1,00,000", `en-CA` writes "$25" rather than the "CA$25" plain `en` gives. The copy is English,
 *  so the language is too — only the conventions follow the masjid's country. */
export function localeForCountry(country: string): string {
  const cc = (country ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? `en-${cc}` : 'en-US';
}

export const DEFAULT_CLOCK: ClockSettings = { timeZone: '', clock24h: false, hijriOffset: 0, locale: 'en-US' };

let current: ClockSettings = { ...DEFAULT_CLOCK };
const listeners = new Set<() => void>();

export function getClock(): ClockSettings {
  return current;
}

export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace the settings from the masjid details the server returned. */
export function setClock(next: Partial<ClockSettings>): void {
  const merged: ClockSettings = {
    timeZone: typeof next.timeZone === 'string' && isValidTimeZone(next.timeZone) ? next.timeZone : next.timeZone === '' ? '' : current.timeZone,
    clock24h: typeof next.clock24h === 'boolean' ? next.clock24h : current.clock24h,
    hijriOffset: Number.isInteger(next.hijriOffset) ? Math.max(-3, Math.min(3, next.hijriOffset as number)) : current.hijriOffset,
    locale: typeof next.locale === 'string' && next.locale ? next.locale : current.locale,
  };
  if (
    merged.timeZone === current.timeZone &&
    merged.clock24h === current.clock24h &&
    merged.hijriOffset === current.hijriOffset &&
    merged.locale === current.locale
  ) {
    return;
  }
  current = merged;
  for (const l of listeners) l();
}

/** True for a zone this runtime can format in. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** This device's own zone — used ONLY to suggest a value for an empty setting, never to format. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}
