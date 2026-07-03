// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * OpenMasjidOS Fabric — single sign-on + notifications (server→server). Stripe capability
 * is added in slice 3; there is no `domain`/remote-access here (the kiosk is LAN-only).
 *
 * When this app runs under OpenMasjidOS, the platform injects OPENMASJID_BASE_URL and a
 * per-app OPENMASJID_APP_SECRET, and the browser also sends the platform's `omos_session`
 * cookie to us (same host, different port = same-site). We NEVER trust that cookie
 * ourselves — we ask the platform to validate it, presenting our per-app secret so the
 * platform can confirm it's really us asking (identity-bound; it fails closed without it).
 *
 * Everything degrades gracefully: no base URL, no secret, no cookie, or an unreachable
 * platform all mean "no Fabric", and the app falls back to its own admin password.
 *
 * RESTORE/MIGRATION RESILIENCE (required): OPENMASJID_BASE_URL and OPENMASJID_APP_SECRET are
 * read from the environment on EVERY process start (config.ts) and NEVER persisted — the
 * platform rewrites the base URL when a backup is restored on a new machine and may rotate
 * the secret. Every call here fails soft (short timeout, redirect:'error'), so an
 * unreachable platform is "no Fabric this request", never a crash or a lock-out. The wire
 * identifiers (env vars, header, cookie, endpoints) are the shared contract — do not rename.
 */
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';

const log = makeLog('fabric');

export { ssoConfigured };

/** Is `host` a loopback / private / LAN address where sending our secret over plain HTTP is
 *  acceptable? Anything else is treated as PUBLIC (we err toward "public" if unsure). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.lan')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

let cleartextSecretWarned = false;
/** One-time warning when our per-app secret would be sent in cleartext to a PUBLIC host. The
 *  default LAN flow (http://openmasjidos.local, a 192.168.x.x box) is fine and stays silent. */
function warnIfCleartextSecret(): void {
  if (cleartextSecretWarned || !config.omosBaseUrl) return;
  let url: URL;
  try {
    url = new URL(config.omosBaseUrl);
  } catch {
    return;
  }
  if (url.protocol === 'https:') return;
  if (isPrivateHost(url.hostname)) return;
  cleartextSecretWarned = true;
  log.warn(
    `OPENMASJID_BASE_URL is a public address over plain http (${url.host}); this app's Fabric secret ` +
      `would be sent unencrypted. Over a trusted LAN, plain http is fine.`,
  );
}

export interface NotifyPayload {
  text: string;
  title?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
}

/** Relay a message to the masjid's configured webhook via the Fabric (server→server, with
 *  our per-app secret). FAILS SOFT: no platform / no secret / notifications off / any error
 *  → delivered:false and the app carries on. Never throws. */
export async function notify(payload: NotifyPayload): Promise<{ delivered: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { delivered: false, reason: 'no-fabric' };
  if (!payload.text?.trim()) return { delivered: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ text: payload.text, title: payload.title, level: payload.level ?? 'info' }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      log.warn(`Fabric notify not delivered: platform returned HTTP ${res.status}`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string };
    if (j.delivered !== true) {
      log.warn(`Fabric notify not delivered (reason: ${j.reason ?? 'unknown'}) — e.g. notifications not enabled in OpenMasjidOS.`);
    }
    return { delivered: j.delivered === true, reason: j.reason };
  } catch (err) {
    log.warn(`Fabric notify could not reach the platform: ${err instanceof Error ? err.message : String(err)}`);
    return { delivered: false, reason: 'unreachable' };
  }
}

/** Pull the platform's session token out of the raw Cookie header. */
function omosCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = /(?:^|;\s*)omos_session=([^;]+)/.exec(cookieHeader);
  if (!m) return null;
  const token = m[1].trim();
  return /^[A-Za-z0-9._~%+/=-]{1,4096}$/.test(token) ? token : null;
}

interface CacheEntry {
  username: string;
  expires: number;
}
const positiveCache = new Map<string, CacheEntry>();
const CACHE_MS = 45_000;

export interface PlatformProbe {
  /** platform-confirmed username, or null if the visitor isn't signed in there */
  username: string | null;
  /** did we actually REACH the platform? false = not configured, network error, or timeout.
   *  Distinguishes "not signed in" from "OpenMasjidOS is down / wrong address" so the panel
   *  can offer the local-password recovery instead of looping. */
  reachable: boolean;
}

/** Validate the omos_session cookie present on THIS request (if any) AND report platform
 *  reachability. Only ever validates the cookie actually on the request. */
export async function probePlatform(cookieHeader: string | undefined): Promise<PlatformProbe> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { username: null, reachable: false };
  const token = omosCookie(cookieHeader);
  if (!token) return { username: null, reachable: await platformReachable() };

  const cached = positiveCache.get(token);
  if (cached && cached.expires > Date.now()) return { username: cached.username, reachable: true };

  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/auth/session`, {
      headers: {
        cookie: `omos_session=${token}`,
        // Identity-bound SSO: prove which app is asking. Without this the platform fails
        // closed. A credential — never logged.
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (res.ok) {
      const j = (await res.json()) as { authenticated?: boolean; username?: unknown };
      if (j.authenticated === true) {
        const username = (typeof j.username === 'string' ? j.username : '').trim().slice(0, 64) || 'OpenMasjidOS';
        positiveCache.set(token, { username, expires: Date.now() + CACHE_MS });
        if (positiveCache.size > 256) {
          for (const [k, v] of positiveCache) if (v.expires <= Date.now()) positiveCache.delete(k);
        }
        return { username, reachable: true };
      }
    }
    return { username: null, reachable: true };
  } catch (err) {
    log.debug(`platform session check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { username: null, reachable: false };
  }
}

