// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Stripe helpers. The SECRET key lives only in memory here — never returned to the
 *  browser or the tablet, never logged, never written to the data volume. The tablet only
 *  ever receives Terminal **connection tokens** and PaymentIntent client secrets.
 *
 *  Unlike the web-checkout apps, the kiosk uses Stripe **Terminal** (card-present via the
 *  M2 reader): connection tokens, a Terminal Location, and (in later slices) card_present
 *  PaymentIntents. The API version is pinned explicitly (Terminal features are version-
 *  sensitive) rather than floating with the SDK default. */
import Stripe from 'stripe';

/** Pinned to the version the installed SDK targets, so behaviour can't silently drift. */
const STRIPE_API_VERSION = '2025-02-24.acacia';

export interface StripeKeys {
  publishableKey: string;
  secretKey: string;
}

export type StripeMode = 'test' | 'live' | 'unknown';

/** A Stripe client with a sane network timeout + one retry (the SDK default is 80s). */
export function client(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, timeout: 20_000, maxNetworkRetries: 1 });
}

const PK_RE = /^pk_(test|live)_[A-Za-z0-9]+$/;
const SK_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;

export function looksLikePublishable(k: string): boolean {
  return PK_RE.test(k);
}
export function looksLikeSecret(k: string): boolean {
  return SK_RE.test(k);
}

/** Test vs live, inferred from the key prefixes (no network call). */
export function stripeMode(cfg: Pick<StripeKeys, 'publishableKey' | 'secretKey'>): StripeMode {
  const k = cfg.secretKey || cfg.publishableKey;
  if (/^[a-z]+_test_/.test(k)) return 'test';
  if (/^[a-z]+_live_/.test(k)) return 'live';
  return 'unknown';
}

/** Configured = a valid-looking publishable + secret pair, in the SAME mode. */
export function stripeConfigured(cfg: StripeKeys): boolean {
  if (!looksLikePublishable(cfg.publishableKey) || !looksLikeSecret(cfg.secretKey)) return false;
  return cfg.publishableKey.split('_')[1] === cfg.secretKey.split('_')[1]; // both test or both live
}

/** The non-secret view of the Stripe config, safe to send to the browser. */
export function publicStripeStatus(cfg: StripeKeys) {
  return {
    publishableKey: cfg.publishableKey, // safe — the browser/tablet needs this
    hasSecretKey: !!cfg.secretKey,
    mode: stripeMode(cfg),
    configured: stripeConfigured(cfg),
    keysMismatch:
      !!cfg.publishableKey &&
      !!cfg.secretKey &&
      looksLikePublishable(cfg.publishableKey) &&
      looksLikeSecret(cfg.secretKey) &&
      cfg.publishableKey.split('_')[1] !== cfg.secretKey.split('_')[1],
  };
}

/** Ask Stripe to confirm the secret key works (a cheap balance.retrieve). Never throws. */
export async function verifySecretKey(secretKey: string): Promise<{ ok: boolean; mode?: StripeMode; message?: string }> {
  if (!looksLikeSecret(secretKey)) {
    return { ok: false, message: 'That doesn’t look like a Stripe secret key — it should start with sk_.' };
  }
  try {
    const balance = await client(secretKey).balance.retrieve();
    return { ok: true, mode: balance.livemode ? 'live' : 'test' };
  } catch (err) {
    const e = err as { type?: string };
    if (e.type === 'StripeAuthenticationError') {
      return { ok: false, message: 'Stripe didn’t accept that secret key. Check you copied the whole key.' };
    }
    return { ok: false, message: 'Couldn’t reach Stripe to check the key. Check your connection and try again.' };
  }
}

// ── Currency minor units ──────────────────────────────────────────────────────
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
// Three-decimal currencies (Gulf/Maghreb) — 1 major unit = 1000 minor units. (Stripe requires the
// smallest amount to be a multiple of 10 for these; we don't enforce that here.)
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
export function currencyDecimals(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyDecimals(currency));
}
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDecimals(currency);
}

// ── Terminal: connection tokens + Locations ─────────────────────────────────────
/** Mint a Terminal connection token — the ONLY Stripe credential the tablet ever gets
 *  (short-lived by design). Scoped to a Location when one is set. */
export async function createConnectionToken(secretKey: string, locationId?: string): Promise<string> {
  const token = await client(secretKey).terminal.connectionTokens.create(locationId ? { location: locationId } : {});
  return token.secret;
}

export interface TerminalLocationView {
  id: string;
  displayName: string;
  /** A single-line, human-friendly address for display. */
  address: string;
}

export interface TerminalAddressInput {
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2 country code (required by Stripe). */
  country: string;
}

