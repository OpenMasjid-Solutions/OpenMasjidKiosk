// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The tiny slice of Markdown our CHANGELOG actually uses, read into plain data.
 *
 * Deliberately NOT a Markdown library: this reads one file we write ourselves. It used to claim "a
 * format of five constructs", and the file quietly outgrew that — indented "also fixed" sub-bullets
 * and *italic* / _italic_ arrived, and the parser merged every sub-bullet into its parent as a raw
 * " - Also fixed: …" and showed the italics with their asterisks and underscores still on. Measured
 * against the real file: 24 sub-bullets swallowed and 24 items with Markdown syntax showing, in the
 * one place a masjid admin reads what changed. The constructs handled now are exactly these:
 *
 *   `## heading`     one release (`## Unreleased` on dev, `## 0.12.0` everywhere)
 *   `- item`         a top-level note (`* item` too)
 *   `  - sub-item`   any indented bullet: a child of the note above it
 *   a wrapped line   the continuation of the child above it if there is one, else of the note
 *   a paragraph      a column-0 line after a blank line — its own entry, never glued onto a bullet
 *   **bold**  *italic*  _italic_  `code`   inline, nestable, code spans atomic
 *
 * React-free on purpose, so the server's test run — the only one CI executes — can parse the real
 * CHANGELOG.md with it (`server/src/changelog-parse.test.ts`). The React rendering of what comes out
 * stays in whatsnew.tsx, and it builds React nodes only: there is no dangerouslySetInnerHTML anywhere,
 * so no amount of odd text in a release note can inject markup.
 */

/** One note, with the "also fixed" points indented under it. */
export interface ChangelogItem {
  text: string;
  children: string[];
}

export interface Release {
  version: string;
  items: ChangelogItem[];
}

const HEADING = /^##\s+(.+)$/;
/** Matched on the raw line, indent kept: the indent is the only thing that says "sub-point". Matching
 *  on a trimmed line is what turned every sub-bullet into a continuation of its parent. `\s+` after
 *  the marker keeps a wrapped line that starts with `**bold**` or `*italic*` from reading as a bullet. */
const BULLET = /^(\s*)[-*]\s+(.*)$/;

/** Split the "## 0.9.34" sections and their bullets out of the changelog. Prose that isn't a bullet is
 *  kept as its own entry, so nothing in the file is silently dropped. Deeper nesting than one level is
 *  flattened into the children — the file has never used it, and a third level in a modal would be
 *  unreadable anyway. */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  let afterBlank = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      afterBlank = true;
      continue;
    }
    const wasBlank = afterBlank;
    afterBlank = false;

    const head = HEADING.exec(line);
    if (head) {
      current = { version: head[1].trim(), items: [] };
      releases.push(current);
      continue;
    }
    if (!current) continue; // the file's title / license header, above the first release

    const last: ChangelogItem | undefined = current.items[current.items.length - 1];
    const bullet = BULLET.exec(line);
    if (bullet) {
      const [, indent, body] = bullet;
      // An indented bullet with nothing above it to belong to is still shown — as a note of its own.
      if (indent && last) last.children.push(body);
      else current.items.push({ text: body, children: [] });
      continue;
    }

    const text = line.trim();
    // A paragraph that starts at column 0 after a blank line has left the list, in Markdown and to a
    // reader alike. Appending it to the bullet above is how the old file header that sits under 0.2.1
    // ("All notable changes to OpenMasjid Kiosk…") ended up inside a note about wallpaper.
    const newParagraph = wasBlank && !/^\s/.test(line);
    if (!last || newParagraph) current.items.push({ text, children: [] });
    // Our notes wrap. A wrapped line under a sub-point belongs to that sub-point, not to the headline —
    // the sub-point is what is being continued.
    else if (last.children.length) last.children[last.children.length - 1] += ` ${text}`;
    else last.text += ` ${text}`;
  }
  return releases;
}

/** Inline text as data: what whatsnew.tsx turns into React nodes. */
export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em'; children: InlineSpan[] };

