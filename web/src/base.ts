// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Runtime base path. The kiosk is a LAN device served at the root, so this is normally
 * "" and everything behaves as-is. The helper is kept (no-ops when empty) for parity
 * with the other OpenMasjid apps and so the client can build correct in-app URLs. Read
 * once per page load.
 */
declare global {
  interface Window {
    __OMOS_BASE__?: string;
  }
}

function read(): string {
  const raw = (typeof window !== 'undefined' && window.__OMOS_BASE__) || '';
  const t = raw.trim().replace(/\/+$/, '');
  if (!t) return '';
  return t.startsWith('/') ? t : '/' + t;
}

/** The base path, e.g. "" (no trailing slash). */
export const BASE = read();

/** Prefix an absolute in-app path (e.g. "/api/x", "/new") with the base path. */
export const withBase = (p: string): string => (BASE && p.startsWith('/') ? BASE + p : p);

/** Strip the base path off a `location.pathname` for client-side route matching. */
export const stripBase = (pathname: string): string => {
  if (BASE && (pathname === BASE || pathname.startsWith(BASE + '/'))) return pathname.slice(BASE.length) || '/';
  return pathname;
};
