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
