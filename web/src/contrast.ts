// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Colour arithmetic for campaign colours — the ones an ADMIN chooses, as opposed to the theme's.
 *
 * A campaign's accent is data: any hex from a colour picker. So its ink cannot be a token; it has to
 * be worked out from the fill every time, and it has to be worked out the SAME way on every surface
 * that paints it — the tablet (core ui/theme/Color.kt `bestTextOn`), the admin's live preview, the keyed-entry
 * page and this app's mock tab strip. Before this module those were six different rules, and four of
 * the editor's own eight presets failed AA under the one the preview used (`luminance > 0.4 ? dark :
 * white`, which is exactly wrong between L≈0.18 and 0.4).
 *
 * REACT-FREE so server/src/ink-contrast.test.ts can import it and check every preset in CI.
 */

export type Rgb = [number, number, number];

/** #rgb, #rgba, #rrggbb or #rrggbbaa as RGB (alpha ignored — text and fills are drawn opaque), else
 *  null. The receipt accent admits all four shapes; kept identical to server/src/email.ts hexRgb so the
 *  preview and the email ink the same colour. */
export function hexToRgb(hex: string): Rgb | null {
  let h = (hex ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3,4}$/.test(h)) h = h.slice(0, 3).replace(/./g, (c) => c + c);
  else if (/^[0-9a-fA-F]{8}$/.test(h)) h = h.slice(0, 6);
  const m = /^([0-9a-fA-F]{6})$/.exec(h);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix `hex` toward `toward` by fraction `t` (0..1), returning a #rrggbb string. */
export function mixHex(hex: string, toward: string, t: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  if (!a || !b) return hex;
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance of a #rrggbb colour (0 = black, 1 = white). An unreadable value reads as
 *  mid-grey rather than throwing, because it arrives from a text box. */
export function relLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The near-black the kiosk draws on bright fills (core ui/theme/Color.kt `InkBlack`). */
export const INK_BLACK = '#0a0f14';
export const INK_WHITE = '#ffffff';

/**
 * The ink for a filled control of colour `fill`: whichever of near-black and white contrasts more.
 *
 * With PURE black the better of the two always clears 4.5:1 (the worst case, a mid-tone at L≈0.18,
 * is 4.58:1). The kiosk's softer near-black gives up a little of that — the same worst case is about
 * 4.37:1 — so for the narrow band of fills where neither reaches AA this falls back to pure black,
 * which by the arithmetic above always does. Mirrors `bestTextOn` in the Android kiosk exactly, so the
 * preview inks a tile the way the tablet will.
 */
export function bestInkOn(fill: string): string {
  const onBlack = contrastRatio(fill, INK_BLACK);
  const onWhite = contrastRatio(fill, INK_WHITE);
  if (Math.max(onBlack, onWhite) >= 4.5) return onBlack >= onWhite ? INK_BLACK : INK_WHITE;
  return INK_PURE_BLACK;
}

/** Only for the fills where the softer near-black falls short (see bestInkOn). */
export const INK_PURE_BLACK = '#000000';

/**
 * An admin's colour used as TEXT on a light surface — a receipt heading, a link — darkened toward black
 * just far enough to read (WCAG AA, 4.5:1). The brand colour itself still appears as a fill or a rule;
 * only the text that carries it is adjusted. Mirrors `textInkFor` in server/src/email.ts, so the
 * receipt preview inks its heading exactly as the email will.
 */
export function readableOn(fg: string, bg = INK_WHITE, target = 4.5): string {
  if (!hexToRgb(fg) || !hexToRgb(bg)) return fg;
  if (contrastRatio(fg, bg) >= target) return fg;
  for (let t = 0.02; t < 1; t += 0.02) {
    const c = mixHex(fg, INK_PURE_BLACK, t);
    if (contrastRatio(c, bg) >= target) return c;
  }
  return INK_PURE_BLACK;
}

/** What the tablet paints when a campaign's ACCENT is left blank (GivingHome.kt `accentOf` →
 *  PrimaryDark), so the admin's previews and chips use it too, never the viewer's OS accent. */
export const DEFAULT_CAMPAIGN_ACCENT = '#22d3ee';

/** What the tablet paints when a campaign's PRIMARY (background) is left blank. Not a fixed colour:
 *  both surfaces derive it from the accent — GivingHome.kt `lerp(accent, White, 0.35f)`, here in sRGB
 *  (the hair of difference is noted at computeScene) — so the editor's "default" names the colour the
 *  preview and the kiosk actually paint. It used to be a fixed mint, #a8f2b7, that neither ever drew. */
export function defaultCampaignPrimary(accent: string): string {
  return mixHex(accent || DEFAULT_CAMPAIGN_ACCENT, '#ffffff', 0.35);
}

/** Curated theme presets — a primary (background) + accent (buttons) that go well together. Picking
 *  one just POPULATES the two colour fields; the admin can still tweak either afterwards. Lives here
 *  rather than in the editor so the ink test can check each one. */
export const THEME_PRESETS: readonly { name: string; primary: string; accent: string }[] = [
  { name: 'Emerald', primary: '#a8f2b7', accent: '#1fa37a' },
  { name: 'Ocean', primary: '#bfe3ff', accent: '#2563eb' },
  { name: 'Sunset', primary: '#ffd9b3', accent: '#ea580c' },
  { name: 'Royal', primary: '#e0d4ff', accent: '#7c3aed' },
  { name: 'Rose', primary: '#ffd6e5', accent: '#e11d63' },
  { name: 'Gold', primary: '#fdeec2', accent: '#c99a2e' },
  { name: 'Teal', primary: '#bff2ee', accent: '#0d9488' },
  { name: 'Midnight', primary: '#1e293b', accent: '#38bdf8' },
];
