// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * WHO GETS TOLD WHAT — owned here, not only in OpenMasjidOS.
 *
 * The platform has its own alerts matrix (email / webhook / off, per alert), and that stays: it is
 * the masjid's global preference and it keeps working exactly as before. What it cannot do is
 * anything per-app or per-person. It routes to the admin's ONE address and ONE number, and it has
 * no WhatsApp column for apps at all — deliberately, because the platform cannot know which human
 * a given app's alert is about.
 *
 * A kiosk needs that granularity more than most apps. "The foyer reader is offline" should reach
 * the volunteer who walks past the foyer; "a donation was refunded" should reach the treasurer.
 * Those are different people, and neither of them is necessarily whoever set the server up.
 *
 * THE SHAPE, AND WHY IT CHANGED (0.12.0-dev.10). This used to be one route per alert, each holding
 * a single email and a single phone number. That reads fine with six alerts and one recipient, and
 * falls apart the moment a masjid has a treasurer AND a caretaker: the same address had to be
 * retyped into every alert it wanted, and there was nowhere to put a second one. It is now a
 * RECIPIENT LIST crossed with the alert catalogue — one row per person or group, one column per
 * alert, a checkbox at each intersection — which is the model OpenMasjidStudents already uses for
 * the same job (`alert_recipients` there). Only the OpenMasjidOS relay stays per-alert, because it
 * has no recipient of its own: the platform decides where it goes.
 *
 * A ROW IS AN ADDRESS, NOT AN ACCOUNT. Adding a recipient grants no access to anything — the imām,
 * a trustee and the treasurer can all be told about a refund without any of them being able to sign
 * in. That is the same deliberate separation Students draws, and it is why this is not a column on
 * a user record.
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

/**
 * Admin-facing wording, plus what a NEW recipient starts subscribed to.
 *
 * `defaultOn` is the whole design of the add-a-recipient flow in one field, and it is borrowed from
 * Students' `SPEC` table for exactly the same reason: the alerts that cost a masjid money or hide a
 * problem are on for a new address, and the merely chatty ones are not. `payment-failed` is the one
 * to look at twice — it fires per refused PaymentIntent and has no natural bound, so a Stripe
 * outage during jummah is one alert per attempted donation. On by default it would teach a new
 * recipient to filter the whole lot to a folder, alerts that matter included.
 *
 * `carriesDonorIdentity` marks the two alerts whose body names a human. It is what makes the
 * per-group "include donor names" switch possible without guessing: see [redactedFor].
 */
export const ALERT_META: {
  id: AlertId;
  label: string;
  description: string;
  defaultOn: boolean;
  carriesDonorIdentity: boolean;
}[] = [
  {
    id: 'reader-offline',
    label: 'Card reader offline',
    description: 'A tap-to-pay reader stopped responding, so that kiosk can’t take cards.',
    defaultOn: true,
    carriesDonorIdentity: false,
  },
  {
    id: 'payment-failed',
    label: 'A payment couldn’t be started',
    description: 'Stripe refused to set a payment up — usually keys, or Stripe itself being down.',
    // Off for a new recipient ON PURPOSE. It is the only alert here with no natural bound.
    defaultOn: false,
    carriesDonorIdentity: false,
  },
  {
    id: 'monthly-failed',
    label: 'A monthly donation couldn’t be set up',
    description: 'Someone was charged once but no standing order exists, so they may need telling.',
    defaultOn: true,
    carriesDonorIdentity: false,
  },
  {
    id: 'monthly-cancelled',
    label: 'A donor stopped their monthly donation',
    description: 'They used the link in their confirmation email.',
    defaultOn: true,
    carriesDonorIdentity: true,
  },
  {
    id: 'donation-refunded',
    label: 'A donation was refunded',
    description: 'Someone gave a donation back from the Donations screen.',
    defaultOn: true,
    carriesDonorIdentity: true,
  },
  {
    id: 'test',
    label: 'Test message',
    description: 'Only ever sent when you press Send test — it follows these same settings.',
    defaultOn: true,
    carriesDonorIdentity: false,
  },
];

