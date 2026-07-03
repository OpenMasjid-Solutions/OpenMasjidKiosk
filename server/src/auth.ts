// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Single-admin local auth — the standalone fallback, and what an OpenMasjidOS SSO
 *  sign-in is minted into. The admin account is created in-app on first run (no install-
 *  time password). Passwords (and, later, the kiosk PIN) are stored as scrypt hashes in
 *  the data volume; the session is a signed, HTTP-only cookie carrying an expiry + an
 *  audience claim. No external crypto dependency (scrypt is in node:crypto and is also
 *  verifiable offline on Android via javax.crypto for the kiosk PIN). */
import crypto from 'node:crypto';

export const COOKIE = 'omkiosk_session';
/** A password login lasts 30 days; an SSO-minted session is capped short (1h) so a stale
 *  platform session can't linger here after a dashboard logout. */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const SSO_SESSION_MS = 60 * 60 * 1000;

export interface Cred {
  hash: string;
  salt: string;
  /** scrypt cost (N) used for this hash. Absent on older hashes → Node default (16384);
   *  stored so we can raise the cost later without locking out existing admins. */
  n?: number;
}

// Hardened cost for new hashes: N=2^16 (4× Node's default). r=8, p=1; maxmem sized for it.
// We avoid 2^17 to stay friendly to small Raspberry Pi hosts. Verification uses whatever N
// a hash was created with.
const SCRYPT_N = 2 ** 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const scryptOpts = (n: number) => ({ N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });

/** Hash a secret (admin password or kiosk PIN) with scrypt. */
export function hashSecret(secret: string): Cred {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(secret, salt, 32, scryptOpts(SCRYPT_N));
  return { hash: dk.toString('hex'), salt: salt.toString('hex'), n: SCRYPT_N };
}

/** Constant-time verify of a secret against a stored scrypt credential. */
export function verifySecret(secret: string, cred: Cred): boolean {
  try {
    const dk = crypto.scryptSync(secret, Buffer.from(cred.salt, 'hex'), 32, scryptOpts(cred.n ?? 16384));
    const stored = Buffer.from(cred.hash, 'hex');
    return stored.length === dk.length && crypto.timingSafeEqual(stored, dk);
  } catch {
    return false;
  }
}

// Back-compat aliases (the admin password uses the same primitives).
export const hashPassword = hashSecret;
export const verifyPassword = verifySecret;

function hmac(secret: Buffer, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

type Audience = 'admin';

export function makeToken(secret: Buffer, maxAgeMs = MAX_AGE_MS, aud: Audience = 'admin'): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + maxAgeMs, aud })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

/** Verify signature, expiry AND audience (constant-time on the signature). */
export function verifyToken(secret: Buffer, token: string | undefined, aud: Audience = 'admin'): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(secret, payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number; aud?: string };
    return typeof obj.exp === 'number' && obj.exp > Date.now() && obj.aud === aud;
  } catch {
    return false;
  }
}

// ── Kiosk exit PIN ──────────────────────────────────────────────────────────
// The PIN is set in the admin UI and synced to the tablet in the device config, where the
// app verifies it OFFLINE. So it's hashed in a single self-describing string both sides can
// parse: `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`. N is modest (2^14) — a PIN is short and
// rate-limited, and this must be fast on a tablet and a Raspberry Pi.
const PIN_N = 2 ** 14;
const PIN_R = 8;
const PIN_P = 1;

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pin, salt, 32, { N: PIN_N, r: PIN_R, p: PIN_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${PIN_N}$${PIN_R}$${PIN_P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const dk = crypto.scryptSync(pin, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/** A long-lived device (tablet) token: a random 256-bit secret. Only its HMAC is stored
 *  server-side (see store.hashDeviceToken); the raw token is shown to the tablet once. */
export function makeDeviceToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** A single-use, human-typeable 6-digit pairing code. Rate-limited + short TTL server-side,
 *  so the 1e6 space can't be brute-forced. */
export function makePairingCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// Set COOKIE_SECURE=1 for HTTPS deployments (we set it in the image, since the platform
// serves us over HTTPS) so the session cookie is only sent over HTTPS. Default OFF so a
// plain-HTTP standalone `docker compose up` on a LAN still signs in.
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || (process.env.COOKIE_SECURE ?? '').toLowerCase() === 'true';

/** Cookie options for @fastify/cookie's setCookie: HTTP-only + SameSite=Lax + Path=/, and
 *  Secure when COOKIE_SECURE is set. */
export function cookieOptions(maxAgeMs = MAX_AGE_MS) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: COOKIE_SECURE,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
