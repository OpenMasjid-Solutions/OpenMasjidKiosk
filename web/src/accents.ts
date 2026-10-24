// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The masjid's accent, as the OpenMasjidOS dashboard hands it over — five of them, each carrying the
 * ink that goes ON it.
 *
 * REACT-FREE ON PURPOSE. Three things read this table and only one of them is React: the pre-paint
 * script in index.html (vite.config.ts inlines it at build time, so the theme is right before the
 * first frame), prefs.ts (which applies it live), and server/src/accent-contrast.test.ts (which does
 * the arithmetic on it in CI). A module that imported React could not be read by the other two.
 *
 * `primary` / `hover` / `subtle` / `onPrimary` are the platform's own values, byte for byte
 * (OpenMasjidOS packages/ui/src/lib/prefs.ts). `onPrimary` is not decoration: an inline
 * `--color-btn` beats the stylesheet's light-theme block, so setting the fill without its ink is how
 * white lands on gold at 1.67:1 — every primary button on the page at once.
 *
 * `text` / `textHover` are OURS, and exist because the platform's table stops one step short. In the
 * LIGHT theme `--color-primary` is a FOREGROUND colour here — links, the active dock icon, the focus
 * ring, stat values, selected-chip borders — and a bright accent on a light surface measures
 * 1.67–2.72:1. So in light theme the fill keeps the bright accent (with its dark ink) and the
 * foreground takes a darker shade of the same hue: the lightest one that still clears 4.6:1 on every
 * light surface text sits on, the accent's own tinted wash included (worked out in OKLCH, so each
 * keeps its hue — teal is still teal). Dark theme uses the accent itself, which already reads.
 */

export interface Accent {
  label: string;
  /** The fill, and the dark-theme foreground. */
  primary: string;
  hover: string;
  /** A tint behind selected rows and chips. */
  subtle: string;
  /** Ink drawn ON the fill. */
  onPrimary: string;
  /** Light theme only: the accent as a foreground on a light surface (≥4.6:1 on all of them). */
  text: string;
  /** Light theme only: the hover/pressed foreground (≥6:1). */
  textHover: string;
}

export const ACCENTS = {
  cyan: { label: 'Cyan', primary: '#22D3EE', hover: '#67E8F9', subtle: 'rgba(34,211,238,0.12)', onPrimary: '#00131C', text: '#077180', textHover: '#045E6B' },
  teal: { label: 'Teal', primary: '#2DD4BF', hover: '#5EEAD4', subtle: 'rgba(45,212,191,0.12)', onPrimary: '#00201B', text: '#077468', textHover: '#036156' },
  sky: { label: 'Sky', primary: '#38BDF8', hover: '#7DD3FC', subtle: 'rgba(56,189,248,0.12)', onPrimary: '#001B2E', text: '#056E96', textHover: '#015B7D' },
  violet: { label: 'Violet', primary: '#A78BFA', hover: '#C4B5FD', subtle: 'rgba(167,139,250,0.14)', onPrimary: '#190B3D', text: '#6F51BA', textHover: '#5F3EA6' },
  gold: { label: 'Gold', primary: '#FBBF24', hover: '#FCD34D', subtle: 'rgba(251,191,36,0.14)', onPrimary: '#2B1B00', text: '#856200', textHover: '#6E5102' },
} as const satisfies Record<string, Accent>;

export type AccentId = keyof typeof ACCENTS;

export const DEFAULT_ACCENT: AccentId = 'cyan';

/**
 * Is this one of the five?
 *
 * An OWN-property check, not `id in ACCENTS` or `ACCENTS[id]`: the value arrives from the `#omos=`
 * fragment, which anyone can put in a link, and `ACCENTS['toString']` is a function — truthy, and
 * enough to write the string "undefined" into every filled button's background.
 */
export function isAccentId(id: unknown): id is AccentId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ACCENTS, id);
}

/** The custom properties an accent writes on <html>, for one resolved theme. `null` = clear them all
 *  and let the stylesheet decide (the default accent, in both themes). */
export function accentVars(id: unknown, theme: 'dark' | 'light'): Record<string, string> | null {
  // The default accent falls back to the stylesheet, and that is deliberate rather than an omission:
  // light theme's default button is a DARK blue that wants white ink, while every other accent paints
  // a BRIGHT button that wants dark ink. Clearing is the only way both themes get the right one.
  if (!isAccentId(id) || id === DEFAULT_ACCENT) return null;
  const a: Accent = ACCENTS[id];
  return {
    '--color-primary': theme === 'light' ? a.text : a.primary,
    '--color-primary-hover': theme === 'light' ? a.textHover : a.hover,
    '--color-primary-subtle': a.subtle,
    '--color-btn': a.primary,
    '--color-btn-hover': a.hover,
    // Set in the same breath as the fill, never separately — these two are one decision.
    '--color-on-primary': a.onPrimary,
  };
}

/** Every property accentVars can write, so clearing one accent never leaves another's behind. */
export const ACCENT_PROPS = [
  '--color-primary',
  '--color-primary-hover',
  '--color-primary-subtle',
  '--color-btn',
  '--color-btn-hover',
  '--color-on-primary',
] as const;
