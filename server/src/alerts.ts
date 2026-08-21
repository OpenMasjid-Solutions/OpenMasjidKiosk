// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * WHERE EACH ADMIN ALERT GOES — owned here, not only in OpenMasjidOS.
 *
 * The platform has its own alerts matrix (email / webhook / off, per alert), and that stays: it is
 * the masjid's global preference and it keeps working exactly as before. What it cannot do is
 * anything per-app or per-person. It routes to the admin's ONE address and ONE number, and it has
 * no WhatsApp column for apps at all — deliberately, because the platform cannot know which human
 * a given app's alert is about.
 *
 * A kiosk needs that granularity more than most apps. "The foyer reader is offline" should reach
 * the volunteer who walks past the foyer; "a donation was refunded" should reach the treasurer.
 * Those are different people, and neither of them is necessarily whoever set the server up. So each
 * alert gets its own route here, and the platform's matrix stays as the baseline underneath it.
 *
 * THE DEFAULTS ARE THE IMPORTANT PART. `os: true` on every alert means an existing install behaves
 * on upgrade exactly as it did before this screen existed — nobody has to visit it to keep the
 * alerts they already rely on. `whatsapp: false` means the new channel is opt-in, per alert, which
 * is the right default for a channel that costs the masjid's phone number its reputation if it is
 * over-used.
 *
 * Pure and exported so the rules are unit-tested rather than asserted in a comment.
 */

/** Every alert this app can raise. MUST match the `alerts:` ids in manifest.yaml — the platform
 *  refuses one it was not told about, and `alerts.test.ts` parses the manifest to prove it. */
export const ALERT_IDS = [
  'reader-offline',
  'payment-failed',
  'monthly-failed',
  'monthly-cancelled',
  'donation-refunded',
  'test',
] as const;

export type AlertId = (typeof ALERT_IDS)[number];

/** Admin-facing wording. Kept beside the ids so the settings screen and the manifest cannot drift
 *  into describing the same alert two different ways. */
export const ALERT_META: { id: AlertId; label: string; description: string }[] = [
  { id: 'reader-offline', label: 'Card reader offline', description: 'A tap-to-pay reader stopped responding, so that kiosk can’t take cards.' },
  { id: 'payment-failed', label: 'A payment couldn’t be started', description: 'Stripe refused to set a payment up — usually keys, or Stripe itself being down.' },
  { id: 'monthly-failed', label: 'A monthly donation couldn’t be set up', description: 'Someone was charged once but no standing order exists, so they may need telling.' },
  { id: 'monthly-cancelled', label: 'A donor stopped their monthly donation', description: 'They used the link in their confirmation email.' },
  { id: 'donation-refunded', label: 'A donation was refunded', description: 'Someone gave a donation back from the Donations screen.' },
  { id: 'test', label: 'Test message', description: 'Only ever sent when you press Send test — it follows these same settings.' },
];

/**
 * Where one alert goes.
 *
 * These are ADDITIVE, not a choice of one. An admin who wants the OS alert and a WhatsApp to the
 * caretaker gets both; the fan-out never picks a "best" channel on their behalf, because a channel
 * silently not firing is the failure that matters here.
 */
export interface AlertRoute {
  /** Relay through OpenMasjidOS, which delivers per the admin's own alerts matrix (email, webhook,
   *  both, or off). ON by default so upgrading changes nothing. */
  os: boolean;
  /** ALSO email this address directly, through the masjid's OpenMasjidOS email provider. Blank =
   *  don't. This is on top of whatever the platform's matrix does, which the UI says plainly —
   *  setting it to the same address the platform already uses means two emails, not one. */
  email: string;
  /** ALSO send a WhatsApp. OFF by default: it is the masjid's own number and its reputation. */
  whatsapp: boolean;
  /** Where to send it. Digits, international, no plus — see [normalisePhone]. Blank = nowhere,
   *  which is why `whatsapp: true` alone never sends anything. */
  phone: string;
}

