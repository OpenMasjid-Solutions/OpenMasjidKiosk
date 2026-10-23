// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Per-browser presentation preferences (theme, wallpaper, accent, writing direction), persisted in
 * localStorage and applied live. This is NOT masjid config — it mirrors how OpenMasjidOS treats
 * appearance, so the panel looks like the dashboard it was opened from.
 *
 * Two ways in, both from the platform (app UI spec §1):
 *   · the `#omos=…` launch fragment the dashboard appends when it opens us — read on first paint by
 *     the inline script in index.html, then here, then removed from the address bar;
 *   · our own same-origin relay of `GET /api/public/appearance`, polled every 45 s and on focus so a
 *     theme change in the dashboard follows us while we are open. (Same-origin because our page is
 *     HTTPS and the platform's endpoint is plain HTTP — a direct call would be mixed content.)
 *
 * The fragment is attacker-craftable presentation input: anyone can put `#omos=` in a link. So only
 * presentation is ever read from it, every value is checked against a fixed list, and nothing
 * security-relevant can be steered by it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { withBase } from './base';
import { ACCENT_PROPS, accentVars, DEFAULT_ACCENT, isAccentId } from './accents';
import { isRtlLang, isWallpaperId, WALLPAPER_IDS } from './appearance';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  wallpaper: string;
  /** Optional custom wallpaper image URL — overrides the preset when set. */
  wallpaperImage: string;
  /** Accent id, one of the platform's five (accents.ts). */
  accent: string;
  /** The dashboard's language. Only its DIRECTION is used — see applyDir. */
  lang: string;
  /** Mirror OpenMasjidOS's theme (on by default under the platform). */
  followOmos: boolean;
}

const KEY = 'omkiosk-prefs';
const DEFAULTS: Prefs = { theme: 'system', wallpaper: 'aurora', wallpaperImage: '', accent: DEFAULT_ACCENT, lang: 'en', followOmos: true };

export { ACCENTS } from './accents';

