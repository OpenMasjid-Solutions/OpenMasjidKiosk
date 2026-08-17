// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// IS THE ADMIN PANEL READABLE ON EVERY WALLPAPER, IN BOTH THEMES?
//
// This lives in the server's test run because it is the only runner CI executes, and it needs
// nothing but the ability to read a file — the same way the manifest tests do.
//
// It exists because this exact class of bug shipped once. Every wallpaper is a dark gradient and
// they sat at the same CSS specificity as the light theme but later in the file, so they overwrote
// light mode's own scene: light glass composited over a near-black wallpaper to mid-grey, with
// dark-blue ink on top, under AA on every tab at once. It was then "fixed" by giving up — light
// mode kept the dark backdrop — and stayed that way until the port from OpenMasjidStudents.
//
// A screenshot would not catch a regression here; nine wallpapers times two themes is eighteen
// combinations nobody clicks through. Arithmetic does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../web/src/styles/tokens.css', import.meta.url), 'utf8');

/** Every `--name: value;` inside the block that starts with this selector. */
function block(selector: string): string {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return '';
  return css.slice(i, css.indexOf('\n}', i));
}
function tokenIn(src: string, name: string): string {
  const m = src.match(new RegExp('--' + name + ':\\s*([^;]+);'));
  return m ? m[1].trim() : '';
}

function rgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
/** The colour stops a gradient paints — text can end up over any of them. */
function stops(gradient: string): string[] {
  return [...gradient.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
}

const WALLPAPERS = ['aurora', 'ocean', 'twilight', 'berry', 'sunset', 'ember', 'forest', 'night', 'graphite'];
/** WCAG AA for body text. On-scene text also carries a text-shadow, so this is the floor, not the
 *  whole story — but a number that passes here cannot be one of the invisible ones. */
const AA = 4.5;

test('every wallpaper has a light-theme counterpart', () => {
  // Without one, the dark gradient overwrites light mode's scene and the whole theme goes grey.
  for (const w of WALLPAPERS) {
    assert.notEqual(block(`[data-wallpaper="${w}"]`), '', `no dark wallpaper "${w}"`);
    assert.notEqual(
      block(`[data-theme="light"][data-wallpaper="${w}"]`),
      '',
      `wallpaper "${w}" has no light counterpart — light mode will fall back to its dark gradient`,
    );
  }
});

test('the light counterparts win the cascade', () => {
  // Two attributes beat one, so they hold wherever they sit in the file. If someone ever "tidies"
  // these into single-attribute selectors, source order decides instead and the bug is back.
  for (const w of WALLPAPERS) {
    assert.ok(
      css.includes(`[data-theme="light"][data-wallpaper="${w}"]`),
      `"${w}" must be selected by BOTH attributes, not just the wallpaper`,
    );
  }
});

test('on-scene text clears WCAG AA on every wallpaper, in both themes', () => {
  const inkDark = tokenIn(block(':root,\n[data-theme="dark"]'), 'ink-scene') || '#F4F7FB';
  // The light theme's on-scene ink is re-stated after the wallpapers; take the LAST definition,
  // which is what the cascade actually applies.
  const lightInkMatches = [...css.matchAll(/\[data-theme="light"\]\s*\{[^}]*?--ink-scene:\s*([^;]+);/g)];
  const inkLight = lightInkMatches.length ? lightInkMatches[lightInkMatches.length - 1][1].trim() : '';
  assert.ok(/^#[0-9a-fA-F]{6}$/.test(inkDark), `dark on-scene ink not found (got ${inkDark})`);
  assert.ok(/^#[0-9a-fA-F]{6}$/.test(inkLight), `light on-scene ink not found (got ${inkLight})`);
  assert.notEqual(inkLight, inkDark, 'light mode must not reuse the dark scene ink — it now has a light scene');

  const failures: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    for (const w of WALLPAPERS) {
      const sel = theme === 'light' ? `[data-theme="light"][data-wallpaper="${w}"]` : `[data-wallpaper="${w}"]`;
      const fallback = theme === 'light' ? block('[data-theme="light"]') : block(':root,\n[data-theme="dark"]');
      const gradient = tokenIn(block(sel), 'scene-gradient') || tokenIn(fallback, 'scene-gradient');
      const ink = theme === 'light' ? inkLight : inkDark;
      const cols = stops(gradient);
      assert.ok(cols.length > 0, `${theme}/${w}: no gradient stops found`);
      for (const stop of cols) {
        const ratio = contrast(ink, stop);
        if (ratio < AA) failures.push(`${theme}/${w}: ${ink} on ${stop} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `on-scene text falls below ${AA}:1 —\n  ${failures.join('\n  ')}`);
});

test('panel text clears AA on the glass in both themes', () => {
  // The glass is translucent, so the worst realistic case is the card's own surface colour. This is
  // the text people read most; it must not be traded away to make the scene work.
  const pairs: [string, string, string][] = [
    ['dark', tokenIn(block(':root,\n[data-theme="dark"]'), 'color-ink'), tokenIn(block(':root,\n[data-theme="dark"]'), 'color-surface-raised')],
    ['light', tokenIn(block('[data-theme="light"]'), 'color-ink'), tokenIn(block('[data-theme="light"]'), 'color-surface-raised')],
  ];
  for (const [theme, ink, surface] of pairs) {
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(ink), `${theme}: --color-ink not a hex colour (${ink})`);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(surface), `${theme}: --color-surface-raised not a hex colour (${surface})`);
    const ratio = contrast(ink, surface);
    assert.ok(ratio >= AA, `${theme}: panel text ${ink} on ${surface} is ${ratio.toFixed(2)}:1, below ${AA}:1`);
  }
});

test('the two themes really are different themes', () => {
  // A guard against a merge or a "tidy" collapsing light mode back into the dark values, which is
  // how it would silently stop being a light mode at all.
  const dark = block(':root,\n[data-theme="dark"]');
  const light = block('[data-theme="light"]');
  for (const token of ['color-ink', 'color-surface', 'scene-base', 'scene-gradient', 'glass-bg']) {
    const d = tokenIn(dark, token);
    const l = tokenIn(light, token);
    assert.ok(l, `light theme is missing --${token}`);
    assert.notEqual(l, d, `--${token} is identical in both themes`);
  }
});
