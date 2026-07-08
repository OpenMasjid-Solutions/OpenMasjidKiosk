// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Small shared UI pieces used across the admin shell: the ambient scene, brand mark,
 *  live clock, theme toggle, and the top-right profile menu. Mirrors the OpenMasjidOS
 *  dashboard (and OpenMasjidDonations) so the panel feels like part of the platform. */
import { useEffect, useRef, useState } from 'react';
import { LogOut, Monitor, Moon, Settings, Sun, User } from 'lucide-react';
import { prefsStore, resolveTheme, usePrefs, type Prefs } from './prefs';
import { getSession, logout, type AppInfo, type Session } from './api';
import { withBase } from './base';

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

/** Brand mark; returns to the dashboard tab. */
export function Brand() {
  return (
    <a className="brand" href="#dashboard" aria-label="OpenMasjid Kiosk — dashboard">
      <Crescent size={22} />
      <b>OpenMasjid&nbsp;Kiosk</b>
    </a>
  );
}

const NEXT: Record<Prefs['theme'], Prefs['theme']> = { system: 'dark', dark: 'light', light: 'system' };
const THEME_LABEL: Record<Prefs['theme'], string> = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };

/** Cycles system → dark → light. Dark is the default look. */
export function ThemeToggle() {
  const { theme } = usePrefs();
  const Icon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  return (
    <button
      className="icon-btn"
      title={THEME_LABEL[theme]}
      aria-label={`${THEME_LABEL[theme]} — click to change`}
      onClick={() => prefsStore.patch({ theme: NEXT[theme] })}
    >
      <Icon size={19} />
    </button>
  );
}

/** Live clock for the top bar, mirroring the OpenMasjidOS dashboard. */
export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(iv);
  }, []);
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div className="topclock" aria-label={`${time}, ${date}`}>
      <span className="topclock-time">{time}</span>
      <span className="topclock-date">{date}</span>
    </div>
  );
}

/** Top-right account menu (theme, settings, sign out, version) — mirrors the profile
 *  menu in the OpenMasjidOS dashboard and OpenMasjidDonations. */
export function ProfileMenu({ info }: { info: AppInfo | null }) {
  const prefs = usePrefs();
  const current = resolveTheme(prefs.theme);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    getSession().then(setSession).catch(() => setSession(null));
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggleTheme = () => prefsStore.patch({ theme: current === 'dark' ? 'light' : 'dark', followOmos: false });
  const signOut = async () => { try { await logout(); } catch { /* ignore */ } window.location.href = withBase('/') || '/'; };
  // Under SSO the platform owns the session, so a local sign-out wouldn't stick.
  const canSignOut = !!session?.authed && !session?.sso.enabled;

  return (
    <div className="profile" ref={ref}>
      <button className="profile-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        <User size={18} />
      </button>
      {open && (
        <div className="profile-menu glass-raised" role="menu">
          <button className="menu-item" role="menuitem" onClick={toggleTheme}>
            {current === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{current === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <a className="menu-item" role="menuitem" href="#settings" onClick={() => setOpen(false)}><Settings size={17} /><span>Settings</span></a>
          {canSignOut && (
            <button className="menu-item" role="menuitem" onClick={signOut}><LogOut size={17} /><span>Sign out</span></button>
          )}
          <div className="menu-foot">OpenMasjid Kiosk v{info?.version ?? __APP_VERSION__}</div>
        </div>
      )}
    </div>
  );
}
