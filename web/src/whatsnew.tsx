// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** "What's new" — the release notes THIS build shipped with, from the CHANGELOG.md copied
 *  into the image (see /api/admin/changelog). An admin who has just been updated by
 *  OpenMasjidOS has no other way to find out what changed without leaving for GitHub, and
 *  several recent releases need a tablet-app update to take effect — which is exactly the
 *  kind of thing that has to be said in the panel, not in a repo. */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { errorText, getChangelog } from './api';
import { inlineSpans, parseChangelog, versionNewer, type InlineSpan } from './changelog';
import { Modal } from './modal';
import { ResultLine, Skeleton } from './primitives';

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

// ── Rendering ────────────────────────────────────────────────────────────────────
// Reading the Markdown is changelog.ts's job (React-free, so the server's test run can hold it
// to the real file). Everything here becomes React nodes — there is no dangerouslySetInnerHTML
// anywhere, so no amount of odd text in a release note can inject markup.

/** Inline `**bold**`, `*italic*` / `_italic_` and `` `code` `` as React nodes, nested as written. */
function renderSpans(spans: InlineSpan[]): ReactNode[] {
  return spans.map((s, i) => {
    switch (s.kind) {
      case 'text':
        return s.text;
      case 'code':
        return <code key={i}>{s.text}</code>;
      case 'strong':
        return <strong key={i}>{renderSpans(s.children)}</strong>;
      case 'em':
        return <em key={i}>{renderSpans(s.children)}</em>;
    }
  });
}

const inline = (text: string): ReactNode[] => renderSpans(inlineSpans(text));

/** Strip a leading "v" so "## 0.9.34" and a version of "0.9.34" compare equal. */
const normalize = (v: string) => v.trim().replace(/^v/i, '').split(/\s+/)[0];

export function WhatsNewModal({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  /** Where focus goes on close. The account-menu item that opened this has unmounted by then, so
   *  without it a keyboard user is dropped at the top of the page. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [md, setMd] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [err, setErr] = useState('');
  // Bumped by Try again, which is what re-runs the load. The error and its button stay up while a
  // retry runs — the button has focus, and taking it away mid-press would drop that.
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let alive = true;
    getChangelog()
      .then((r) => {
        if (!alive) return;
        setMd(r.markdown);
        setVersion(r.version);
        setErr('');
        setRetrying(false);
        markReleaseSeen(r.version);
        // After a retry the Try again button that had focus is about to go, and focus must not fall
        // to <body>: it goes to the heading the notes appear under. Not on the first load — the
        // dialog has already put focus on its close button, and moving it would be a surprise.
        if (attempt > 0) headingRef.current?.focus();
      })
      .catch((e) => {
        if (!alive) return;
        setErr(errorText(e, 'Couldn’t load the release notes. Please try again.'));
        setRetrying(false);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    // aria-disabled rather than disabled while it runs, for the same reason: a disabled button
    // loses focus.
    if (retrying) return;
    setRetrying(true);
    setAttempt((a) => a + 1);
  };
  const loading = md === null && (!err || retrying);

  const releases = useMemo(() => (md ? parseChangelog(md) : []), [md]);

  return (
    <Modal titleId="wn-title" className="modal--window" returnFocus={returnFocus} onClose={onClose}>
      {/* This window doesn't drag, so its bar mustn't promise it can. */}
      <div className="tl-bar tl-bar--static">
        <button type="button" className="tl tl--red" onClick={onClose} aria-label="Close">
          <X size={9} strokeWidth={3} aria-hidden="true" />
        </button>
        <span className="tl tl--amber" aria-hidden="true" />
      </div>
      <div className="modal-head">
        <div className="card-head__main">
          <h3 id="wn-title" ref={headingRef} tabIndex={-1} className="section-title-inline">
            What’s new
          </h3>
          <p className="muted">
            Release notes for OpenMasjid Kiosk{version ? `, up to the v${version} you’re running` : ''}.
          </p>
        </div>
      </div>
      <div className="modal-body" aria-busy={loading || undefined}>
        {err && (
          <>
            <ResultLine ok={false}>{err}</ResultLine>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ marginBlockStart: '0.6rem' }}
              aria-disabled={retrying || undefined}
              onClick={retry}
            >
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
          </>
        )}
        {/* Shaped like what it stands in for: a version heading, then a few notes. */}
        {md === null && !err && (
          <Skeleton rows={5} height="0.95rem" widths={['30%', '100%', '94%', '100%', '72%']} label="Loading the release notes…" />
        )}
        {md !== null && releases.length === 0 && <p className="muted">No release notes shipped with this build.</p>}
        {releases.map((r) => {
          const current = !!version && normalize(r.version) === normalize(version);
          return (
            <section className="wn-release" key={r.version}>
              <h4 className="wn-version">
                {/* A version number has no letters to set its direction; under dir=rtl it must still
                    read 0.12.0, not have its parts reordered around the pill. */}
                <span dir="ltr">{r.version}</span>
                {current && <span className="pill pill--ok">You’re on this</span>}
              </h4>
              <ul className="wn-list">
                {r.items.map((it, i) => (
                  <li key={i}>
                    {inline(it.text)}
                    {/* The "also fixed" points, under the note they belong to — flattening them into
                        notes of their own would lose which headline they are detail for. */}
                    {it.children.length > 0 && (
                      <ul className="wn-list">
                        {it.children.map((c, j) => (
                          <li key={j}>{inline(c)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
