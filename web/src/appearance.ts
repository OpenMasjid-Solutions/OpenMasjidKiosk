// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The fixed lists the dashboard's appearance is checked against — wallpapers and right-to-left
 * languages. React-free, because the pre-paint script in index.html is built from them too
 * (vite.config.ts inlines them), and that script runs before any module has loaded.
 */

/** The platform's nine wallpapers, by id (OpenMasjidOS packages/ui/src/lib/prefs.ts). */
export const WALLPAPER_IDS = ['aurora', 'ocean', 'twilight', 'berry', 'sunset', 'ember', 'forest', 'night', 'graphite'] as const;

/** Languages written right to left, by base subtag. Wider than the dashboard's own two (ar, ur) on
 *  purpose: a language that is RTL is RTL whichever app is asking, so a future Farsi dashboard
 *  mirrors this panel too. */
export const RTL_LANGS = ['ar', 'ur', 'fa', 'he', 'ps', 'sd', 'ug', 'yi', 'ckb', 'dv'] as const;

export function isRtlLang(lang: string): boolean {
  const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
  return (RTL_LANGS as readonly string[]).includes(base);
}

export function isWallpaperId(id: unknown): id is (typeof WALLPAPER_IDS)[number] {
  return typeof id === 'string' && (WALLPAPER_IDS as readonly string[]).includes(id);
}
