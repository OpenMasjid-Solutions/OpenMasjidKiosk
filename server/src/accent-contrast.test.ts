// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// DO ALL FIVE ACCENTS READ, IN BOTH THEMES — INCLUDING THE INK ON A FILLED BUTTON?
//
// The app UI spec's checklist item, measured rather than eyeballed. The masjid chooses one of five
// accents in OpenMasjidOS and it arrives here at runtime, so there are ten looks, and before this the
// panel got four of them wrong: the accent's fill was written without its ink, so light theme kept
// white on a bright accent — white on gold measured 1.67:1 on every primary button at once. And in
// light theme the accent was also the colour of every link, the focus ring and the active dock icon,
// which on a light surface measured 1.67–2.72:1.
//
// This lives in the server's run because it is the only runner CI executes (the same reason
// theme-contrast.test.ts does); it imports the web's accent table directly, which is React-free for
// exactly this reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCENTS, ACCENT_PROPS, accentVars, isAccentId, type Accent } from '../../web/src/accents';
import { contrastRatio, mixHex } from '../../web/src/contrast';

const AA = 4.5;
/** Every light surface text can sit on: page, panel, and the hover/overlay surface list rows take. */
const LIGHT_SURFACES = ['#FFFFFF', '#F0F9FF', '#E0F2FE'];
const DARK_SURFACES = ['#030D1A', '#0A1828', '#0F2040'];

/** An rgba() wash composited over a surface, as a hex. */
function wash(rgba: string, over: string): string {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba);
  assert.ok(m, `not an rgba(): ${rgba}`);
  const hex = `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  return mixHex(over, hex, Number(m[4]));
}

const entries = Object.entries(ACCENTS) as [string, Accent][];

test('the table is the platform’s five, and nothing else', () => {
  assert.deepEqual(Object.keys(ACCENTS).sort(), ['cyan', 'gold', 'sky', 'teal', 'violet']);
});

test('every accent’s ink reads on its own fill, and on its hover', () => {
  for (const [id, a] of entries) {
    for (const [what, fill] of [['fill', a.primary], ['hover', a.hover]] as const) {
      const r = contrastRatio(a.onPrimary, fill);
      assert.ok(r >= AA, `${id}: onPrimary ${a.onPrimary} on ${what} ${fill} is ${r.toFixed(2)}:1`);
    }
  }
});

test('in light theme the accent’s foreground shade reads on every light surface and on its own wash', () => {
  for (const [id, a] of entries) {
    const backgrounds = [...LIGHT_SURFACES, ...LIGHT_SURFACES.map((s) => wash(a.subtle, s))];
    for (const bg of backgrounds) {
      const r = contrastRatio(a.text, bg);
      assert.ok(r >= AA, `${id}: light text ${a.text} on ${bg} is ${r.toFixed(2)}:1`);
      const h = contrastRatio(a.textHover, bg);
      assert.ok(h >= AA, `${id}: light hover ${a.textHover} on ${bg} is ${h.toFixed(2)}:1`);
    }
  }
});

test('in dark theme the accent itself reads on every dark surface and on its own wash', () => {
  for (const [id, a] of entries) {
    for (const bg of [...DARK_SURFACES, ...DARK_SURFACES.map((s) => wash(a.subtle, s))]) {
      const r = contrastRatio(a.primary, bg);
      assert.ok(r >= AA, `${id}: ${a.primary} on ${bg} is ${r.toFixed(2)}:1`);
    }
  }
});

test('the fill and its ink are always set together', () => {
  // "Set the ink in the same breath as the fill, or don't set either." (spec §3)
  for (const [id] of entries) {
    for (const theme of ['dark', 'light'] as const) {
      const v = accentVars(id, theme);
      if (id === 'cyan') {
        assert.equal(v, null, 'the default accent defers to the stylesheet in both themes');
        continue;
      }
      assert.ok(v, `${id}/${theme}: no vars`);
      assert.ok(v['--color-btn'] && v['--color-on-primary'], `${id}/${theme}: fill without its ink`);
      for (const k of Object.keys(v)) assert.ok((ACCENT_PROPS as readonly string[]).includes(k), `${k} is not cleared on the next change`);
      // Light theme: foreground is the darker shade, the fill stays the bright accent.
      const a = ACCENTS[id as keyof typeof ACCENTS];
      assert.equal(v['--color-primary'], theme === 'light' ? a.text : a.primary);
      assert.equal(v['--color-btn'], a.primary);
    }
  }
});

test('an id from a crafted link cannot reach an inherited property', () => {
  // `ACCENTS['toString']` is a function: truthy, and enough to write "undefined" into every button.
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', 'emerald', 'CYAN']) {
    assert.equal(isAccentId(bad), false, bad);
    assert.equal(accentVars(bad, 'light'), null, bad);
  }
  assert.equal(isAccentId(undefined), false);
  assert.equal(isAccentId(42), false);
});