export function isAlertId(v: string): v is AlertId {
  return (ALERT_IDS as readonly string[]).includes(v);
}

/** The alerts a newly-added recipient starts on — "the ones that cost money or hide a problem". */
export function defaultAlertsForNewRecipient(): AlertId[] {
  return ALERT_META.filter((m) => m.defaultOn && m.id !== 'test').map((m) => m.id);
}

// ── The per-alert part: just the platform relay ──────────────────────────────
/**
 * What is still decided per ALERT rather than per recipient.
 *
 * Only the OpenMasjidOS relay, because it is the one channel with no address of its own — the
 * platform routes it by the masjid's own matrix. ON by default, and that default is load-bearing:
 * it means an install upgrading into this feature behaves exactly as it did before, and nobody has
 * to visit the new screen to keep the alerts they already rely on.
 */
export interface AlertRoute {
  os: boolean;
}

export const DEFAULT_ROUTE: Readonly<AlertRoute> = Object.freeze({ os: true });

export type AlertRoutes = Record<AlertId, AlertRoute>;

export function defaultRoutes(): AlertRoutes {
  const out = {} as AlertRoutes;
  for (const id of ALERT_IDS) out[id] = { ...DEFAULT_ROUTE };
  return out;
}

export function sanitizeRoute(patch: Partial<AlertRoute>, current: AlertRoute): AlertRoute {
  const next: AlertRoute = { ...current };
  if (typeof patch.os === 'boolean') next.os = patch.os;
  return next;
}

/**
 * The shape this app stored BEFORE the recipient list, kept solely so an upgrade can carry an
 * admin's settings across. See [migrateLegacyRoutes]. Never written again.
 */
export interface LegacyAlertRoute {
  os: boolean;
  email: string;
  whatsapp: boolean;
  phone: string;
}

// ── Recipients ───────────────────────────────────────────────────────────────
/**
 * `email`   — an address, mailed directly through the masjid's OpenMasjidOS email provider.
 * `phone`   — one WhatsApp number. Digits, international, no plus (see [normalisePhone]).
 * `group`   — a WhatsApp GROUP the admin approved in OpenMasjidOS. One send reaches everyone in it,
 *             which is both cheaper and far safer for the number than messaging each member.
 */
export type RecipientKind = 'email' | 'phone' | 'group';

export const RECIPIENT_KINDS: readonly RecipientKind[] = ['email', 'phone', 'group'];

export function isRecipientKind(v: unknown): v is RecipientKind {
  return typeof v === 'string' && (RECIPIENT_KINDS as readonly string[]).includes(v);
}

export interface AlertRecipient {
  /** Opaque, ours, stable across renames. */
  id: string;
  kind: RecipientKind;
  /** The address itself: a lowercased email, normalised digits, or an approved group id. */
  address: string;
  /** What to call them on screen ("Office", "Ustādh Bilāl", "Trustees"). The address is the identity. */
  label: string;
  /** Which alerts this recipient hears about. */
  alerts: AlertId[];
  /**
   * Include a donor's name and email in the body?
   *
   * PER RECIPIENT, and it exists because of groups. The platform's own contract is blunt about it:
   * "A group post is for genuine announcements. Never use one to tell a family about their own
   * fees: their business is not the other 199 members'." Two of our alerts name a human
   * (`donation-refunded`, `monthly-cancelled`), and everyone in a WhatsApp group can see every
   * other member's number, so a refund notice posted to a group of forty tells forty people who
   * asked for their money back.
   *
   * So a GROUP starts with this OFF and the admin can turn it on for a group where that is
   * genuinely appropriate — a three-person trustees group is not the same as a parents' broadcast.
   * An individual email or number starts with it ON, which is what those channels did before this
   * setting existed, so nothing changes for anyone on upgrade.
   */
  includeNames: boolean;
}

