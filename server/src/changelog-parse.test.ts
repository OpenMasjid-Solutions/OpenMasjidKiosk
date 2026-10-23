// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// DOES "WHAT'S NEW" SHOW THE RELEASE NOTES A MASJID ADMIN IS MEANT TO READ?
//
// It did not, quite. The panel's What's new window parses the CHANGELOG.md shipped inside the image
// (CLAUDE.md rule 7b: the file is a product surface, not a git artefact), and the parser was written
// for a file of five constructs. The file grew two more. An indented "also fixed" sub-bullet kept its
// leading spaces, failed the bullet match, and was glued onto its parent as " - Also fixed: …" — so
// the 0.12.0 refund note read "…out by a thousand, the same way. - Also fixed: a refund could stop
// working…". And *italic* / _italic_ were never rendered at all, so the asterisks and underscores
// showed. Measured on the real file: 24 sub-bullets swallowed, 24 items with Markdown on screen.
//
// So these tests run the parser on the REAL CHANGELOG.md, not on a fixture — the failure was the file
// outgrowing the parser, and a fixture only ever contains what its author thought of. They lean on
// released `## X.Y.Z` sections only, never on `## Unreleased`: released sections are never rewritten
// (rule 7b), they are identical on `dev` and `main`, and `## Unreleased` does not exist on `main` at
// all, so a test that needed it would fail the moment a release lands.
//
// This lives in the server's test run because it is the only runner CI executes — the same reason
// `refund-amount.test.ts` reaches into `web/src/`. The parser is React-free (`web/src/changelog.ts`)
// precisely so that it can be imported here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inlineSpans, parseChangelog, type InlineSpan, type Release } from '../../web/src/changelog';

const md = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const releases = parseChangelog(md);

/** Every string a reader sees as one line of the notes: each item and each sub-point under it. */
const allTexts = (rs: Release[]): string[] => rs.flatMap((r) => r.items.flatMap((it) => [it.text, ...it.children]));

/** The plain-text runs of a rendered line, leaving out code spans (whose content is shown verbatim on
 *  purpose — a backtick-quoted `payment_create_failed` is supposed to keep its underscores). */
const plainRuns = (spans: InlineSpan[]): string[] =>
  spans.flatMap((s) => (s.kind === 'text' ? [s.text] : s.kind === 'code' ? [] : plainRuns(s.children)));

const release = (version: string): Release => {
  const r = releases.find((x) => x.version === version);
  assert.ok(r, `the changelog has a ## ${version} section`);
  return r;
};