/** Cheap "is the platform up?" check via its public, CORS-enabled appearance endpoint. Any
 *  response (even an error status) proves we reached it. */
export async function platformReachable(): Promise<boolean> {
  if (!config.omosBaseUrl) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

/** Fetch the platform's current appearance (theme/wallpaper/accent) server→server, so the
 *  browser (served over HTTPS) doesn't hit mixed-content calling the platform's plain-HTTP
 *  endpoint. Returns {} when standalone/unreachable. Never throws; never persists. */
export async function fetchAppearance(): Promise<Record<string, unknown>> {
  if (!config.omosBaseUrl) return {};
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Stripe via the Fabric (platform-vaulted keys) ───────────────────────────────
// The admin configures Stripe ONCE in OpenMasjidOS (Settings → Payments); every app shares
// it and the keys are backed up / migrated with the platform — never pasted per app. We
// fetch the chosen named account's keys server→server with our per-app secret and keep them
// IN MEMORY ONLY (never written to our data volume), so they always track the OS vault even
// across a restore-to-new-machine. The secret key is NEVER sent to the tablet/browser.

/** The shape the platform returns for a vaulted Stripe account. The secret is server-side
 *  only. (The platform may also send a webhookSecret; the kiosk has no webhooks, so we
 *  ignore it.) */
export interface FabricStripeAccount {
  id: string;
  label: string;
  publishableKey: string;
  secretKey: string;
}

interface StripeCache {
  at: number;
  account: string;
  value: FabricStripeAccount | null;
}
let stripeCache: StripeCache | null = null;
// The last account we successfully fetched, kept so a transient platform blip doesn't break
// live payments (we'd rather serve slightly-stale vault keys than fail).
let stripeLastGood: { at: number; account: string; value: FabricStripeAccount } | null = null;
const STRIPE_CACHE_MS = 60_000;
const STRIPE_LASTGOOD_MS = 10 * 60_000;

function parseFabricStripe(j: unknown): FabricStripeAccount | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const secretKey = typeof o.secretKey === 'string' ? o.secretKey : '';
  if (!secretKey) return null; // no secret = nothing usable
  return {
    id: typeof o.id === 'string' && o.id ? o.id : 'fabric',
    label: typeof o.label === 'string' && o.label ? o.label.slice(0, 80) : 'OpenMasjidOS account',
    publishableKey: typeof o.publishableKey === 'string' ? o.publishableKey : '',
    secretKey,
  };
}

/** Fetch a vaulted Stripe account from the platform (server→server). `accountName` is the
 *  admin-chosen account id; empty = the only/first account. Returns null when the Fabric
 *  isn't configured, the platform is unreachable (with no recent good copy), or it has no
 *  such account — callers then fall back to local keys. Caches in memory (~60s); on a
 *  transient error serves the last good copy (~10min). NEVER throws; NEVER persists. */
export async function fetchFabricStripe(accountName: string, force = false): Promise<FabricStripeAccount | null> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return null;
  const now = Date.now();
  if (!force && stripeCache && stripeCache.account === accountName && now - stripeCache.at < STRIPE_CACHE_MS) {
    return stripeCache.value;
  }
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const qs = accountName ? `?account=${encodeURIComponent(accountName)}` : '';
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe${qs}`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      stripeCache = { at: now, account: accountName, value: null };
      return null;
    }
    const value = parseFabricStripe(await res.json().catch(() => null));
    stripeCache = { at: now, account: accountName, value };
    if (value) stripeLastGood = { at: now, account: accountName, value };
    return value;
  } catch (err) {
    log.debug(`Fabric stripe fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    if (stripeLastGood && stripeLastGood.account === accountName && now - stripeLastGood.at < STRIPE_LASTGOOD_MS) {
      return stripeLastGood.value;
    }
    return null;
  }
}

/** The last fetched Fabric Stripe account WITHOUT a network call (may be stale/null). */
export function cachedFabricStripe(): FabricStripeAccount | null {
  return stripeCache?.value ?? stripeLastGood?.value ?? null;
}

/** Drop the in-memory Stripe-keys cache so the next fetch re-reads the OS vault (called when
 *  the admin changes the chosen account in-app). */
export function clearFabricStripeCache(): void {
  stripeCache = null;
  stripeLastGood = null;
}

export interface FabricStripeAccountRef {
  id: string;
  label: string;
}

/** List the masjid's Stripe accounts from the OS vault (id + label only, NEVER keys) so the
 *  admin can pick one on the Payments screen — keeps install one-click. Server→server,
 *  fail-soft → [] when the Fabric isn't configured / unreachable. Never throws. */
export async function fetchFabricStripeAccounts(): Promise<FabricStripeAccountRef[]> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return [];
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe/accounts`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const j = (await res.json().catch(() => null)) as { accounts?: unknown } | null;
    const list = Array.isArray(j?.accounts) ? j!.accounts : [];
    return list
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => ({ id: String(a.id), label: typeof a.label === 'string' && a.label ? a.label.slice(0, 80) : String(a.id) }));
  } catch (err) {
    log.debug(`Fabric stripe accounts list failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
