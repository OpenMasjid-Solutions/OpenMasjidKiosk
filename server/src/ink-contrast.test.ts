// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// DOES THE INK ON AN ADMIN-CHOSEN COLOUR ALWAYS READ?
//
// A campaign's colours are data — anything the colour picker allows — so the ink on a filled
// "Donate" band has to be worked out from the fill. It used to be `luminance > 0.4 ? dark : white`,
// which is exactly wrong between L≈0.18 and 0.4: five of the editor's own eight presets drew white at
// 2.6–3.7:1 on the giving screen a donor reads. bestInkOn (web) and bestTextOn (the tablet) now pick
// whichever of near-black and white reads better, falling back to pure black for the narrow band
// where the softer near-black cannot — and this proves the fallback holds for EVERY colour, not just
// the ones someone thought to try.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCENTS } from '../../web/src/accents';
import { bestInkOn, contrastRatio, readableOn, THEME_PRESETS } from '../../web/src/contrast';

const AA = 4.5;

test('every curated preset and every platform accent gets readable ink', () => {
  const fills = [
    ...THEME_PRESETS.flatMap((p) => [p.accent, p.primary]),
    ...Object.values(ACCENTS).map((a) => a.primary),
  ];
  for (const fill of fills) {
    const ink = bestInkOn(fill);
    const r = contrastRatio(ink, fill);
    assert.ok(r >= AA, `${ink} on ${fill} is ${r.toFixed(2)}:1`);
  }
});

test('bestInkOn clears AA for every colour in the cube', () => {
  // 17 steps per channel (0x00, 0x10, … 0xff) — 4,913 colours, including the mid-tones that break a
  // threshold rule.
  const steps = Array.from({ length: 17 }, (_, i) => Math.min(255, i * 16));
  let worst = { r: 99, fill: '' };
  for (const r of steps) for (const g of steps) for (const b of steps) {
    const fill = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const ratio = contrastRatio(bestInkOn(fill), fill);
    if (ratio < worst.r) worst = { r: ratio, fill };
  }
  assert.ok(worst.r >= AA, `worst case ${worst.fill} at ${worst.r.toFixed(2)}:1`);
});

test('an admin colour used as text on white is darkened just enough, and only when needed', () => {
  assert.equal(readableOn('#0a0f14'), '#0a0f14', 'a dark colour is left alone');
  for (const fg of ['#1FA37A', '#D4AF37', '#22d3ee', '#ffffff', '#fbbf24', '#e11d63', '#7c3aed']) {
    const out = readableOn(fg);
    assert.ok(contrastRatio(out, '#ffffff') >= AA, `${fg} → ${out} is ${contrastRatio(out, '#ffffff').toFixed(2)}:1`);
  }
  assert.equal(readableOn('not a colour'), 'not a colour', 'garbage passes through for the caller to gate');
});
