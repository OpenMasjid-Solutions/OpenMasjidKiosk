// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Small shared UI pieces used across the admin shell: the ambient scene, brand mark, live clock and
 *  the top-right account menu (which carries the light/dark override). Mirrors the OpenMasjidOS
 *  dashboard (and OpenMasjidDonations) so the panel feels like part of the platform. The primitives
 *  every section uses — Skeleton, ResultLine, Toggle, useClock, figures — live in primitives.tsx and are
 *  re-exported from here. */
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { LogOut, Moon, Settings, Sparkles, Sun, User } from 'lucide-react';
import { prefsStore, resolveTheme, usePrefs } from './prefs';
import { getSession, logout, type AppInfo, type Session } from './api';
import { withBase } from './base';
import { formatTime, gregorianDate, hijriDate } from './dates';
import { useClock } from './primitives';
import { useUnreadRelease, WhatsNewModal } from './whatsnew';

export { figures, ResultLine, Skeleton, Toggle, useClock } from './primitives';

/** A simple crescent + star mark (geometric motif — never sacred text in chrome). */
export function Crescent({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M17 4a8 8 0 1 0 0 16 6.4 6.4 0 1 1 0-16z" fill="currentColor" />
      <path d="M19.5 5.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/** Accept only safe image URLs for a CSS `url()` / an `<img src>`, else ''. Allows same-origin
 *  uploads (`/uploads/<file>`, prefixed with the base path), `http(s):` URLs and `data:image`,
 *  and rejects anything with quotes/backslashes/whitespace that could break out of `url("…")`.
 *  Shared by the ambient Scene wallpaper and the campaign previews (values can arrive from the
 *  attacker-craftable #omos fragment, so every image string is run through this first). */
export function safeImageUrl(v: string): string {
  const s = (v ?? '').trim();
  if (/^\/uploads\/[\w.-]+$/.test(s)) return withBase(s); // our own uploaded file (same origin)
  return /^(https?:\/\/|data:image\/)/i.test(s) && !/["\\\s]/.test(s) ? s : '';
}

/** Ambient background. A custom wallpaper image (inherited from the dashboard or set in
 *  OpenMasjidOS) fully replaces the preset gradient; otherwise we show the preset scene
 *  (gradient + aurora + geometric pattern, driven by data-wallpaper). */
export function Scene() {
  const prefs = usePrefs();
  const safe = safeImageUrl(prefs.wallpaperImage);
  if (safe) return <div className="scene-img" aria-hidden="true" style={{ backgroundImage: `url("${safe}")` }} />;
  return <div className="scene" aria-hidden="true" />;
}

/** The app's own mark, as a small PNG from web/public (made from the repo-root icon.svg — the same
 *  art the App Store and the browser tab show). Through withBase so it still resolves under a
 *  /<basePath> prefix. Decorative: the surrounding link already carries the accessible name, so an
 *  empty alt keeps a screen reader from hearing the app's name twice. */
export function Logo({ size = 26 }: { size?: number }) {
  return <img className="brand__logo" src={withBase('/logo-96.png')} width={size} height={size} alt="" />;
}

/** Brand mark; returns to the dashboard tab. The app's OWN identity, as every OpenMasjidOS app
 *  window shows its own name — the masjid's logo appears on the pages a donor or volunteer meets. */
export function Brand() {
  return (
    <a className="brand" href="#dashboard" aria-label="OpenMasjid Kiosk — dashboard">
      <Logo size={26} />
      <b>OpenMasjid&nbsp;Kiosk</b>
    </a>
  );
}

/**
 * The top-bar clock — in the MASJID'S time zone and hour cycle, with the Hijri date beside the
 * Gregorian (spec §10), not this device's. A trustee checking in from another country sees the
 * masjid's time, which is the one every donation on the page is recorded against.
 *
 * Deliberately not a live region: announcing a clock every 30 s would drown everything else.
 */
export function Clock() {
  const clock = useClock();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(iv);
  }, []);
  const time = formatTime(now, clock);
  const date = gregorianDate(now, clock);
  const hijri = hijriDate(now, clock);
  return (
    <time className="topclock" dateTime={now.toISOString()}>
      <span className="topclock-time">{time}</span>
      <span className="topclock-date">
        {date}
        {hijri && <span className="topclock-hijri"> · {hijri}</span>}
      </span>
    </time>
  );
}

/**
 * Top-right account menu (theme, what's new, settings, sign out, version).
 *
 * A DISCLOSURE — a button that shows and hides a short list of ordinary buttons and links — rather
 * than an ARIA `menu`. A `role="menu"` promises arrow-key navigation, a roving tab stop and focus
 * moving in on open; this had the role and none of the behaviour, which is worse than neither.
 * Escape closes it and puts focus back on the button; so does tabbing out of it.
 */
export function ProfileMenu({ info }: { info: AppInfo | null }) {
  const prefs = usePrefs();
  const current = resolveTheme(prefs.theme);
  const [open, setOpen] = useState(false);
  const [whatsNew, setWhatsNew] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const version = info?.version ?? __APP_VERSION__;
  // A quiet dot when OpenMasjidOS has updated this app since the notes were last opened —
  // otherwise "What's new" is a menu item nobody has a reason to press.
  const unread = useUnreadRelease(info?.version);

  useEffect(() => {
    if (!open) return;
    getSession().then(setSession).catch(() => setSession(null));
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Tabbing past the last item closes it — an open popover must not be left behind focus.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (open && !ref.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  const toggleTheme = () => prefsStore.patch({ theme: current === 'dark' ? 'light' : 'dark', followOmos: false });
  const signOut = async () => {
    try {
      await logout();
    } catch {
      /* ignore */
    }
    window.location.href = withBase('/') || '/';
  };
  // Under SSO the platform owns the session, so a local sign-out wouldn't stick.
  const canSignOut = !!session?.authed && !session?.sso.enabled;

  return (
    <div className="profile" ref={ref} onBlur={onBlur}>
      <button
        ref={btnRef}
        className="profile-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={unread ? 'Account menu — new release notes' : 'Account menu'}
      >
        <User size={18} aria-hidden="true" />
        {unread && <span className="profile-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="profile-menu glass-raised" id={menuId}>
          <button className="menu-item" onClick={toggleTheme}>
            {current === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
            <span>{current === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setWhatsNew(true);
              setOpen(false);
            }}
          >
            <Sparkles size={17} aria-hidden="true" />
            <span>What’s new</span>
            {unread && <span className="menu-dot" aria-hidden="true" />}
            {unread && <span className="sr-only"> — new release notes</span>}
          </button>
          <a className="menu-item" href="#settings" onClick={() => setOpen(false)}>
            <Settings size={17} aria-hidden="true" />
            <span>Settings</span>
          </a>
          {canSignOut && (
            <button className="menu-item" onClick={signOut}>
              <LogOut size={17} className="rtl-flip" aria-hidden="true" />
              <span>Sign out</span>
            </button>
          )}
          <div className="menu-foot">OpenMasjid Kiosk v{version}</div>
        </div>
      )}
      {/* The item that opened it is gone once the menu closes, so focus goes back to the account
          button when the notes are closed. */}
      {whatsNew && <WhatsNewModal returnFocus={btnRef} onClose={() => setWhatsNew(false)} />}
    </div>
  );
}