/** What a new recipient of each kind starts as, before the admin ticks anything else. */
export function newRecipient(kind: RecipientKind, address: string, label: string): Omit<AlertRecipient, 'id'> {
  return {
    kind,
    address,
    label,
    alerts: defaultAlertsForNewRecipient(),
    // Groups start redacted. See [AlertRecipient.includeNames].
    includeNames: kind !== 'group',
  };
}

/**
 * A phone number in the form the platform wants: digits only, international, NO leading plus.
 *
 * The platform strips to digits itself and refuses a number with no country code rather than
 * guessing one — which is correct and is why we must not guess either. A UK admin typing
 * `07700 900123` means +44, but assuming that would one day message a stranger in another country,
 * so a number without a country code is rejected here and the UI says why.
 *
 * THE ADMIN PANEL NOW SUPPLIES THE COUNTRY CODE STRUCTURALLY, from a dropdown, so this function's
 * strictness stopped being a papercut without its rules changing at all: what arrives here is
 * already `1` + ten digits, or `44` + the national number. The rules stay because the API is still
 * open to anything an admin can PUT, and because a pasted `+1 (555) 010-1234` must keep working.
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

/**
 * A WhatsApp group id, as the platform issues them: `120363012345678901@g.us`.
 *
 * Shape-checked only. Whether a given group is ALLOWED is not ours to decide and must not be
 * guessed at: the platform answers `403 "That group has not been approved for sending in
 * OpenMasjidOS."` for an id the admin has not approved, and an id we did not get from
 * `GET /api/fabric/whatsapp/groups` is refused by construction. So the admin panel offers a picker
 * of approved groups rather than a text box, and this check is the backstop for the API.
 */
export function groupIdLooksValid(input: string): boolean {
  const v = (input ?? '').trim();
  // COPIED FROM THE PLATFORM, character for character (`GROUP_JID_RE` in its `store/whatsapp.ts`).
  // Being stricter here would be a bug, not extra safety: it would refuse a group the admin really
  // did approve, and the failure would look like the group having vanished from the picker. A
  // `@c.us` (one person) address is refused for the platform's own reason — it would turn "post to
  // the parents group" into "message one person", silently.
  return /^[0-9][0-9-]{0,63}@g\.us$/.test(v);
}

/** Is this address usable for its kind? */
export function addressLooksValid(kind: RecipientKind, address: string): boolean {
  if (kind === 'email') return alertEmailLooksValid(address);
  if (kind === 'phone') return phoneLooksValid(address);
  return groupIdLooksValid(address);
}

/**
 * Put an address into the one canonical form we store it in.
 *
 * Emails are lowercased, which Students does too and for the same reason: `Office@…` and `office@…`
 * are one inbox, and letting both subscribe doubles every message that inbox gets.
 */
export function canonicalAddress(kind: RecipientKind, address: string): string {
  const v = (address ?? '').trim();
  if (kind === 'email') return v.toLowerCase().slice(0, 200);
  if (kind === 'phone') return normalisePhone(v);
  return v.slice(0, 64);
}

/** Clean and bound one recipient as it arrives from the admin API. Unknown keys are dropped. */
export function sanitizeRecipient(
  patch: Partial<AlertRecipient>,
  current: AlertRecipient,
): AlertRecipient {
  const next: AlertRecipient = { ...current, alerts: [...current.alerts] };
  if (typeof patch.label === 'string') next.label = patch.label.trim().slice(0, 80);
  if (typeof patch.includeNames === 'boolean') next.includeNames = patch.includeNames;
  if (typeof patch.address === 'string') {
    const a = canonicalAddress(next.kind, patch.address);
    // An unusable address keeps the one already saved rather than blanking it. A box that empties
    // itself reads as the app having lost the value, and the admin retypes the same thing.
    next.address = a && addressLooksValid(next.kind, a) ? a : current.address;
  }
  if (Array.isArray(patch.alerts)) {
    // De-duplicated and filtered to real ids, so a hand-edited body cannot subscribe someone to an
    // alert that does not exist (which would then be invisible rather than an error).
    const seen = new Set<AlertId>();
    for (const a of patch.alerts) if (typeof a === 'string' && isAlertId(a)) seen.add(a);
    next.alerts = ALERT_IDS.filter((id) => seen.has(id));
  }
  return next;
}