test('every released "## X.Y.Z" heading produces a release, in file order, with notes in it', () => {
  const headings = [...md.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
  // A sanity floor, not a count: if the regex above ever stops matching, "every heading" is vacuous.
  assert.ok(headings.length >= 10, `found ${headings.length} released headings`);
  const parsed = releases.map((r) => r.version).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  assert.deepEqual(parsed, headings);
  for (const v of headings) assert.ok(release(v).items.length > 0, `## ${v} has at least one note`);
  // …and nothing else became a release: one per `## ` line, Unreleased included where it exists.
  assert.equal(releases.length, (md.match(/^## /gm) ?? []).length);
});

test('the sub-bullets under the 0.12.0 refund note are its children, not part of its text', () => {
  const refund = release('0.12.0').items.find((it) => it.text.startsWith('**Fixed: refunding part of a donation'));
  assert.ok(refund, 'the 0.12.0 refund note is there');
  // The headline ends where the Markdown said it did…
  assert.ok(refund.text.endsWith('were out by a thousand, the same way.'), refund.text.slice(-80));
  assert.equal(refund.children.length, 2);
  // …and each sub-point is whole: its wrapped second and third lines joined to IT, not to the headline.
  assert.ok(refund.children[0].startsWith('Also fixed: a refund could stop working'));
  assert.ok(refund.children[0].endsWith('completely ordinary, and now it works.'));
  assert.ok(refund.children[1].startsWith('Refunds are now recorded in the audit trail.'));
  assert.ok(refund.children[1].endsWith('the only one that moves money *out* — was not.'));
});

test('no sub-bullet anywhere in the file is merged into the line above it as a raw " - "', () => {
  // Stated per sub-bullet rather than as "no text contains ' - '", which would one day fail on a
  // perfectly good "ages 5 - 11" in a release note. What must never happen is THIS body, glued on.
  const subBullets = [...md.matchAll(/^[ \t]+[-*][ \t]+(.+)$/gm)].map((m) => m[1].trimEnd());
  assert.ok(subBullets.length > 0, 'the changelog has indented sub-bullets to check');
  const texts = allTexts(releases);
  const children = releases.flatMap((r) => r.items.flatMap((it) => it.children));
  for (const body of subBullets) {
    const head = body.slice(0, 40);
    assert.ok(!texts.some((t) => t.includes(` - ${head}`)), `merged into its parent: "${head}…"`);
    assert.ok(children.some((c) => c.startsWith(body)), `not a sub-point of anything: "${head}…"`);
  }
});

test('no Markdown syntax is left on screen: bold, italic and code all render as themselves', () => {
  // A marker hugging a word at either end, a doubled asterisk, or a backtick, in PLAIN text. Mid-word
  // underscores (campaign_id, docs/TABLET_SETUP.md written as prose) are not markers and do not match.
  const MARKER = /(^|[\s("“'‘])[*_`][^\s*_]|[^\s*_][*_`]([\s.,;:!?)”"'’]|$)|\*\*|`/;
  for (const text of allTexts(releases)) {
    for (const run of plainRuns(inlineSpans(text))) {
      assert.ok(!MARKER.test(run), `raw Markdown shows in: "${run.slice(0, 120)}"`);
    }
  }
});

test('an italic sentence containing a code span with an underscore stays one italic (0.9.26)', () => {
  // The case that needs code spans to be atomic inside emphasis: without it the italic ends at the
  // underscore in TABLET_SETUP and both asterisks show.
  const note = release('0.9.26').items.find((it) => it.text.includes('un-leavable'));
  assert.ok(note, 'the 0.9.26 Lock Task note is there');
  const em = inlineSpans(note.text).find((s) => s.kind === 'em');
  assert.ok(em && em.kind === 'em', 'the note carries an italic');
  assert.ok(em.children.some((c) => c.kind === 'code' && c.text === 'docs/TABLET_SETUP.md'));
});

// ── The rules, on lines written to isolate each one ─────────────────────────────────────────────────

test('a wrapped line continues the sub-point above it; a column-0 paragraph after a blank line stands alone', () => {
  const [r] = parseChangelog(
    [
      '# Changelog', // above the first release: ignored
      'Some header prose.',
      '## 1.0.0',
      '- Headline that',
      '  wraps once.',
      '  - A sub-point that',
      '    wraps too.',
      '  **Bold** at the start of a wrapped line is not a bullet.',
      '',
      'A paragraph of its own.',
      '',
      '  An indented line after a blank still belongs to the note above.',
    ].join('\n'),
  );
  assert.equal(r.version, '1.0.0');
  assert.deepEqual(r.items, [
    {
      text: 'Headline that wraps once.',
      children: ['A sub-point that wraps too. **Bold** at the start of a wrapped line is not a bullet.'],
    },
    { text: 'A paragraph of its own. An indented line after a blank still belongs to the note above.', children: [] },
  ]);
});

test('an indented bullet with nothing above it is still shown, as a note of its own', () => {
  const [r] = parseChangelog('## 1.0.0\r\n  - Orphan sub-point\r\n- Next\r\n');
  assert.deepEqual(r.items, [
    { text: 'Orphan sub-point', children: [] },
    { text: 'Next', children: [] },
  ]);
});

test('inline: nesting, atomic code, and markers that do not pair up stay as plain text', () => {
  assert.deepEqual(inlineSpans('**Bold with *italic* inside** then `x_y` and _under_.'), [
    { kind: 'strong', children: [{ kind: 'text', text: 'Bold with ' }, { kind: 'em', children: [{ kind: 'text', text: 'italic' }] }, { kind: 'text', text: ' inside' }] },
    { kind: 'text', text: ' then ' },
    { kind: 'code', text: 'x_y' },
    { kind: 'text', text: ' and ' },
    { kind: 'em', children: [{ kind: 'text', text: 'under' }] },
    { kind: 'text', text: '.' },
  ]);
  // Mid-word underscores, a lone asterisk, arithmetic and an unclosed bold: none of them is emphasis.
  for (const plain of ['the campaign_id column', 'docs/TABLET_SETUP.md', '5 * 3 = 15', 'a **stray opener', 'x*y*z']) {
    assert.deepEqual(inlineSpans(plain), [{ kind: 'text', text: plain }], plain);
  }
  // A space just inside a marker is not emphasis either.
  assert.deepEqual(inlineSpans('* not italic *'), [{ kind: 'text', text: '* not italic *' }]);
});
