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
const SWEEP_AT = 5_000; // sweep lapsed entries once the map gets this big

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
    this.sweep();
  }

  /** Drop entries whose backoff has lapsed, so the map can't grow without bound.
   *
   *  The previous condition (`v.next <= now && v.fails <= MAX_FREE`) could only ever match entries
   *  that had never been throttled — those always have `next === 0` — so precisely the entries that
   *  consume memory, the throttled ones, were kept forever. An expired backoff carries no state
   *  worth remembering: the attacker gets their free attempts back either way once it lapses. */
  private sweep(): void {
    if (this.map.size <= SWEEP_AT) return;
    const now = Date.now();
    for (const [k, v] of this.map) if (v.next <= now) this.map.delete(k);
  }

  /** Clear the counter after a success. */
  succeed(key: string): void {
    this.map.delete(key);
  }
}

/**
 * A failure budget shared across ALL callers, for guessable secrets where a per-peer limit isn't
 * enough on its own.
 *
 * The pairing code is the case in point: 6 digits, so a million possibilities, and [LoginLimiter]
 * gives every source address five free guesses before it starts throttling. An attacker with a
 * thousand addresses — a /64 of IPv6 is one host's worth on a LAN — therefore gets five thousand
 * free guesses, and the per-peer limiter never notices. This caps the total across everyone.
 *
 * Sized well above any real pairing session: a volunteer types the code correctly, or once wrong.
 * When the budget does run out, everyone waits — which is the right trade for a code that only
 * exists for ten minutes after an admin deliberately pressed a button, and which the admin can
 * simply re-issue afterwards.
 */
export class GlobalAttemptBudget {
  private count = 0;
  private windowEnd = 0;

  constructor(
    private readonly max = 50,
    private readonly windowMs = 10 * 60_000,
  ) {}

  /** Milliseconds until the budget refills (0 = attempts are allowed now). */
  retryAfterMs(now = Date.now()): number {
    if (now >= this.windowEnd) return 0;
    return this.count >= this.max ? this.windowEnd - now : 0;
  }

  /** Spend one unit of the budget. */
  fail(now = Date.now()): void {
    if (now >= this.windowEnd) {
      this.count = 0;
      this.windowEnd = now + this.windowMs;
    }
    this.count += 1;
  }
}