/** Every recipient subscribed to one alert, in catalogue order. */
export function recipientsFor(recipients: AlertRecipient[], id: AlertId): AlertRecipient[] {
  return recipients.filter((r) => r.alerts.includes(id) && addressLooksValid(r.kind, r.address));
}

/**
 * What an alert will ACTUALLY do, once unusable addresses are taken into account.
 *
 * The settings screen shows this so that "three recipients" with two broken addresses reads as what
 * it is. `silent` is the one an admin needs: an alert with the relay off and nobody subscribed goes
 * nowhere, and that must be visible rather than inferred.
 */
export function alertDelivery(
  route: AlertRoute,
  recipients: AlertRecipient[],
  id: AlertId,
): { os: boolean; emails: number; phones: number; groups: number; silent: boolean } {
  const subs = recipientsFor(recipients, id);
  const emails = subs.filter((r) => r.kind === 'email').length;
  const phones = subs.filter((r) => r.kind === 'phone').length;
  const groups = subs.filter((r) => r.kind === 'group').length;
  return { os: route.os, emails, phones, groups, silent: !route.os && emails + phones + groups === 0 };
}

/**
 * Carry a pre-recipient-list install's settings across, losing nothing.
 *
 * The old model held one email and one phone PER ALERT, so the same address could appear against
 * several alerts and two different addresses could appear against two alerts. The migration is
 * therefore a group-by: one recipient per distinct address, subscribed to exactly the alerts it was
 * configured on. A phone only counts where `whatsapp` was actually switched on for that alert,
 * because a number sitting in a box with the toggle off was never sending anything and turning it
 * on for them would be a change they did not ask for.
 *
 * `includeNames: true` on everything this produces — those channels carried the donor's name before
 * this setting existed, and an upgrade must not quietly change what a message says.
 *
 * `os` is carried across per alert, untouched.
 */
export function migrateLegacyRoutes(saved: Partial<Record<string, Partial<LegacyAlertRoute>>>): {
  routes: AlertRoutes;
  recipients: Omit<AlertRecipient, 'id'>[];
} {
  const routes = defaultRoutes();
  const byAddress = new Map<string, { kind: RecipientKind; address: string; alerts: Set<AlertId> }>();

  for (const id of ALERT_IDS) {
    const s = saved?.[id];
    if (!s) continue;
    if (typeof s.os === 'boolean') routes[id] = { os: s.os };

    const email = canonicalAddress('email', typeof s.email === 'string' ? s.email : '');
    if (email && alertEmailLooksValid(email)) {
      const key = `email:${email}`;
      const e = byAddress.get(key) ?? { kind: 'email' as RecipientKind, address: email, alerts: new Set<AlertId>() };
      e.alerts.add(id);
      byAddress.set(key, e);
    }

    // Only where the toggle was actually ON — see the note above.
    if (s.whatsapp === true) {
      const phone = canonicalAddress('phone', typeof s.phone === 'string' ? s.phone : '');
      if (phone) {
        const key = `phone:${phone}`;
        const e = byAddress.get(key) ?? { kind: 'phone' as RecipientKind, address: phone, alerts: new Set<AlertId>() };
        e.alerts.add(id);
        byAddress.set(key, e);
      }
    }
  }

  const recipients = [...byAddress.values()].map((e) => ({
    kind: e.kind,
    address: e.address,
    // No label to carry: the old model never asked for one. The address is the identity.
    label: '',
    alerts: ALERT_IDS.filter((id) => e.alerts.has(id)),
    includeNames: true,
  }));
  return { routes, recipients };
}

