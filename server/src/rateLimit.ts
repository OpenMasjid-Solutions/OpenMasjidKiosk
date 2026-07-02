// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** In-memory brute-force limiter for the admin password login (and, later, kiosk PIN /
 *  pairing attempts). Keyed on the real TCP peer — never a spoofable header. A few free
 *  attempts, then exponential backoff up to a cap. Not persisted: a restart clears it,
 *  which is fine for a small single-host app. */
interface Attempt {
  fails: number;
  next: number; // earliest epoch-ms a new attempt is allowed
}

const MAX_FREE = 5; // attempts before backoff kicks in
const BASE_MS = 2_000; // first backoff after the free attempts
const CAP_MS = 5 * 60_000; // maximum backoff

export class LoginLimiter {
  private readonly map = new Map<string, Attempt>();

  /** Milliseconds the caller must wait before another attempt (0 = allowed now). */
  retryAfterMs(key: string): number {
    const a = this.map.get(key);
    if (!a) return 0;
    const wait = a.next - Date.now();
    return wait > 0 ? wait : 0;
  }

  /** Record a failed attempt and grow the backoff. */
  fail(key: string): void {
    const a = this.map.get(key) ?? { fails: 0, next: 0 };
    a.fails += 1;
    if (a.fails > MAX_FREE) {
      const backoff = Math.min(CAP_MS, BASE_MS * 2 ** (a.fails - MAX_FREE - 1));
      a.next = Date.now() + backoff;
    }
    this.map.set(key, a);
    // Opportunistic cleanup so the map can't grow without bound.
    if (this.map.size > 5000) {
      const now = Date.now();
      for (const [k, v] of this.map) if (v.next <= now && v.fails <= MAX_FREE) this.map.delete(k);
    }
  }

  /** Clear the counter after a success. */
  succeed(key: string): void {
    this.map.delete(key);
  }
}
