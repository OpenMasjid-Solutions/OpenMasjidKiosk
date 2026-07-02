// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Per-browser presentation preferences (theme + wallpaper + accent), persisted in
 * localStorage and applied live. This is NOT masjid config — it mirrors how OpenMasjidOS
 * treats appearance, so the panel follows the viewer's OS light/dark setting and, when
 * opened from OpenMasjidOS, inherits the dashboard's look via the `#omos=` hand-off.
 *
 * The `#omos=…` fragment is attacker-craftable presentation input — we only ever read
 * theme/wallpaper/accent from it, never anything security-relevant. Live appearance sync
 * (polling /api/public/appearance) is added with the Fabric in a later slice.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { withBase } from './base';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  wallpaper: string;
  /** Accent colour id — matches the dashboard's accent when embedded. */
  accent: string;
  /** Mirror OpenMasjidOS's theme + wallpaper (on by default under the platform). */
  followOmos: boolean;
}

const KEY = 'omkiosk-prefs';
const DEFAULTS: Prefs = { theme: 'system', wallpaper: 'aurora', accent: 'cyan', followOmos: true };

/** Accent palette — mirrors OpenMasjidOS so the app matches the dashboard's accent.
 *  cyan is the tokens' built-in primary, so selecting it just clears the overrides. */
export const ACCENTS: Record<string, { primary: string; hover: string; subtle: string }> = {
  cyan: { primary: '#22D3EE', hover: '#67E8F9', subtle: 'rgba(34,211,238,0.12)' },
  teal: { primary: '#2DD4BF', hover: '#5EEAD4', subtle: 'rgba(45,212,191,0.12)' },
  emerald: { primary: '#34D399', hover: '#6EE7B7', subtle: 'rgba(52,211,153,0.14)' },
  sky: { primary: '#38BDF8', hover: '#7DD3FC', subtle: 'rgba(56,189,248,0.12)' },
  violet: { primary: '#A78BFA', hover: '#C4B5FD', subtle: 'rgba(167,139,250,0.14)' },
  gold: { primary: '#FBBF24', hover: '#FCD34D', subtle: 'rgba(251,191,36,0.14)' },
};

/** Apply the accent by overriding the primary CSS variables (or clearing them for the
 *  default cyan). Mirrors the platform's applyAccent. */
export function applyAccent(id: string): void {
  const el = document.documentElement;
  const a = ACCENTS[id];
  if (!a || id === 'cyan') {
    for (const p of ['--color-primary', '--color-primary-hover', '--color-primary-subtle', '--color-btn', '--color-btn-hover']) {
      el.style.removeProperty(p);
    }
    return;
  }
  el.style.setProperty('--color-primary', a.primary);
  el.style.setProperty('--color-primary-hover', a.hover);
  el.style.setProperty('--color-primary-subtle', a.subtle);
  el.style.setProperty('--color-btn', a.primary);
  el.style.setProperty('--color-btn-hover', a.hover);
}

export const WALLPAPERS: Record<string, { label: string }> = {
  aurora: { label: 'Aurora' },
  ocean: { label: 'Ocean' },
  twilight: { label: 'Twilight' },
  berry: { label: 'Berry' },
  sunset: { label: 'Sunset' },
  ember: { label: 'Ember' },
  forest: { label: 'Forest' },
  night: { label: 'Night' },
  graphite: { label: 'Graphite' },
};

export function resolveTheme(theme: Prefs['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function applyTheme(theme: Prefs['theme']): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}

export function applyWallpaper(id: string): void {
  document.documentElement.setAttribute('data-wallpaper', WALLPAPERS[id] ? id : 'aurora');
}

const THEME_VALUES = ['system', 'dark', 'light'] as const;
function normTheme(v: unknown): Prefs['theme'] {
  return (THEME_VALUES as readonly string[]).includes(String(v)) ? (v as Prefs['theme']) : 'system';
}

/** Appearance handed over by OpenMasjidOS — we use theme + wallpaper + accent only. */
interface OmosAppearance {
  theme?: string;
  wallpaper?: string;
  accent?: string;
}

function appearancePatch(p: OmosAppearance): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (p.theme != null) out.theme = normTheme(p.theme);
  if (typeof p.wallpaper === 'string') out.wallpaper = p.wallpaper;
  if (typeof p.accent === 'string') out.accent = p.accent;
  return out;
}

/** Read the `#omos=…` appearance fragment OpenMasjidOS adds when it opens us (base64url
 *  JSON). Applied once, then the hash is cleared. */
function readOmosFragment(): OmosAppearance | null {
  const m = location.hash.match(/omos=([^&]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes)) as OmosAppearance;
    history.replaceState(null, '', location.pathname + location.search);
    return p;
  } catch {
    return null;
  }
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — just won't persist */
  }
}

export const prefsStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(part: Partial<Prefs>) {
    state = { ...state, ...part };
    persist();
    if (part.theme !== undefined) applyTheme(state.theme);
    if (part.wallpaper !== undefined) applyWallpaper(state.wallpaper);
    if (part.accent !== undefined) applyAccent(state.accent);
    for (const l of listeners) l();
  },
  /** Apply persisted prefs on first load, inherit any OpenMasjidOS hand-off, and follow
   *  OS theme changes live. */
  hydrate() {
    const omos = readOmosFragment();
    if (omos) {
      state = { ...state, ...appearancePatch(omos), followOmos: true };
      persist();
    }
    applyTheme(state.theme);
    applyWallpaper(state.wallpaper);
    applyAccent(state.accent);
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme('system');
    });
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, prefsStore.get);
}

/** One-shot pull of OpenMasjidOS's current appearance via our OWN same-origin relay
 *  (GET /api/public/appearance) — our page is HTTPS but the platform's appearance endpoint
 *  is HTTP, so a direct cross-origin fetch would be mixed-content blocked; the server
 *  fetches the platform side. Only theme + wallpaper + accent are applied. */
export async function fetchOmosAppearance(): Promise<void> {
  try {
    const res = await fetch(withBase('/api/public/appearance'), { credentials: 'omit' });
    if (!res.ok) return;
    if (!prefsStore.get().followOmos) return;
    prefsStore.patch(appearancePatch((await res.json()) as OmosAppearance));
  } catch {
    /* platform offline — keep the current look (the #omos fragment already themed us) */
  }
}

/** While embedded under OpenMasjidOS and "follow" is on, keep theme + wallpaper + accent in
 *  sync with the dashboard (poll periodically and whenever the page regains focus). The
 *  one-shot #omos fragment is the primary hand-off; this is live sync. */
export function useOmosAppearanceSync(embedded: boolean | undefined): void {
  const { followOmos } = usePrefs();
  useEffect(() => {
    if (!embedded || !followOmos) return;
    void fetchOmosAppearance();
    const iv = window.setInterval(() => void fetchOmosAppearance(), 45_000);
    const onFocus = () => void fetchOmosAppearance();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('focus', onFocus);
    };
  }, [embedded, followOmos]);
}