// ── Pacing WhatsApp: ours, and now the admin's to set ───────────────────────
/**
 * OpenMasjidOS 0.51.1 removed every limit it used to impose on WhatsApp — the per-recipient
 * cooldown, the hourly and daily caps, quiet hours, the warm-up ramp, the random gap between
 * messages. A message handed over now goes out within seconds.
 *
 * WHY WE PACE AT ALL. Ban risk attaches to the phone NUMBER; that number is shared by every app on
 * the box; and a blocked number cannot be recovered — the masjid loses the number their community
 * reaches them on. It is the one failure in this app that no one can undo. `payment-failed` is the
 * alert that makes it concrete: it fires on every PaymentIntent Stripe refuses, so expired keys on
 * a Friday meant one message per person who tried to give, for the whole of jummah.
 *
 * WHY IT IS CONFIGURABLE, AND WHY THE DEFAULTS ARE MUCH LOOSER THAN THEY WERE. The first version of
 * this gate allowed ONE message per alert per thirty minutes, which is two an hour — below the
 * platform's own historical caps (12/hour, 60/day) and low enough that a caretaker watching a
 * reader flap would simply not be told. The platform's contract is also explicit that an app is the
 * wrong place for a hard ceiling: "an app-level limiter cannot see the number's total traffic,
 * which is the only number WhatsApp cares about." So this is a backstop the masjid sets, not a
 * policy we impose — a small madrasa and a masjid with four kiosks do not want the same number.
 *
 * THREE KNOBS, and each does a different job:
 *  - `minGapMinutes` absorbs a BURST of one repeating alert. It is per alert id, so a Stripe outage
 *    cannot spend the whole hourly budget in ten seconds while a reader-offline waits behind it.
 *  - `maxPerHour` and `maxPerDay` are the budget that actually protects the number. They count
 *    MESSAGES, not alerts, because that is what WhatsApp counts.
 *
 * Whatever is held back is counted and carried on the next message that gets through, so
 * suppression is never silent — "and 23 more since" is far more useful to a caretaker than 23
 * messages, and far more useful than nothing.
 */
export interface WhatsAppPacing {
  /** Minimum minutes between two WhatsApps for the SAME alert. 0 turns the burst gap off. */
  minGapMinutes: number;
  maxPerHour: number;
  maxPerDay: number;
}

export const DEFAULT_PACING: Readonly<WhatsAppPacing> = Object.freeze({
  // Enough to collapse a tight loop into one message, short enough that a real second event within
  // the same few minutes still gets through.
  minGapMinutes: 2,
  // Comfortably above the platform's own retired caps (12/hour, 60/day) — those were found to block
  // ordinary use, and this is a backstop rather than a policy.
  maxPerHour: 20,
  maxPerDay: 100,
});