/** What every alert starts as. Email through the platform ON, WhatsApp OFF. */
export const DEFAULT_ROUTE: Readonly<AlertRoute> = Object.freeze({ os: true, email: '', whatsapp: false, phone: '' });

export type AlertRoutes = Record<AlertId, AlertRoute>;

export function isAlertId(v: string): v is AlertId {
  return (ALERT_IDS as readonly string[]).includes(v);
}

/** Every alert at its default — the shape a fresh install starts from. */
export function defaultRoutes(): AlertRoutes {
  const out = {} as AlertRoutes;
  for (const id of ALERT_IDS) out[id] = { ...DEFAULT_ROUTE };
  return out;
}

/**
 * A phone number in the form the platform wants: digits only, international, NO leading plus.
 *
 * The platform strips to digits itself and refuses a number with no country code rather than
 * guessing one — which is correct and is why we must not guess either. A UK admin typing
 * `07700 900123` means +44, but assuming that would one day message a stranger in another country,
 * so a number without a country code is rejected here and the UI says why.
 *
 * `00` is the international access prefix in much of the world and means the same thing as `+`, so
 * it is folded rather than treated as part of the number.
 *
 * Returns '' when the input cannot be a valid international number.
 */
export function normalisePhone(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  // Anything other than digits, spaces, and the usual punctuation means this is not a phone number.
  if (/[^\d\s+()\-.]/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  // `00` and `+` are the same instruction: what follows is a country code.
  if (!raw.trimStart().startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
  // A leading zero after that is a TRUNK prefix — a national shorthand that is not part of the
  // international number, and the surest sign the country code is missing. Refuse rather than strip
  // it: "07700 900123" is unambiguous to a person and ambiguous to us.
  if (digits.startsWith('0')) return '';
  // E.164 allows at most 15 digits; a country code plus a subscriber number is never below 8.
  if (digits.length < 8 || digits.length > 15) return '';
  return digits;
}

/** Would this be accepted? Convenience for the UI and for validation messages. */
export function phoneLooksValid(input: string): boolean {
  return normalisePhone(input) !== '';
}

/** The same shape check the receipt path uses — one definition of "looks like an email" so the
 *  settings screen and the sender can never disagree about whether an address is usable. */
export function alertEmailLooksValid(input: string): boolean {
  const v = (input ?? '').trim();
  return v.length > 0 && v.length <= 200 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v);
}

/** Clean and bound one route as it comes in from the admin API. Unknown keys are dropped, an
 *  unusable phone/email is stored as blank rather than kept and silently never used. */
export function sanitizeRoute(patch: Partial<AlertRoute>, current: AlertRoute): AlertRoute {
  const next: AlertRoute = { ...current };
  if (typeof patch.os === 'boolean') next.os = patch.os;
  if (typeof patch.whatsapp === 'boolean') next.whatsapp = patch.whatsapp;
  if (typeof patch.email === 'string') {
    const e = patch.email.trim().slice(0, 200);
    next.email = e === '' || alertEmailLooksValid(e) ? e : current.email;
  }
  if (typeof patch.phone === 'string') {
    const p = patch.phone.trim();
    next.phone = p === '' ? '' : normalisePhone(p) || current.phone;
  }
  return next;
}

/** What a route will ACTUALLY do, once blank addresses are taken into account. The settings screen
 *  shows this so "WhatsApp: on" with no number reads as what it is — nothing. */
export function routeSummary(r: AlertRoute): { os: boolean; email: boolean; whatsapp: boolean; silent: boolean } {
  const email = alertEmailLooksValid(r.email);
  const whatsapp = r.whatsapp && normalisePhone(r.phone) !== '';
  return { os: r.os, email, whatsapp, silent: !r.os && !email && !whatsapp };
}

// ── Pacing WhatsApp: ours now, because the platform stopped ─────────────────
/**
 * OpenMasjidOS 0.51.1 removed every limit it used to impose on WhatsApp — the per-recipient
 * cooldown, the hourly and daily caps, quiet hours, the warm-up ramp, the random gap between
 * messages. A message handed over now goes out within seconds. That is a large improvement for a
 * reader-offline alert and a hazard for everything else, because it silently deleted a backstop we
 * were relying on without ever having decided to.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Ban risk attaches to the phone NUMBER; that number is shared
 * by every app on the box; and a blocked number cannot be recovered — the masjid loses the number
 * their community reaches them on. It is the one failure in this app that no one can undo.
 *
 * THE ALERT THAT MADE THIS NECESSARY is `payment-failed`. It fires on every PaymentIntent that
 * Stripe refuses, and it is the only alert with no natural bound: expired keys on a Friday means one
 * message per person who tries to give, for the whole of jummah. The platform's 60-second
 * per-recipient cooldown used to absorb exactly that. Nothing absorbs it now. (`reader-offline` is
 * debounced and latched to one message per outage; refunds and cancellations are one per human
 * action. This gate is cheap insurance for those and load-bearing for that one.)
 *
 * WHAT IT DOES: one WhatsApp per alert id per window, and it counts what it held back so the next
 * message can say so — "and 23 more since" is far more useful to a caretaker than 23 messages, and
 * it means suppression is never silent.
 *
 * `test` is deliberately exempt: an admin pressed a button and is watching the screen for the
 * result. Throttling that would make the button look broken.
 *
 * State is in memory. A restart resets it and lets one extra message through, which is the right
 * direction to fail — a duplicate alert costs nothing, a swallowed one costs the thing the alert
 * was for. Pure, so the rule is unit-tested rather than asserted in a comment.
 */
export const WHATSAPP_MIN_GAP_MS = 30 * 60_000;

export interface WhatsAppGateState {
  /** When we last actually handed a message to the platform for this alert. */
  lastSentAt: number;
  /** How many we have held back since then. */
  suppressed: number;
}

export interface WhatsAppGateResult {
  send: boolean;
  /** How many were held back before this one — 0 unless we are breaking a quiet spell. */
  suppressedBefore: number;
  next: WhatsAppGateState;
}

export function whatsappGate(id: AlertId, state: WhatsAppGateState | undefined, now: number): WhatsAppGateResult {
  // The admin is standing there watching for it.
  if (id === 'test') return { send: true, suppressedBefore: 0, next: { lastSentAt: now, suppressed: 0 } };
  // NEVER SENT is its own case, not `lastSentAt: 0` and a big subtraction. The arithmetic version
  // happens to work with a real clock only because `Date.now()` dwarfs the window, so it is right
  // by luck rather than by construction — and it is wrong for any caller with a small clock,
  // which is exactly how the test that found this was written.
  if (!state || state.lastSentAt <= 0) {
    return { send: true, suppressedBefore: state?.suppressed ?? 0, next: { lastSentAt: now, suppressed: 0 } };
  }
  if (now - state.lastSentAt >= WHATSAPP_MIN_GAP_MS) {
    return { send: true, suppressedBefore: state.suppressed, next: { lastSentAt: now, suppressed: 0 } };
  }
  return {
    send: false,
    suppressedBefore: state.suppressed,
    next: { lastSentAt: state.lastSentAt, suppressed: state.suppressed + 1 },
  };
}

/** Append "and N more since" when a burst was held back, so suppression is visible to the reader. */
export function withSuppressedNote(text: string, suppressedBefore: number): string {
  if (suppressedBefore <= 0) return text;
  const n = suppressedBefore;
  return `${text}\n\n(${n} more alert${n === 1 ? '' : 's'} like this ${n === 1 ? 'was' : 'were'} held back in the last half hour, to protect the masjid's WhatsApp number. Check the admin panel for the full picture.)`;
}