/** The nine wallpapers by id — labels are the platform's; the ids live in appearance.ts. */
export const WALLPAPERS: Record<(typeof WALLPAPER_IDS)[number], { label: string }> = {
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

export { isRtlLang };

export function resolveTheme(theme: Prefs['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

/** The accent's custom properties for the RESOLVED theme. Re-run whenever either changes: in light
 *  theme the accent's foreground is a darker shade than its fill (accents.ts explains why), so a
 *  theme flip alone changes what the accent writes. */
export function applyAccent(id: string, theme: 'dark' | 'light' = currentTheme()): void {
  const el = document.documentElement;
  const vars = accentVars(id, theme);
  for (const p of ACCENT_PROPS) el.style.removeProperty(p);
  if (vars) for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Prefs['theme']): void {
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', resolved);
  // The browser's own chrome (a phone's address bar) takes the page colour too.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#F0F9FF' : '#030D1A');
}

export function applyWallpaper(id: string): void {
  document.documentElement.setAttribute('data-wallpaper', isWallpaperId(id) ? id : 'aurora');
}

/**
 * Mirror the dashboard's writing direction.
 *
 * `dir` only — `lang` deliberately stays "en". Every string in this panel is English, and a page
 * that told a screen reader it was Arabic would have English read out with Arabic pronunciation
 * rules. The layout mirrors so the panel sits beside a mirrored dashboard; the text stays what it is,
 * and app.css isolates each run of it (`unicode-bidi: plaintext`) so an English sentence keeps its
 * full stop at the end in an RTL page.
 *
 * `?dir=rtl` / `?dir=ltr` in the address overrides it for this page load only — the spec's "test by
 * forcing dir=rtl and looking", without changing the dashboard's language to do it.
 */
export function applyDir(lang: string): void {
  const forced = new URLSearchParams(location.search).get('dir');
  const dir = forced === 'rtl' || forced === 'ltr' ? forced : isRtlLang(lang) ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('dir', dir);
}

const THEME_VALUES = ['system', 'dark', 'light'] as const;
function normTheme(v: unknown): Prefs['theme'] {
  return (THEME_VALUES as readonly string[]).includes(String(v)) ? (v as Prefs['theme']) : 'system';
}

/** Appearance handed over by OpenMasjidOS. `logo` is read by App.tsx from the relay directly. */
interface OmosAppearance {
  theme?: unknown;
  wallpaper?: unknown;
  wallpaperImage?: unknown;
  accent?: unknown;
  lang?: unknown;
}

function appearancePatch(p: OmosAppearance): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (p.theme != null) out.theme = normTheme(p.theme);
  if (isWallpaperId(p.wallpaper)) out.wallpaper = p.wallpaper;
  // An unknown accent is the DEFAULT accent, not "leave whatever we had" — the dashboard is saying
  // what it looks like now, and it never sends one we would have to guess about.
  if (p.accent != null) out.accent = isAccentId(p.accent) ? p.accent : DEFAULT_ACCENT;
  if (typeof p.lang === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(p.lang)) out.lang = p.lang;
  // wallpaperImage is stored AS-IS — the OpenMasjidOS admin types a full image URL, exactly as in the
  // other apps; no proxy. The Scene sanitizes it before use (safeImageUrl: http(s)/data:image only,
  // nothing that could break out of url("…")).
  if (typeof p.wallpaperImage === 'string') out.wallpaperImage = p.wallpaperImage;
  return out;
}

/** Read the `#omos=…` fragment (base64url JSON of UTF-8), then take it — and only it — out of the
 *  address bar. The rest of the hash is this panel's router (#settings, #campaign/<id>), so it
 *  stays: a dashboard deep link like `#settings&omos=…` must still land on Settings. */
function readOmosFragment(): OmosAppearance | null {
  const m = /[#&]omos=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return null;
  let parsed: OmosAppearance | null = null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    parsed = v && typeof v === 'object' ? (v as OmosAppearance) : null;
  } catch {
    parsed = null;
  }
  const rest = location.hash
    .replace(/^#/, '')
    .split('&')
    .filter((part) => part && !part.startsWith('omos='))
    .join('&');
  history.replaceState(history.state, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  return parsed;
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    // followOmos is a SESSION flag, never persisted: every load starts by following the OS, so the
    // dashboard's theme passes through on open + refresh. A manual light/dark toggle sets it false for
    // this session only; a refresh returns to following the OS.
    return {
      ...DEFAULTS,
      ...saved,
      theme: normTheme(saved.theme ?? DEFAULTS.theme),
      accent: isAccentId(saved.accent) ? saved.accent : DEFAULT_ACCENT,
      lang: typeof saved.lang === 'string' ? saved.lang : DEFAULTS.lang,
      followOmos: true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    const { followOmos: _session, ...keep } = state;
    localStorage.setItem(KEY, JSON.stringify(keep));
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
    const before = state;
    state = { ...state, ...part };
    if (
      before.theme === state.theme &&
      before.wallpaper === state.wallpaper &&
      before.wallpaperImage === state.wallpaperImage &&
      before.accent === state.accent &&
      before.lang === state.lang &&
      before.followOmos === state.followOmos
    ) {
      return; // the 45 s poll usually changes nothing; don't re-render the whole panel for it
    }
    persist();
    if (part.theme !== undefined) applyTheme(state.theme);
    if (part.wallpaper !== undefined) applyWallpaper(state.wallpaper);
    if (part.theme !== undefined || part.accent !== undefined) applyAccent(state.accent);
    if (part.lang !== undefined) applyDir(state.lang);
    for (const l of listeners) l();
  },
  /** Apply persisted prefs on first load, inherit any OpenMasjidOS hand-off, and follow OS theme
   *  changes live. The inline script in index.html has already done the same before first paint;
   *  this repeats it from the full module so both agree, then takes over. */
  hydrate() {
    const omos = readOmosFragment();
    if (omos) {
      state = { ...state, ...appearancePatch(omos), followOmos: true };
      persist();
    }
    applyTheme(state.theme);
    applyWallpaper(state.wallpaper);
    applyAccent(state.accent);
    applyDir(state.lang);
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.theme === 'system') {
        applyTheme('system');
        applyAccent(state.accent);
      }
    });
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, prefsStore.get);
}

/** The masjid's logo, as the platform reported it through our relay: a same-origin path, or '' when
 *  none is set. Held outside Prefs because it is not a preference and must never be persisted. */
let omosLogo = '';
const logoListeners = new Set<() => void>();
export function useOmosLogo(): string {
  return useSyncExternalStore(
    (l) => {
      logoListeners.add(l);
      return () => logoListeners.delete(l);
    },
    () => omosLogo,
    () => omosLogo,
  );
}

/** One pull of OpenMasjidOS's current appearance via our OWN same-origin relay. */
export async function fetchOmosAppearance(): Promise<void> {
  try {
    const res = await fetch(withBase('/api/public/appearance'), { credentials: 'omit' });
    if (!res.ok) return;
    const body = (await res.json()) as OmosAppearance & { logo?: unknown };
    const patch = appearancePatch(body);
    // The panel only lets you override light/dark (there's no wallpaper/accent picker — those belong
    // to OpenMasjidOS). So wallpaper, image, accent and direction ALWAYS follow the dashboard; only
    // the THEME is held back once you've picked one by hand this session (followOmos = false).
    if (!prefsStore.get().followOmos) delete patch.theme;
    prefsStore.patch(patch);
    // The relay rewrites the platform's logo to our own same-origin path; anything else is refused.
    const logo = typeof body.logo === 'string' && body.logo === '/api/public/logo' ? body.logo : '';
    if (logo !== omosLogo) {
      omosLogo = logo;
      for (const l of logoListeners) l();
    }
  } catch {
    /* platform offline — keep the current look (the #omos fragment already themed us) */
  }
}

// ── Background-aware readability ──────────────────────────────────────────────
// Sample a background image's average luminance so text on top of it stays readable
// (dark text on light images, light text on dark). Works for same-origin / CORS-enabled
// images and data: URLs; if the canvas is tainted (host sent no CORS header) we can't
// read the pixels, so we fall back to the caller's default theme.
const lumCache = new Map<string, 'light' | 'dark'>();

function sampleLuminance(url: string): Promise<'light' | 'dark' | null> {
  const cached = lumCache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const n = 16;
        const canvas = document.createElement('canvas');
        canvas.width = n;
        canvas.height = n;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, n, n);
        const { data } = ctx.getImageData(0, 0, n, n);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          count++;
        }
        const avg = count ? sum / count : 0; // 0..255
        const res: 'light' | 'dark' = avg > 140 ? 'light' : 'dark';
        lumCache.set(url, res);
        resolve(res);
      } catch {
        resolve(null); // tainted canvas — image host sent no CORS header
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The theme ('light'|'dark') that reads best over a background image. Returns
 *  `fallback` when there's no image or it can't be sampled (cross-origin). */
export function useReadableTheme(imageUrl: string | undefined, fallback: 'light' | 'dark'): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(fallback);
  useEffect(() => {
    if (!imageUrl) {
      setTheme(fallback);
      return;
    }
    let live = true;
    void sampleLuminance(imageUrl).then((r) => {
      if (live) setTheme(r ?? fallback);
    });
    return () => {
      live = false;
    };
  }, [imageUrl, fallback]);
  return theme;
}

/** Keep wallpaper, accent and direction (and theme, unless overridden this session) in sync with
 *  the dashboard — on load, every 45 s, and whenever the page regains focus or becomes visible.
 *  Deliberately does NOT gate on being embedded: our own relay returns {} when standalone, which is a
 *  harmless no-op, and gating on a possibly-miscomputed flag was a way for inheritance to silently
 *  never start. */
export function useOmosAppearanceSync(): void {
  useEffect(() => {
    void fetchOmosAppearance();
    const iv = window.setInterval(() => void fetchOmosAppearance(), 45_000);
    const onFocus = () => void fetchOmosAppearance();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchOmosAppearance();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
