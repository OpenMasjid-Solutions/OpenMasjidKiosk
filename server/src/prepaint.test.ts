// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// IS THE MASJID'S LOOK ON <html> BEFORE THE FIRST FRAME?
//
// The inline script in web/index.html runs before any module has loaded; it is what stops a
// light-theme masjid seeing a dark flash, a gold masjid seeing cyan for a moment, or an Arabic
// dashboard's panel painting left-to-right first. It reads the dashboard's `#omos=` launch fragment
// (app UI spec §1a), falls back to what this browser saved, and writes theme, wallpaper, accent (fill
// AND ink) and direction onto <html>.
//
// This runs THAT script — extracted from the real file, with its three tables filled in the way
// vite.config.ts fills them at build time — against a stub document, so a regression in it fails here
// rather than as a flash nobody can reproduce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ACCENTS, accentVars } from '../../web/src/accents';
import { RTL_LANGS, WALLPAPER_IDS } from '../../web/src/appearance';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../../web/vite.config.ts', import.meta.url), 'utf8');

/** The first inline <script> (no src) in the head — the pre-paint one. */
function prepaintSource(): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'no inline script in index.html');
  let src = m[1];
  const accentTable: Record<string, { dark: Record<string, string>; light: Record<string, string> }> = {};
  for (const id of Object.keys(ACCENTS)) {
    const d = accentVars(id, 'dark');
    const l = accentVars(id, 'light');
    if (d && l) accentTable[id] = { dark: d, light: l };
  }
  for (const [marker, value] of [
    ['/*__ACCENT_VARS__*/{}', JSON.stringify(accentTable)],
    ['/*__WALLPAPER_IDS__*/[]', JSON.stringify(WALLPAPER_IDS)],
    ['/*__RTL_LANGS__*/[]', JSON.stringify(RTL_LANGS)],
  ] as const) {
    assert.ok(src.includes(marker), `index.html lost its ${marker} marker`);
    assert.ok(viteConfig.includes(`'${marker}'`), `vite.config.ts no longer fills ${marker}`);
    src = src.split(marker).join(value);
  }
  return src;
}

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function run(opts: { hash?: string; search?: string; saved?: unknown; prefersLight?: boolean }) {
  const attrs: Record<string, string> = { 'data-theme': 'dark', 'data-wallpaper': 'aurora', dir: 'ltr' };
  const style: Record<string, string> = {};
  const meta = { content: '#030D1A', setAttribute(_k: string, v: string) { this.content = v; } };
  const sandbox = {
    document: {
      documentElement: {
        setAttribute: (k: string, v: string) => { attrs[k] = v; },
        getAttribute: (k: string) => attrs[k] ?? null,
        style: { setProperty: (k: string, v: string) => { style[k] = v; } },
      },
      querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? meta : null),
    },
    window: { matchMedia: (q: string) => ({ matches: q.includes('light') ? !!opts.prefersLight : !opts.prefersLight }) },
    localStorage: { getItem: (k: string) => (k === 'omkiosk-prefs' && opts.saved !== undefined ? JSON.stringify(opts.saved) : null) },
    location: { hash: opts.hash ?? '', search: opts.search ?? '' },
    atob, TextDecoder, URLSearchParams, JSON, Object, String, Uint8Array,
  };
  vm.runInNewContext(prepaintSource(), sandbox);
  return { attrs, style, meta: meta.content };
}

test('with nothing to go on, it follows the device and stays left-to-right', () => {
  const r = run({ prefersLight: false });
  assert.equal(r.attrs['data-theme'], 'dark');
  assert.equal(r.attrs.dir, 'ltr');
  assert.deepEqual(r.style, {});
  assert.equal(run({ prefersLight: true }).attrs['data-theme'], 'light');
});

test('the dashboard’s fragment wins, and brings the accent’s INK with its fill', () => {
  const r = run({ hash: `#omos=${b64url({ v: 1, theme: 'light', wallpaper: 'ocean', accent: 'gold', lang: 'ar' })}`, saved: { theme: 'dark', accent: 'teal' } });
  assert.equal(r.attrs['data-theme'], 'light');
  assert.equal(r.attrs['data-wallpaper'], 'ocean');
  assert.equal(r.attrs.dir, 'rtl');
  assert.equal(r.style['--color-btn'], ACCENTS.gold.primary);
  assert.equal(r.style['--color-on-primary'], ACCENTS.gold.onPrimary);
  assert.equal(r.style['--color-primary'], ACCENTS.gold.text, 'light theme uses the darker foreground shade');
  assert.equal(r.meta, '#F0F9FF');
});

test('a fragment after the router’s own hash is still read', () => {
  const r = run({ hash: `#settings&omos=${b64url({ theme: 'light' })}` });
  assert.equal(r.attrs['data-theme'], 'light');
});

test('without a fragment it restores what this browser saved', () => {
  const r = run({ saved: { theme: 'dark', accent: 'violet', wallpaper: 'forest', lang: 'ur' } });
  assert.equal(r.attrs['data-theme'], 'dark');
  assert.equal(r.attrs['data-wallpaper'], 'forest');
  assert.equal(r.attrs.dir, 'rtl');
  assert.equal(r.style['--color-primary'], ACCENTS.violet.primary);
});

test('“system” is resolved before it is written', () => {
  assert.equal(run({ hash: `#omos=${b64url({ theme: 'system' })}`, prefersLight: true }).attrs['data-theme'], 'light');
});

test('anything a crafted link sends that is not on the lists is ignored', () => {
  const r = run({ hash: `#omos=${b64url({ accent: 'toString', wallpaper: '../x', theme: 'neon' })}`, prefersLight: false });
  assert.deepEqual(r.style, {}, 'no accent written for an inherited property name');
  assert.equal(r.attrs['data-wallpaper'], 'aurora');
  assert.equal(r.attrs['data-theme'], 'dark');
  // A fragment that isn't base64 JSON at all falls back to the saved look.
  assert.equal(run({ hash: '#omos=%%%', saved: { theme: 'light' } }).attrs['data-theme'], 'light');
  assert.equal(run({ hash: '#omos=bm90anNvbg', saved: { theme: 'light' } }).attrs['data-theme'], 'light');
});

test('?dir= forces the direction for one page load, to test RTL by looking', () => {
  assert.equal(run({ search: '?dir=rtl' }).attrs.dir, 'rtl');
  assert.equal(run({ search: '?dir=ltr', saved: { lang: 'ar' } }).attrs.dir, 'ltr');
});

test('the default accent writes nothing — the stylesheet carries both themes’ own', () => {
  assert.deepEqual(run({ saved: { accent: 'cyan', theme: 'light' } }).style, {});
});