/** What the admin may set. Generous ceilings: the point is a backstop, not an argument. */
export const PACING_LIMITS = Object.freeze({
  minGapMinutes: { min: 0, max: 240 },
  maxPerHour: { min: 1, max: 200 },
  maxPerDay: { min: 1, max: 2000 },
});

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function sanitizePacing(patch: Partial<WhatsAppPacing>, current: WhatsAppPacing): WhatsAppPacing {
  const next: WhatsAppPacing = { ...current };
  if (patch.minGapMinutes !== undefined) {
    next.minGapMinutes = clampInt(patch.minGapMinutes, PACING_LIMITS.minGapMinutes.min, PACING_LIMITS.minGapMinutes.max, current.minGapMinutes);
  }
  if (patch.maxPerHour !== undefined) {
    next.maxPerHour = clampInt(patch.maxPerHour, PACING_LIMITS.maxPerHour.min, PACING_LIMITS.maxPerHour.max, current.maxPerHour);
  }
  if (patch.maxPerDay !== undefined) {
    next.maxPerDay = clampInt(patch.maxPerDay, PACING_LIMITS.maxPerDay.min, PACING_LIMITS.maxPerDay.max, current.maxPerDay);
  }
  // A day cap below the hour cap is a contradiction the admin cannot see the effect of — the hour
  // cap would simply never be reachable. Raise the day to meet it rather than silently winning.
  if (next.maxPerDay < next.maxPerHour) next.maxPerDay = next.maxPerHour;
  return next;
}

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * What we have actually handed to the platform, and what we held back.
 *
 * `sends` is a plain list of handover timestamps — the hour and day budgets are counted from it, so
 * there is one source of truth for "how much has this number sent because of us". Pruned to the
 * last 24 hours on every read, which also bounds it.
 *
 * PERSISTED, unlike the first version of this gate. In-memory was defensible for a 30-minute gap:
 * a restart let one extra message through and that is the right direction to fail. It is not
 * defensible for a DAY cap, which an in-memory ledger would reset on every deploy — and on the dev
 * channel that is several times an afternoon, so the cap the admin set would be close to fiction.
 */
export interface WhatsAppLedger {
  /** Epoch ms of every message we handed over in the last day, oldest first. */
  sends: number[];
  /** Per alert id: when it last got through, and how many have been held back since. */
  perAlert: Record<string, { lastSentAt: number; suppressed: number }>;
}

export function emptyLedger(): WhatsAppLedger {
  return { sends: [], perAlert: {} };
}

/** Drop anything older than a day. Called on every read so the budgets are always current. */
export function pruneLedger(ledger: WhatsAppLedger, now: number): WhatsAppLedger {
  const cutoff = now - DAY_MS;
  return {
    // Hard cap as well as the time window: a runaway cannot grow this without bound between prunes.
    sends: ledger.sends.filter((t) => t > cutoff).slice(-PACING_LIMITS.maxPerDay.max),
    perAlert: ledger.perAlert,
  };
}

export interface WhatsAppPermit {
  /** How many messages may be handed over right now. 0 means none. */
  allowed: number;
  /** Why not, when `allowed` is 0. '' when there is room. */
  reason: '' | 'gap' | 'hour' | 'day';
  /** How many were held back for this alert before now, to carry on the next message that lands. */
  suppressedBefore: number;
}

/**
 * May this alert send, and how many messages may go?
 *
 * Does NOT record anything — call [recordWhatsAppSends] with what actually went out. Splitting the
 * two matters because an alert can be permitted three messages and only manage one (a refusal, an
 * unreachable platform), and the budget should only be charged for what was really handed over.
 *
 * `test` is deliberately exempt from all three limits: an admin pressed a button and is watching the
 * screen for the result. Throttling that would make the button look broken, which is the opposite
 * of what a test is for.
 */
export function whatsappPermit(
  id: AlertId,
  ledger: WhatsAppLedger | undefined,
  pacing: WhatsAppPacing,
  now: number,
): WhatsAppPermit {
  const l = pruneLedger(ledger ?? emptyLedger(), now);
  const per = l.perAlert[id];
  if (id === 'test') return { allowed: PACING_LIMITS.maxPerHour.max, reason: '', suppressedBefore: 0 };

  const suppressedBefore = per?.suppressed ?? 0;

  // THE BURST GAP, per alert. `lastSentAt <= 0` is its own case rather than a big subtraction: the
  // arithmetic version is right only because a real clock dwarfs the window, i.e. right by luck,
  // and wrong for any caller with a small clock — which is exactly how the test that found it was
  // written.
  if (pacing.minGapMinutes > 0 && per && per.lastSentAt > 0) {
    if (now - per.lastSentAt < pacing.minGapMinutes * 60_000) {
      return { allowed: 0, reason: 'gap', suppressedBefore };
    }
  }

  const inHour = l.sends.reduce((n, t) => (t > now - HOUR_MS ? n + 1 : n), 0);
  const inDay = l.sends.length;
  const hourLeft = pacing.maxPerHour - inHour;
  const dayLeft = pacing.maxPerDay - inDay;
  if (dayLeft <= 0) return { allowed: 0, reason: 'day', suppressedBefore };
  if (hourLeft <= 0) return { allowed: 0, reason: 'hour', suppressedBefore };
  return { allowed: Math.min(hourLeft, dayLeft), reason: '', suppressedBefore };
}

