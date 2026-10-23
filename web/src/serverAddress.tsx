// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The address a volunteer types into the kiosk app on the tablet, with a Copy button.
 *
 * ITS OWN MODULE, AND A DELIBERATELY SMALL ONE. Two very different pages show it: Admin → Devices,
 * and the public /new setup page, which a tablet's browser opens BEFORE it is paired — often a
 * low-end tablet, sometimes on a Raspberry Pi's Wi-Fi. When this lived in devices.tsx, showing one
 * line of text and a button on /new meant loading the whole fleet screen and everything it imports.
 * So this file imports React and the icons and nothing else; keep it that way.
 *
 * The address is always laid out left to right (`dir="ltr"`), even when the panel is mirrored for
 * Arabic or Urdu: it is a URL, and under a right-to-left base the bidi algorithm moves "https://"
 * and the port to the wrong ends — so what a volunteer reads is not what they must type.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy } from 'lucide-react';
import { BASE } from './base';

const COPY_FAILED = 'Your browser didn’t let us copy it, so the address is selected — copy it from there, or type it on the tablet.';

/** A monospace address box with a Copy button — the exact URL a volunteer types on the tablet. */
export function CopyableAddress({ url }: { url: string }) {
  const [state, setState] = useState<'' | 'copied' | 'failed'>('');
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
      timer.current = setTimeout(() => setState(''), 1500);
    } catch {
      // Blocked — or simply absent: `navigator.clipboard` only exists on a secure page, and /new can
      // be opened over plain http on the LAN. The address is still shown, so select it for the
      // volunteer and SAY that it didn't copy; a Copy button that silently does nothing reads as
      // broken, and they paste whatever was on the clipboard before.
      const el = codeRef.current;
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setState('failed');
    }
  };

  return (
    <>
      <div className="server-addr">
        <code ref={codeRef} className="server-addr__url" dir="ltr">
          {url}
        </code>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()} title="Copy the server address">
          {state === 'copied' ? (
            <>
              <CheckCircle2 size={14} aria-hidden="true" /> Copied
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden="true" /> Copy
            </>
          )}
        </button>
        {/* Always in the page, so the change of text is what gets announced: a status that mounts
            already holding its message is missed by some screen readers. "Copied" on the button
            alone is a visual swap nobody hears. */}
        <span className="sr-only" role="status">
          {state === 'copied' ? 'Address copied.' : state === 'failed' ? COPY_FAILED : ''}
        </span>
      </div>
      {/* The same words for someone looking, hidden from the screen reader that just heard them. */}
      {state === 'failed' && (
        <p className="hint" aria-hidden="true">
          {COPY_FAILED}
        </p>
      )}
    </>
  );
}

/** The server address a volunteer types into the app — this page's own origin (the OpenMasjidOS
 *  address the browser is already on) PLUS the base path the page is served under, with a nudge if it's
 *  localhost (which a device can't reach). On the LAN the base path is empty; opened over the tunnel
 *  it is the app's path (`/kiosk`), and an address without it pairs with nothing. */
export function ServerAddress({ device = 'tablet' }: { device?: 'tablet' | 'phone' }) {
  const origin = typeof window !== 'undefined' ? `${window.location.origin}${BASE}` : '';
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const port = typeof window !== 'undefined' ? window.location.port : '';
  const isLocal = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(host);
  return (
    <div className="field" style={{ marginBlockEnd: '0.9rem' }}>
      <span className="label">
        Server address <span className="faint">(type this on the {device})</span>
      </span>
      <CopyableAddress url={origin} />
      {isLocal ? (
        <p className="note-amber">
          You’re viewing this on <strong dir="ltr">{host}</strong>, which a {device} can’t reach. On the {device}, use your
          server’s network address instead — for example <code dir="ltr">https://192.168.1.50{port ? `:${port}` : ''}</code>.
        </p>
      ) : (
        <p className="hint">
          This is your OpenMasjidOS address — type it on the {device} exactly, including <code dir="ltr">https://</code>.
        </p>
      )}
    </div>
  );
}
