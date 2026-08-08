// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** "What's new" — the release notes THIS build shipped with, from the CHANGELOG.md copied
 *  into the image (see /api/admin/changelog). An admin who has just been updated by
 *  OpenMasjidOS has no other way to find out what changed without leaving for GitHub, and
 *  several recent releases need a tablet-app update to take effect — which is exactly the
 *  kind of thing that has to be said in the panel, not in a repo. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { getChangelog } from './api';

/** The newest version an admin has actually read, per browser. Used only to show the dot on
 *  the account button — never to gate anything. */
const SEEN_KEY = 'omk.whatsnew.seen';

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return ''; // private mode / storage disabled — the dot just always shows
  }
}
function writeSeen(v: string): void {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* best-effort */
  }
}

/** Compare two dotted versions numerically ("0.9.9" < "0.9.34" — a string compare gets this
 *  exactly backwards, which is how a "new!" dot ends up lying). */
export function versionNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** True when this build is newer than the notes the admin last opened. */
export function useUnreadRelease(version: string | undefined): boolean {
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    // Another tab (or the modal below) may have marked it read.
    const onSeen = () => setSeen(readSeen());
    window.addEventListener('omk:whatsnew-seen', onSeen);
    window.addEventListener('storage', onSeen);
    return () => {
      window.removeEventListener('omk:whatsnew-seen', onSeen);
      window.removeEventListener('storage', onSeen);
    };
  }, []);
  if (!version) return false;
  // First ever load isn't "new" — a fresh install has nothing to catch up on, and a dot on
  // day one is noise. Record the current version instead.
  if (!seen) {
    writeSeen(version);
    return false;
  }
  return versionNewer(version, seen);
}

export function markReleaseSeen(version: string): void {
  if (!version) return;
  writeSeen(version);
  window.dispatchEvent(new Event('omk:whatsnew-seen'));
}

// ── The tiny slice of Markdown our CHANGELOG actually uses ───────────────────────
// Deliberately NOT a Markdown library: this renders one file we write ourselves, in a
// format of five constructs. Everything becomes React nodes — there is no
// dangerouslySetInnerHTML anywhere, so no amount of odd text in a release note can inject
// markup.

interface Release {
  version: string;
  items: string[];
}

/** Split "## 0.9.34" sections and their "- " bullets out of the changelog. Prose lines that
 *  aren't bullets are kept as their own entry, so nothing in the file is silently dropped. */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const head = /^##\s+(.+)$/.exec(line);
    if (head) {
      current = { version: head[1].trim(), items: [] };
      releases.push(current);
      continue;
    }
    if (!current) continue; // the file's title / licence header, above the first release
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      current.items.push(bullet[1]);
    } else if (line.trim()) {
      // A continuation of the bullet above (our notes wrap), or standalone prose.
      if (current.items.length) current.items[current.items.length - 1] += ` ${line.trim()}`;
      else current.items.push(line.trim());
    }
  }
  return releases;
}

/** Inline `**bold**` and `` `code` `` as React nodes. Anything else is plain text. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++}>{m[1]}</strong>);
    else out.push(<code key={k++}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Strip a leading "v" so "## 0.9.34" and a version of "0.9.34" compare equal. */
const normalise = (v: string) => v.trim().replace(/^v/i, '').split(/\s+/)[0];

export function WhatsNewModal({ onClose }: { onClose: () => void }) {
  const [md, setMd] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [err, setErr] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    getChangelog()
      .then((r) => {
        if (!alive) return;
        setMd(r.markdown);
        setVersion(r.version);
        markReleaseSeen(r.version);
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Couldn’t load the release notes.'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const releases = useMemo(() => (md ? parseChangelog(md) : []), [md]);

  // Portal for the same reason the activity log uses one: an ancestor panel has a
  // backdrop-filter, which would make `position: fixed` resolve against it instead of the
  // viewport and leave the scrim covering only part of the page.
  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="What’s new" onClick={onClose}>
      <div className="modal modal--window glass-raised" onClick={(e) => e.stopPropagation()}>
        <div className="tl-bar">
          <button ref={closeRef} className="tl tl--red" onClick={onClose} aria-label="Close">
            <X size={9} strokeWidth={3} />
          </button>
          <span className="tl tl--amber" aria-hidden="true" />
        </div>
        <div className="modal-head">
          <div className="card-head__main">
            <h3 className="section-title-inline">What’s new</h3>
            <p className="muted">
              Release notes for OpenMasjid Kiosk{version ? `, up to the v${version} you’re running` : ''}.
            </p>
          </div>
        </div>
        <div className="modal-body">
          {err && <p className="form-error">{err}</p>}
          {!md && !err && <p className="muted">Loading…</p>}
          {md && releases.length === 0 && <p className="muted">No release notes shipped with this build.</p>}
          {releases.map((r) => {
            const current = !!version && normalise(r.version) === normalise(version);
            return (
              <section className="wn-release" key={r.version}>
                <h4 className="wn-version">
                  {r.version}
                  {current && <span className="pill pill--ok">You’re on this</span>}
                </h4>
                <ul className="wn-list">
                  {r.items.map((it, i) => (
                    <li key={i}>{inline(it)}</li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