/**
 * One alternative per construct; the scan takes whichever starts earliest, and the first listed
 * when two start at the same place (so `**` is always tried before `*`).
 *
 *   1 `**bold**`   2 `` `code` ``   3 `*italic*`   4 `_italic_`
 *
 * Inside any emphasis a code span is ATOMIC — `(?:`[^`\n]*`|…)` can only take a backtick as part of
 * a whole span. The case that needs it is real: the 0.9.26 note is an italic sentence containing
 * `docs/TABLET_SETUP.md`, and without that rule the italic ends at the underscore in TABLET_SETUP
 * and the reader sees the asterisks after all.
 *
 * Emphasis must hug its text, as in CommonMark: no space just inside either marker (checked by the
 * lookahead after the opener and by the last unit of the body), and no letter or digit straight
 * after the closer. The one rule NOT in the pattern is "no letter just before the opener", which
 * would need a lookbehind — and a lookbehind in a regex literal is a syntax error on Safari before
 * 16.4, which would take the whole panel's script down on an older iPad rather than just this
 * window. That check is done by hand in `inlineSpans` instead; it is what keeps `campaign_id` and
 * `docs/TABLET_SETUP.md` written in plain prose from turning into italics.
 */
const INLINE =
  /\*\*((?:`[^`\n]*`|[^`])+?)\*\*|`([^`\n]+)`|\*(?![\s*])((?:`[^`\n]*`|[^*`])*?(?:`[^`\n]*`|[^\s*`]))\*(?![\w*])|_(?![\s_])((?:`[^`\n]*`|[^_`])*?(?:`[^`\n]*`|[^\s_`]))_(?![\w_])/g;

/** Parse `**bold**`, `*italic*`, `_italic_` and `` `code` ``, nested as written. Anything else —
 *  including a marker that does not pair up — stays plain text, so a stray asterisk shows as one. */
export function inlineSpans(text: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  // A fresh regex per call: the pattern is global, and this function recurses into bold and italic
  // bodies, which would otherwise share — and clobber — one lastIndex.
  const re = new RegExp(INLINE.source, 'g');
  let plain = 0; // where the pending run of plain text starts
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const emphasis = m[3] ?? m[4];
    if (emphasis !== undefined) {
      const before = text[m.index - 1] ?? '';
      // Word character or the same marker straight before the opener: mid-word, or the tail of a
      // `**`, not emphasis. Retry one character on, so a real pair later in the line still matches.
      if (/[\w*]/.test(before)) {
        re.lastIndex = m.index + 1;
        continue;
      }
    }
    if (m.index > plain) out.push({ kind: 'text', text: text.slice(plain, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'strong', children: inlineSpans(m[1]) });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else out.push({ kind: 'em', children: inlineSpans(emphasis) });
    plain = m.index + m[0].length;
  }
  if (plain < text.length) out.push({ kind: 'text', text: text.slice(plain) });
  return out;
}

/** Compare two versions, numerically and prerelease-aware: "0.9.9" < "0.9.34" (a string compare
 *  gets that exactly backwards, which is how a "new!" dot ends up lying), and "0.14.0-dev.5" <
 *  "0.14.0" — a release is newer than its own development builds. Reading the dash as one more
 *  number made 0.14.0 compare as OLDER than 0.14.0-dev.5, so a dev box that moved to the release
 *  never saw the dot. Between two prereleases of one release the numbers after the dash decide. */
export function versionNewer(a: string, b: string): boolean {
  const nums = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const split = (v: string) => {
    const dash = v.indexOf('-');
    return dash < 0 ? { core: nums(v), pre: '' } : { core: nums(v.slice(0, dash)), pre: v.slice(dash + 1) };
  };
  const cmp = (x: number[], y: number[]) => {
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const [x, y] = [split(a.trim()), split(b.trim())];
  const core = cmp(x.core, y.core);
  if (core !== 0) return core > 0;
  if (!x.pre || !y.pre) return !x.pre && !!y.pre;
  return cmp(nums(x.pre), nums(y.pre)) > 0;
}
