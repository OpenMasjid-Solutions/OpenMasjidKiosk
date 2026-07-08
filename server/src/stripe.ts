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
      // Mirror the proven OpenMasjidDonations pattern: let Stripe offer the account's enabled methods
      // (Cards, Link, …) but NEVER a redirect method — the kiosk can't handle a browser redirect, and
      // this keeps PaymentSheet to on-device forms. (Was explicit ['card'].)
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
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
  const cardPresent = charge?.payment_method_details?.card_present as { generated_card?: string | null } | undefined;
  return {
    status: pi.status,
    succeeded: pi.status === 'succeeded',
    amountMinor: pi.amount,
    currency: pi.currency.toUpperCase(),
    chargeId: charge?.id,
    generatedCard: cardPresent?.generated_card ?? undefined,
    receiptUrl: charge?.receipt_url ?? undefined,
    createdSec: pi.created,
    metadata: (pi.metadata ?? {}) as Record<string, string>,
  };
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
      metadata: { app: 'kiosk', deviceId: input.deviceId || '' },
    },
    idem ? { idempotencyKey: `${idem}_sub` } : undefined,
  );
  return { created: true, subscriptionId: sub.id, customerId: customer.id };
}