function formatAddress(a?: Stripe.Address | null): string {
  if (!a) return '';
  return [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ');
}

function toView(loc: Stripe.Terminal.Location): TerminalLocationView {
  return { id: loc.id, displayName: loc.display_name ?? '', address: formatAddress(loc.address) };
}

/** List the Terminal Locations on this account (readers must connect with a locationId). */
export async function listLocations(secretKey: string): Promise<TerminalLocationView[]> {
  const res = await client(secretKey).terminal.locations.list({ limit: 100 });
  return res.data.map(toView);
}

/** Create a Terminal Location (named after the masjid; address entered by the admin — the
 *  platform injects no profile). country is required by Stripe. */
export async function createLocation(secretKey: string, displayName: string, address: TerminalAddressInput): Promise<TerminalLocationView> {
  const loc = await client(secretKey).terminal.locations.create({
    display_name: displayName,
    address: {
      line1: address.line1,
      line2: address.line2 || undefined,
      city: address.city || undefined,
      state: address.state || undefined,
      postal_code: address.postalCode || undefined,
      country: address.country,
    },
  });
  return toView(loc);
}

/** Confirm a Location still exists on the account (returns null if not / on error). */
export async function retrieveLocation(secretKey: string, id: string): Promise<TerminalLocationView | null> {
  try {
    const loc = await client(secretKey).terminal.locations.retrieve(id);
    if ((loc as { deleted?: boolean }).deleted) return null;
    return toView(loc as Stripe.Terminal.Location);
  } catch {
    return null;
  }
}

// ── Terminal: card-present PaymentIntents (the one-time donation core) ────────────
export interface CreatePaymentIntentInput {
  amountMinor: number;
  currency: string;
  description?: string;
  receiptEmail?: string;
  metadata?: Record<string, string>;
}

/** Create a card-present PaymentIntent for the reader to collect + confirm. Manual capture:
 *  the tablet confirms, the PI lands in `requires_capture`, and the SERVER captures it in
 *  [completeCardPresentPaymentIntent] only after re-checking with Stripe — so a donation is
 *  never recorded on the tablet's word alone. An idempotency key makes retries safe. */
export async function createCardPresentPaymentIntent(
  secretKey: string,
  input: CreatePaymentIntentInput,
  idempotencyKey?: string,
): Promise<{ id: string; clientSecret: string }> {
  const pi = await client(secretKey).paymentIntents.create(
    {
      amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'manual',
      description: input.description || undefined,
      receipt_email: input.receiptEmail || undefined,
      metadata: input.metadata,
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
  return { id: pi.id, clientSecret: pi.client_secret ?? '' };
}

/** Create a **keyed/manual** (card, not card-present) PaymentIntent. The donor types the card into
 *  Stripe's own SDK form on the tablet, which tokenises it and confirms this PI directly with Stripe
 *  — our code/server never sees the card number (same posture as the reader). Automatic capture: the
 *  SDK confirm settles it, and [completeCardPresentPaymentIntent] verifies `succeeded` before we record. */
export async function createCardPaymentIntent(
  secretKey: string,
  input: CreatePaymentIntentInput,
  idempotencyKey?: string,
): Promise<{ id: string; clientSecret: string }> {
  const pi = await client(secretKey).paymentIntents.create(
    {
      amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      // CARD ONLY for the kiosk's keyed entry. We deliberately do NOT use automatic_payment_methods:
      // that offers Link (and wallets), whose verification opens an EXTERNAL browser — which a
      // device-owner Lock Task kiosk blocks (only our package is allow-listed), so the payment could
      // never confirm. Cards authenticate via native 3DS2 in-process (or, rarely, a Custom Tab we now
      // allow-list during lock task — see KioskController.enterKiosk).
      payment_method_types: ['card'],
      description: input.description || undefined,
      receipt_email: input.receiptEmail || undefined,
      metadata: input.metadata,
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
  return { id: pi.id, clientSecret: pi.client_secret ?? '' };
}

export interface CompletedPaymentIntent {
  status: string;
  succeeded: boolean;
  amountMinor: number;
  currency: string;
  chargeId?: string;
  /** The reusable PaymentMethod Stripe derives from a card-present charge (monthly, slice 7). */
  generatedCard?: string;
  /** Card brand + last 4 from the charge (for the emailed receipt's "payment method" line). */
  cardBrand?: string;
  cardLast4?: string;
  receiptUrl?: string;
  /** When Stripe created the PaymentIntent (epoch seconds). Deterministic per PI, so it anchors the
   *  monthly subscription's first-charge date identically on any retry (keeps idempotency stable). */
  createdSec: number;
  /** The metadata we set at create time (device id, kind, donor name/email) — trustworthy since
   *  it comes back from Stripe, not the tablet. */
  metadata: Record<string, string>;
}

/** The server side of "verify before we record": retrieve the PI from Stripe, capture it if it's
 *  `requires_capture`, and report the TRUE outcome. Never trusts the tablet. */
export async function completeCardPresentPaymentIntent(secretKey: string, id: string): Promise<CompletedPaymentIntent> {
  const c = client(secretKey);
  let pi = await c.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
  if (pi.status === 'requires_capture') {
    pi = await c.paymentIntents.capture(id, { expand: ['latest_charge'] });
  }
  const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? (pi.latest_charge as Stripe.Charge) : undefined;
  const pmd = charge?.payment_method_details;
  const cardPresent = pmd?.card_present as { generated_card?: string | null; brand?: string | null; last4?: string | null } | undefined;
  // The brand/last4 live under card_present (reader) or card (keyed entry) depending on the flow.
  const card = pmd?.card as { brand?: string | null; last4?: string | null } | undefined;
  return {
    status: pi.status,
    succeeded: pi.status === 'succeeded',
    amountMinor: pi.amount,
    currency: pi.currency.toUpperCase(),
    chargeId: charge?.id,
    generatedCard: cardPresent?.generated_card ?? undefined,
    cardBrand: cardPresent?.brand ?? card?.brand ?? undefined,
    cardLast4: cardPresent?.last4 ?? card?.last4 ?? undefined,
    receiptUrl: charge?.receipt_url ?? undefined,
    createdSec: pi.created,
    metadata: (pi.metadata ?? {}) as Record<string, string>,
  };
}

/**
 * Ask Stripe to email its own built-in receipt for a charge we had suppressed.
 *
 * The branded-receipt path deliberately omits `receipt_email` at intent so Stripe stays quiet and
 * our own message is the only one the donor gets. When that message then proves permanently
 * unsendable, the donor would be left with NOTHING — so hand the job back: setting `receipt_email`
 * on the charge is what makes Stripe send, and it works after the fact, not just at intent.
 *
 * Idempotent in the way that matters: Stripe sends one receipt per charge for a given address, so a
 * retried fallback does not produce a second email. Never throws — a failed fallback must not
 * disturb a donation that has already succeeded and been recorded.
 *
 * (Stripe only actually delivers receipts in live mode; in test mode the call succeeds and no mail
 * is sent, which is Stripe's behaviour and not something this can work around.)
 */
export async function sendStripeReceipt(secretKey: string, chargeId: string, email: string): Promise<boolean> {
  if (!chargeId || !email.trim()) return false;
  try {
    await client(secretKey).charges.update(chargeId, { receipt_email: email.trim() });
    return true;
  } catch {
    return false;
  }
}

// ── Monthly donations: Customer + Subscription from the card-present charge (slice 7) ──────
export interface MonthlySubscriptionInput {
  amountMinor: number;
  currency: string;
  /** The reusable PaymentMethod Stripe derived from the card-present charge (generated_card). */
  paymentMethod: string;
  name?: string;
  email?: string;
  /** Human product name shown on the donor's Stripe invoices, e.g. "Monthly donation — Al-Noor". */
  productName: string;
  deviceId?: string;
  /** Which campaign the donor chose. Stamped on the SUBSCRIPTION metadata so the Recurring screen
   *  can still say what a plan is for years later, when the local row has been restored from a
   *  backup that predates it — Stripe is the copy that always survives. */
  campaignId?: string;
  campaignTitle?: string;
  /** Epoch seconds to anchor the first recurring charge one month after (use the PaymentIntent's
   *  `created` — deterministic per PI, so trial_end is identical on a retry and idempotency holds). */
  anchorSec: number;
  /** Stable key (the PaymentIntent id) so a retried `/complete` can't create a second customer
   *  or subscription — same key + same body → Stripe returns the original object. */
  idempotencyKey?: string;
}

export interface MonthlySubscriptionResult {
  created: boolean;
  subscriptionId?: string;
  customerId?: string;
  reason?: string;
}

/**
 * Set up an ongoing monthly donation from a card-present first payment. The FIRST month is the
 * card-present PaymentIntent already collected + captured on the reader; here we only arrange the
 * *recurring* part: create a Customer, attach the reusable card, and create a monthly Subscription
 * whose first automatic charge is one month out (`trial_end`) so the donor is never double-charged
 * for month one. Stripe emails invoice receipts on each renewal automatically. We do NOT track
 * renewals (no webhooks, LAN-only) — the admin sees active subscriptions in the Stripe dashboard.
 */
export async function createMonthlySubscription(secretKey: string, input: MonthlySubscriptionInput): Promise<MonthlySubscriptionResult> {
  const c = client(secretKey);
  const idem = input.idempotencyKey;
  const customer = await c.customers.create(
    {
      name: input.name || undefined,
      email: input.email || undefined,
      payment_method: input.paymentMethod, // attaches the generated_card to the customer
      invoice_settings: { default_payment_method: input.paymentMethod },
      metadata: { app: 'kiosk', deviceId: input.deviceId || '' },
    },
    idem ? { idempotencyKey: `${idem}_cust` } : undefined,
  );
  // A recurring monthly Price for this amount. Subscription `price_data` requires an existing
  // product id, whereas `prices.create` accepts an inline `product_data` (auto-creating the
  // product) — account-agnostic and idempotent, so we build the price here then subscribe to it.
  const price = await c.prices.create(
    {
      currency: input.currency.toLowerCase(),
      unit_amount: input.amountMinor,
      recurring: { interval: 'month' },
      product_data: { name: input.productName },
    },
    idem ? { idempotencyKey: `${idem}_price` } : undefined,
  );
  // Anchor the first recurring charge to the same day next month (first month already collected).
  // Derived from a FIXED timestamp (the PI's created) so a retried /complete recomputes the exact
  // same trial_end — otherwise the `_sub` idempotency key would carry a different body and Stripe
  // would reject it. Clamp the day so a month-end signup (e.g. Jan 31) doesn't overflow past Feb.
  const anchor = new Date(input.anchorSec * 1000);
  const daysInNextMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 2, 0).getDate();
  anchor.setDate(1);
  anchor.setMonth(anchor.getMonth() + 1);
  anchor.setDate(Math.min(new Date(input.anchorSec * 1000).getDate(), daysInNextMonth));
  const trialEnd = Math.floor(anchor.getTime() / 1000);
  const sub = await c.subscriptions.create(
    {
      customer: customer.id,
      items: [{ price: price.id }],
      default_payment_method: input.paymentMethod,
      trial_end: trialEnd,
      metadata: { app: 'kiosk', deviceId: input.deviceId || '', campaignId: input.campaignId || '', campaign: input.campaignTitle || '' },
    },
    idem ? { idempotencyKey: `${idem}_sub` } : undefined,
  );
  return { created: true, subscriptionId: sub.id, customerId: customer.id };
}

// ── Recurring plans: reading and steering live donor subscriptions ───────────────────────
/** Stripe ids are opaque but their prefixes are not, and everything below either reads a donor's
 *  standing order or stops it. Refusing anything that isn't a subscription id means a mistyped or
 *  pasted id (a customer, a PaymentIntent, a schedule) can never reach a cancel. */
// A subscription id is alphanumeric after its prefix; allowing '_' through let 'sub_sched_…' —
// a Subscription SCHEDULE, one of the very things this guard names — sail past it.
const SUB_ID_RE = /^sub_[A-Za-z0-9]{1,250}$/;

function assertSubscriptionId(id: string): void {
  if (!SUB_ID_RE.test(id)) throw new Error('That doesn’t look like a subscription id.');
}

/** Default number of plans the Recurring screen pulls, and the ceiling a caller may ask for. */
const PLAN_LIST_DEFAULT = 200;
const PLAN_LIST_MAX = 500;
/** How many paid invoices the account-wide totals scan will walk. Stripe returns newest first, so a
 *  busier account than this loses its OLDEST invoices from the list totals, never its recent ones. */
const PLAN_INVOICE_SCAN_CAP = 1000;
/** Same idea for one plan on its own — 600 monthly invoices is fifty years of giving. */
const PLAN_TOTAL_INVOICE_CAP = 600;
/** How many future charges an admin may schedule before we assume a slipped finger. */
const MAX_SCHEDULED_CHARGES = 600;

/** Expansions we need to describe a plan: who gives it, and on which card. Three levels deep on the
 *  customer's fallback card, which is inside Stripe's four-level limit. */
const PLAN_EXPAND = ['customer', 'default_payment_method', 'customer.invoice_settings.default_payment_method'];

/**
 * One recurring donation, as Stripe knows it. Deliberately not the whole picture the admin sees:
 * which campaign it was given to, which of our Stripe accounts it lives on, and the first
 * card-present payment all come from our own records, because Stripe can't tell us. In particular
 * `totalMinor` counts INVOICES only — the first month was a card-present PaymentIntent taken on the
 * reader and never became an invoice, which is exactly what the caller's `totalPartial` flag warns
 * a reader of.
 */
export interface StripePlan {
  id: string;
  customerId: string;
  donorName: string;
  donorEmail: string;
  /** Per charge, integer minor units. */
  amountMinor: number;
  currency: string;
  /** 'day' | 'week' | 'month' | 'year'. */
  interval: string;
  intervalCount: number;
  /** Everything Stripe has collected on this subscription (paid invoices), in minor units. */
  totalMinor: number;
  startedAt: string;
  /** ISO of the most recent paid invoice; '' when Stripe hasn't charged this plan yet. */
  lastChargeAt: string;
  /** ISO of the next charge; '' when none is coming (over, paused, or ending at period end). */
  nextChargeAt: string;
  cardBrand: string;
  cardLast4: string;
  status: string;
  paused: boolean;
  /** ISO of a scheduled end; '' when nothing is scheduled. */
  cancelAt: string;
  cancelAtPeriodEnd: boolean;
  deviceId: string;
  /** The campaign this plan was set up from, as stamped on the SUBSCRIPTION at creation. The local
   *   row is the primary source; these are the copy that survives a restore from a backup
   *  older than that row, so the screen can still say what a donor is giving to. Blank on plans
   *  created before the kiosk started stamping them. */
  campaignId: string;
  campaignTitle: string;
}

/** One line of a plan's giving history. */
export interface PlanInvoiceRow {
  id: string;
  date: string;
  amountMinor: number;
  currency: string;
  status: string;
  paid: boolean;
  attempts: number;
  failureReason: string;
  hostedUrl: string;
}

function isoOrEmpty(sec?: number | null): string {
  return sec ? new Date(sec * 1000).toISOString() : '';
}

/** A caller's page size turned into one Stripe will accept: whole, in range, and never NaN — an
 *  autopaging call handed a NaN limit throws instead of paging. */
function clampLimit(asked: number | undefined, fallback: number, max: number): number {
  const n = Number(asked);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.round(n)), max);
}

/** Running total + latest payment for one subscription, gathered from its paid invoices. */
interface PaidTally {
  minor: number;
  lastSec: number;
}

/** The card the renewals will actually be taken on: the subscription's own default first, the
 *  customer's default as a fallback for a plan someone re-pointed in the Stripe dashboard. Either
 *  may come back as a bare id when we didn't expand it — then we simply have no card to show, which
 *  is honest, rather than printing an id at the admin. */
function planCard(sub: Stripe.Subscription, customer?: Stripe.Customer): { cardBrand: string; cardLast4: string } {
  const onSub = sub.default_payment_method && typeof sub.default_payment_method !== 'string' ? sub.default_payment_method : undefined;
  const custDefault = customer?.invoice_settings?.default_payment_method;
  const onCust = custDefault && typeof custDefault !== 'string' ? custDefault : undefined;
  const card = (onSub ?? onCust)?.card;
  return { cardBrand: card?.brand ?? '', cardLast4: card?.last4 ?? '' };
}

function toPlan(sub: Stripe.Subscription, tally?: PaidTally): StripePlan {
  const cust = typeof sub.customer === 'string' ? undefined : sub.customer;
  // A deleted customer keeps only its id — the same guard [retrieveLocation] uses.
  const live = cust && !(cust as { deleted?: boolean }).deleted ? (cust as Stripe.Customer) : undefined;
  const recurring = sub.items.data[0]?.price?.recurring;
  // Sum the items rather than reading the first one. A kiosk plan is always a single £X/month line,
  // but one an admin later edited in the dashboard must not display as a fraction of what the donor
  // is really giving each month.
  const amountMinor = sub.items.data.reduce((sum, it) => sum + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
  const paused = !!sub.pause_collection;
  // Nothing to promise when the plan is over, paused, or already set to stop at the end of the
  // period it's in: Stripe raises no renewal invoice in any of those cases, so a date here would be
  // a charge date the donor never sees.
  const finished = sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.status === 'paused';
  const metadata = (sub.metadata ?? {}) as Record<string, string>;
  const card = planCard(sub, live);
  // A scheduled end that falls on or before the next renewal cancels the plan at that instant, so
  // that renewal never happens. Printing it as the next charge would put an end date and a charge
  // date for the same day side by side, one of which is a fiction.
  const endsBeforeNext = sub.cancel_at !== null && sub.cancel_at <= sub.current_period_end;
  const nextCharge = finished || paused || sub.cancel_at_period_end || endsBeforeNext ? '' : isoOrEmpty(sub.current_period_end);
  return {
    id: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    donorName: live?.name ?? '',
    donorEmail: live?.email ?? '',
    amountMinor,
    currency: sub.currency.toUpperCase(),
    interval: recurring?.interval ?? '',
    intervalCount: recurring?.interval_count ?? 1,
    totalMinor: tally?.minor ?? 0,
    startedAt: isoOrEmpty(sub.start_date),
    lastChargeAt: isoOrEmpty(tally?.lastSec),
    nextChargeAt: nextCharge,
    cardBrand: card.cardBrand,
    cardLast4: card.cardLast4,
    status: sub.status,
    paused,
    cancelAt: isoOrEmpty(sub.cancel_at),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    deviceId: metadata.deviceId || '',
    campaignId: metadata.campaignId || '',
    campaignTitle: metadata.campaign || '',
  };
}

/** When money actually moved. `paid_at` for a paid invoice, falling back to when it was raised — for
 *  an auto-charged subscription invoice they are the same moment anyway. */
function paidAt(inv: Stripe.Invoice): number {
  return inv.status_transitions?.paid_at ?? inv.created;
}

/** Exact paid total for ONE plan. Cheap on its own (a page or two) and not subject to the
 *  account-wide cap the list view has to live with. */
async function paidTally(c: Stripe, subscriptionId: string): Promise<PaidTally> {
  const invoices = await c.invoices
    .list({ subscription: subscriptionId, status: 'paid', limit: 100 })
    .autoPagingToArray({ limit: PLAN_TOTAL_INVOICE_CAP });
  const tally: PaidTally = { minor: 0, lastSec: 0 };
  for (const inv of invoices) {
    tally.minor += inv.amount_paid;
    tally.lastSec = Math.max(tally.lastSec, paidAt(inv));
  }
  return tally;
}

/**
 * Every recurring donation the kiosk set up on this account, newest first.
 *
 * Only subscriptions the kiosk created come back. The masjid's Stripe account may equally hold the
 * Donations app's subscriptions, another OpenMasjid app's, or the masjid's own bills — listing those
 * on our Recurring screen would be wrong, and showing their donors' names is not ours to do.
 */
export async function listPlans(secretKey: string, opts?: { limit?: number }): Promise<{ plans: StripePlan[]; truncated: boolean; totalsCapped: boolean }> {
  const c = client(secretKey);
  const limit = clampLimit(opts?.limit, PLAN_LIST_DEFAULT, PLAN_LIST_MAX);
  const subs = await c.subscriptions
    // Shallow expands only here: the customer's fallback card would be a fourth level under `data.`,
    // right on Stripe's limit, and a rejected expand would take the whole screen down for a card we
    // only ever need when someone re-pointed a plan by hand. The detail view fetches it properly.
    .list({ status: 'all', limit: 100, expand: ['data.customer', 'data.default_payment_method'] })
    .autoPagingToArray({ limit });
  // Stripe can't filter subscriptions by metadata, so the kiosk's plans are found by scanning the
  // account and filtering here. On an account shared with other apps that scan can fill up entirely
  // with subscriptions that aren't ours — and a screen that then shows nothing, cheerfully, would
  // read as 'every donor cancelled'. Say when the scan was full so the caller can warn.
  const truncated = subs.length >= limit;
  const ours = subs.filter((s) => ((s.metadata ?? {}) as Record<string, string>).app === 'kiosk');
  if (!ours.length) return { plans: [], truncated, totalsCapped: false };
  // Totals need paid invoices, which the subscription list can't aggregate. Asking per subscription
  // would be one round trip per plan — a hundred plans, a hundred requests, a screen that crawls and
  // a rate limit we'd have earned. So we walk the account's paid invoices ONCE (a handful of pages)
  // and bucket them by subscription id. Anything the cap clipped off the oldest end is re-totalled
  // exactly, from that plan's own invoices, the moment an admin opens it ([retrievePlan]).
  const tallies = new Map<string, PaidTally>();
  const invoices = await c.invoices.list({ status: 'paid', limit: 100 }).autoPagingToArray({ limit: PLAN_INVOICE_SCAN_CAP });
  for (const inv of invoices) {
    const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
    if (!subId) continue;
    const tally = tallies.get(subId) ?? { minor: 0, lastSec: 0 };
    tally.minor += inv.amount_paid;
    tally.lastSec = Math.max(tally.lastSec, paidAt(inv));
    tallies.set(subId, tally);
  }
  // Same honesty for the totals: a full invoice scan means the oldest ones fell off the end, so
  // every total here is a floor rather than a figure. The detail view re-totals exactly.
  const totalsCapped = invoices.length >= PLAN_INVOICE_SCAN_CAP;
  const plans = ours.map((s) => toPlan(s, tallies.get(s.id))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { plans, truncated, totalsCapped };
}

/** One plan in full, or null when Stripe has never heard of it (or it isn't ours). A plan that has
 *  simply gone is a 404 for the admin; anything else — a bad key, Stripe unreachable — is thrown, so
 *  the caller can tell "deleted" from "we couldn't ask" and say so honestly. */
export async function retrievePlan(
  secretKey: string,
  subscriptionId: string,
  opts?: { ownedLocally?: boolean },
): Promise<StripePlan | null> {
  assertSubscriptionId(subscriptionId);
  const c = client(secretKey);
  let sub: Stripe.Subscription | null = null;
  try {
    sub = await c.subscriptions.retrieve(subscriptionId, { expand: PLAN_EXPAND });
  } catch (err) {
    // Only a genuinely missing object is a null. StripeInvalidRequestError also covers a rejected
    // expand and a restricted key without subscription read — and looksLikeSecret accepts rk_ keys,
    // so swallowing those would report every plan as 'not found' and hide a key problem for good.
    if ((err as { code?: string }).code !== 'resource_missing') throw err;
  }
  if (!sub) return null;
  // The metadata tag is how we DISCOVER our plans when scanning an account we may share with other
  // apps — it is a discovery filter, not the definition of ownership. When the caller already holds a
  // local `plans` row for this id, that row is the stronger proof: we wrote it when we created the
  // subscription. Gating those on metadata too meant a plan created before the tag existed (added in
  // v0.10.0 with the Recurring screen), or one whose metadata was edited in the dashboard, was
  // invisible AND uncancellable — the screen said "no recurring plans" while Stripe kept billing.
  if (!opts?.ownedLocally && ((sub.metadata ?? {}) as Record<string, string>).app !== 'kiosk') return null;
  return toPlan(sub, await paidTally(c, sub.id));
}

/** The words to show an admin when a renewal didn't go through. Stripe scatters them: a decline the
 *  issuer explained lands on the charge, one that never got as far as a charge lands on the
 *  PaymentIntent. If all that's left is a bare code we spell it out — `card_declined` is a code, not
 *  an explanation, and an admin ringing a donor about it deserves a sentence. */
function invoiceFailureReason(inv: Stripe.Invoice): string {
  if (inv.paid) return '';
  const pi = inv.payment_intent && typeof inv.payment_intent !== 'string' ? inv.payment_intent : undefined;
  const charge = inv.charge && typeof inv.charge !== 'string' ? inv.charge : undefined;
  const err = pi?.last_payment_error;
  const words = err?.message || charge?.failure_message || charge?.outcome?.seller_message || '';
  if (words) return words;
  const code = err?.decline_code || err?.code || charge?.failure_code || '';
  if (!code) return '';
  const spelt = code.replace(/_/g, ' ');
  return spelt.charAt(0).toUpperCase() + spelt.slice(1) + '.';
}

function toInvoiceRow(inv: Stripe.Invoice): PlanInvoiceRow {
  return {
    id: inv.id,
    date: isoOrEmpty(inv.created),
    // What was actually collected when it was paid; what is being asked for when it wasn't. A draft
    // has no amount_due until it's finalised, hence the total as a last resort.
    amountMinor: inv.paid ? inv.amount_paid : inv.amount_due || inv.total,
    currency: inv.currency.toUpperCase(),
    status: inv.status ?? '',
    paid: inv.paid,
    attempts: inv.attempt_count,
    failureReason: invoiceFailureReason(inv),
    hostedUrl: inv.hosted_invoice_url ?? '',
  };
}

/** A plan's giving history, newest first — the successful months and, more usefully, the ones that
 *  failed and why. */
export async function listPlanInvoices(secretKey: string, subscriptionId: string, limit?: number): Promise<PlanInvoiceRow[]> {
  assertSubscriptionId(subscriptionId);
  const res = await client(secretKey).invoices.list({
    subscription: subscriptionId,
    // Two years of monthly giving by default — enough history to see a pattern of failures without
    // making the admin wait on pages nobody scrolls to.
    limit: clampLimit(limit, 24, 100),
    // Both, because the reason for a failure lives in whichever object got far enough to try: an
    // invoice that never produced a charge only has the PaymentIntent's last_payment_error.
    expand: ['data.payment_intent', 'data.charge'],
  });
  return res.data.map(toInvoiceRow);
}

/** Fetch a subscription and refuse to touch anything the kiosk didn't create. These writes stop a
 *  real person's standing order, and the account may well hold the masjid's own subscriptions — an
 *  id that arrived by hand must never be able to cancel one of those from our screens. */
async function requireKioskSubscription(c: Stripe, id: string): Promise<Stripe.Subscription> {
  assertSubscriptionId(id);
  const sub = await c.subscriptions.retrieve(id, { expand: PLAN_EXPAND });
  if (((sub.metadata ?? {}) as Record<string, string>).app !== 'kiosk') {
    throw new Error('That subscription wasn’t set up by the kiosk.');
  }
  return sub;
}

/** Re-total after a write so the row the screen swaps in doesn't briefly show a plan with nothing
 *  ever given to it. */
async function planAfterWrite(c: Stripe, sub: Stripe.Subscription): Promise<StripePlan> {
  return toPlan(sub, await paidTally(c, sub.id));
}

/** End a recurring donation. `immediately` stops it now; otherwise it runs to the end of the period
 *  the donor has already paid for — the kind thing to do with a gift already given, and what the
 *  admin screen offers by default. */
export async function cancelPlan(secretKey: string, id: string, immediately: boolean): Promise<StripePlan> {
  const c = client(secretKey);
  const sub = await requireKioskSubscription(c, id);
  // Stripe (rightly) refuses to cancel the same subscription twice, but a double-clicked button
  // shouldn't read as a failure when the admin's intent is already true.
  if (sub.status === 'canceled') return planAfterWrite(c, sub);
  const updated = immediately
    ? await c.subscriptions.cancel(sub.id, { expand: PLAN_EXPAND })
    : // Clear any scheduled `cancel_at` at the same time. The two fields are competing answers to
      // "when does this stop?", and the far-future one wins: an admin who once set "end after 12
      // more charges" and later asks to stop at the end of this month would otherwise keep the
      // donor paying for a year, with the screen showing the cancellation they asked for.
      await c.subscriptions.update(sub.id, { cancel_at: '', cancel_at_period_end: true, expand: PLAN_EXPAND });
  return planAfterWrite(c, updated);
}

/** Pause or resume collection. 'void' is the only honest behaviour for a masjid: the paused months
 *  are never billed at all. The alternatives quietly stack up invoices that all land on the donor
 *  the moment collection resumes, which is not what anyone means by "pause my donation".
 *  pause_collection leaves the subscription's status alone (it does NOT become `paused`), so
 *  resuming is simply clearing it — subscriptions.resume answers a different kind of pause. */
export async function pausePlan(secretKey: string, id: string, paused: boolean): Promise<StripePlan> {
  const c = client(secretKey);
  const sub = await requireKioskSubscription(c, id);
  // Stripe refuses any update to a dead subscription, which would surface as the route's generic
  // "try again" — advice that can never work. Say the true thing instead.
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') throw new Error('That plan has already ended.');
  const updated = await c.subscriptions.update(sub.id, {
    pause_collection: paused ? { behavior: 'void' } : '',
    expand: PLAN_EXPAND,
  });
  return planAfterWrite(c, updated);
}

/** Add whole billing intervals to an epoch second the way a billing cycle does — same day of the
 *  month, clamped, so a plan that renews on the 31st doesn't skid past February into March.
 *
 *  All UTC. The date this produces decides whether a donor's last payment happens at all, and the
 *  instant it is compared against (Stripe's `current_period_end`) is UTC — so doing the month
 *  arithmetic in the server's local time would make the answer depend on the container's TZ, and a
 *  month-end plan could land a day out on one machine and not another. */
export function addIntervals(fromSec: number, interval: string, count: number): number {
  if (count <= 0) return fromSec;
  const d = new Date(fromSec * 1000);
  if (interval === 'day') {
    d.setUTCDate(d.getUTCDate() + count);
  } else if (interval === 'week') {
    d.setUTCDate(d.getUTCDate() + 7 * count);
  } else {
    const months = interval === 'year' ? 12 * count : count;
    const day = d.getUTCDate();
    // Park on the 1st before shifting the month, or a 31st would roll itself forward on the way.
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  }
  return Math.floor(d.getTime() / 1000);
}

/** When a plan should stop so that exactly [charges] MORE payments are taken.
 *
 *  The next payment falls at [currentPeriodEndSec] (call it T0), and the ones after it every
 *  interval from there — so payment N happens at T0+(N-1). The date returned is the boundary AFTER
 *  that, T0+N, because a cancel_at landing exactly on a renewal makes Stripe cancel INSTEAD of
 *  charging: ending on payment N's own boundary collects N-1, and "one more payment" collects
 *  nothing at all. Landing on a boundary also leaves no part-period to prorate. Pure, and covered by
 *  tests, so the off-by-one this replaced stays fixed. */
export function scheduledEndSec(currentPeriodEndSec: number, interval: string, intervalCount: number, charges: number): number {
  return addIntervals(currentPeriodEndSec, interval, Math.max(1, intervalCount) * charges);
}

/**
 * Give a plan an end date, or take one away.
 *
 * `endAt` is a moment (epoch seconds) to stop at. `charges` says it the way an admin thinks of it —
 * "stop after N more charges" — and we turn that into the same kind of date: the plan's current
 * period end plus N-1 further intervals, i.e. the moment the Nth of those charges falls due, which
 * is where the plan then ends. Passing neither clears any scheduled end and lets the donation carry
 * on. Passing both is a caller error rather than a guess about which one was meant.
 */
export async function schedulePlanEnd(
  secretKey: string,
  id: string,
  opts: { endAt?: number | null; charges?: number | null },
): Promise<StripePlan> {
  const endAt = opts.endAt ?? null;
  const charges = opts.charges ?? null;
  if (endAt !== null && charges !== null) throw new Error('Choose either an end date or a number of charges, not both.');
  const c = client(secretKey);
  const sub = await requireKioskSubscription(c, id);
  let cancelAt: number | null = null;
  if (endAt !== null) {
    // Stripe rejects a cancel_at in the past, and so should we — with words the admin can act on
    // rather than whatever Stripe's validator says.
    if (!Number.isFinite(endAt) || endAt * 1000 <= Date.now()) throw new Error('That end date has already passed.');
    cancelAt = Math.floor(endAt);
  } else if (charges !== null) {
    if (!Number.isInteger(charges) || charges < 1 || charges > MAX_SCHEDULED_CHARGES) {
      throw new Error(`Choose between 1 and ${MAX_SCHEDULED_CHARGES} more charges.`);
    }
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') throw new Error('That plan has already ended.');
    const recurring = sub.items.data[0]?.price?.recurring;
    // N MORE charges means the boundary AFTER the Nth, not the boundary the Nth falls on.
    //
    // The next charge is raised AT `current_period_end` (call it T0), and the ones after it at
    // T0+1 interval, T0+2… So charge N happens at T0+(N-1). Cancelling AT that instant is the one
    // thing that must not happen: Stripe treats a `cancel_at` landing exactly on a renewal like
    // `cancel_at_period_end` and raises no invoice — so "stop after 1 more charge" would collect
    // nothing at all, and every other N would be one short. Multiplying by N lands the cancel on
    // the boundary immediately after charge N: exactly N collected, and on a period boundary, so
    // there is nothing to prorate.
    cancelAt = scheduledEndSec(sub.current_period_end, recurring?.interval ?? 'month', recurring?.interval_count ?? 1, charges);
    // A past-due plan Stripe is still retrying has a period end behind us, so the sum lands in the
    // past and Stripe refuses it. Say what's actually wrong rather than passing on a validator.
    if (cancelAt * 1000 <= Date.now()) throw new Error('This plan’s next charge is overdue — sort that out, or end it now instead.');
  }
  // Clearing takes both fields: cancel_at_period_end is its own way of saying "stop", so leaving it
  // set would keep the plan ending even with the date wiped. Setting a date sends only the date —
  // Stripe reads the two as competing answers to the same question.
  // `proration_behavior: 'none'` matters on the setting path: Stripe's default is to prorate an
  // end date that falls mid-period, which would raise a credit line against the donor for the
  // "unused" part of a month they meant to give. A donation has no unused time to refund.
  const ending: Stripe.SubscriptionUpdateParams =
    cancelAt === null
      ? { cancel_at: '', cancel_at_period_end: false }
      : { cancel_at: cancelAt, proration_behavior: 'none' };
  const updated = await c.subscriptions.update(sub.id, { ...ending, expand: PLAN_EXPAND });
  return planAfterWrite(c, updated);
}