/**
 * Record what actually went out (or that nothing did).
 *
 * `sent > 0` resets this alert's suppressed counter, because the count has just ridden along on a
 * message that got through. `sent === 0` increments it, so the next one can say how many were
 * missed.
 */
export function recordWhatsAppSends(
  ledger: WhatsAppLedger | undefined,
  id: AlertId,
  sent: number,
  now: number,
): WhatsAppLedger {
  const l = pruneLedger(ledger ?? emptyLedger(), now);
  const per = l.perAlert[id] ?? { lastSentAt: 0, suppressed: 0 };
  if (sent > 0) {
    return {
      sends: [...l.sends, ...Array.from({ length: sent }, () => now)].slice(-PACING_LIMITS.maxPerDay.max),
      perAlert: { ...l.perAlert, [id]: { lastSentAt: now, suppressed: 0 } },
    };
  }
  return {
    sends: l.sends,
    perAlert: { ...l.perAlert, [id]: { lastSentAt: per.lastSentAt, suppressed: per.suppressed + 1 } },
  };
}

/** What the admin sees about the budget on the settings screen. */
export function pacingUsage(
  ledger: WhatsAppLedger | undefined,
  pacing: WhatsAppPacing,
  now: number,
): { lastHour: number; lastDay: number; maxPerHour: number; maxPerDay: number } {
  const l = pruneLedger(ledger ?? emptyLedger(), now);
  return {
    lastHour: l.sends.reduce((n, t) => (t > now - HOUR_MS ? n + 1 : n), 0),
    lastDay: l.sends.length,
    maxPerHour: pacing.maxPerHour,
    maxPerDay: pacing.maxPerDay,
  };
}

/** Plain-language reason a message was held back, for the log and the admin panel. */
export function permitReasonText(reason: WhatsAppPermit['reason'], pacing: WhatsAppPacing): string {
  switch (reason) {
    case 'gap':
      return `held back to protect the masjid’s number (one of this kind every ${pacing.minGapMinutes} minute${pacing.minGapMinutes === 1 ? '' : 's'})`;
    case 'hour':
      return `held back — this hour’s limit of ${pacing.maxPerHour} WhatsApp messages is used up`;
    case 'day':
      return `held back — today’s limit of ${pacing.maxPerDay} WhatsApp messages is used up`;
    default:
      return '';
  }
}

/** Append "and N more since" when a burst was held back, so suppression is visible to the reader. */
export function withSuppressedNote(text: string, suppressedBefore: number): string {
  if (suppressedBefore <= 0) return text;
  const n = suppressedBefore;
  return `${text}\n\n(${n} more alert${n === 1 ? '' : 's'} like this ${n === 1 ? 'was' : 'were'} held back to protect the masjid's WhatsApp number. Check the admin panel for the full picture.)`;
}

/**
 * The body to send to one recipient.
 *
 * `full` is what the alert says; `withoutNames` is the same thing with the donor unnamed, supplied
 * by the call site rather than derived here. That is deliberate: stripping a name out of finished
 * prose with a regex is the kind of thing that works on the examples you tried it on and leaks on
 * the one you did not. The two alerts that name a human build both strings; everything else passes
 * only `full` and this returns it either way.
 */
export function bodyForRecipient(
  recipient: Pick<AlertRecipient, 'includeNames'>,
  full: string,
  withoutNames?: string,
): string {
  if (recipient.includeNames) return full;
  return withoutNames ?? full;
}
