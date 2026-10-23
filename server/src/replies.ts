// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The sentences the admin API answers with when something is wrong — kept out of index.ts so they
 * can be tested, because index.ts starts a server the moment it is imported.
 *
 * The rule they all follow is the app UI spec's (§9): the reader is a masjid volunteer, often a
 * trustee doing this on a Sunday, not a sysadmin. So an answer says what happened and what to do
 * next, in one or two sentences, and the next step it names has to be one that really exists. Raw
 * text from Stripe or a framework never goes in the main line; where it could help someone, it
 * travels beside it as `detail`, which the panel shows only inside a "Technical details" disclosure.
 */
import type { ZodError } from 'zod';
import { currencyDecimals } from './stripe';
import type { ReceiptContext } from './email';

/**
 * "a minute" / "5 minutes", for a wait a person is asked to sit out.
 *
 * The limiters work in milliseconds and back off to five minutes, so the old
 * `Try again in ${Math.ceil(wait / 1000)}s` could read "Try again in 300s" — a number nobody
 * converts in their head at the moment they are locked out. Rounded UP to whole minutes: telling
 * someone to wait a minute and then refusing them at fifty seconds is worse than the reverse.
 */
export function waitWords(ms: number): string {
  const mins = Math.ceil(Math.max(0, ms) / 60_000);
  return mins <= 1 ? 'a minute' : `${mins} minutes`;
}

/** The shared sentence for any limiter that has run out. */
export function tooManyTries(ms: number): string {
  return `Too many tries. Please wait ${waitWords(ms)} and try again.`;
}

/**
 * A refund Stripe refused, in words — and the raw reason beside it.
 *
 * STAYS A HARD ERROR. A refund an admin believes happened but didn't is how a donor gets told they
 * have been repaid and then isn't, so every sentence here says plainly that no money moved. What
 * changed is only that Stripe's own message ("Charge ch_3P… has already been refunded.", a
 * connection-retry notice) is no longer the sentence itself: it goes in `detail`, for the
 * "Technical details" disclosure and for anyone on the phone to Stripe support.
 *
 * Keyed on Stripe's error CODE first (the stable part), then its TYPE (the class of failure).
 */
export function refundFailure(e: unknown): { error: string; detail: string } {
  const err = (e ?? {}) as { code?: unknown; type?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  const type = typeof err.type === 'string' ? err.type : '';
  const detail = (typeof err.message === 'string' ? err.message : e instanceof Error ? e.message : String(e ?? '')).slice(0, 300);
  const error = ((): string => {
    switch (code) {
      case 'charge_already_refunded':
        return 'Stripe says this donation was already refunded, so nothing more was taken back. Refresh the page to see it.';
      case 'balance_insufficient':
        return 'Your Stripe balance is too low to refund this right now, so no money has moved. Add funds in the Stripe dashboard, or try again after your next payout.';
      case 'charge_disputed':
        return 'The donor’s bank is disputing this donation, so Stripe won’t refund it and no money has moved. You can see the dispute in the Stripe dashboard.';
      case 'amount_too_large':
        return 'Stripe says that’s more than is left to refund, so no money has moved. Refresh the page and try a smaller amount.';
    }
    switch (type) {
      case 'StripeConnectionError':
      case 'StripeAPIError':
        return 'We couldn’t reach Stripe, so nothing was refunded. Try again in a minute.';
      case 'StripeRateLimitError':
        return 'Stripe asked us to slow down, so nothing was refunded. Try again in a minute.';
      case 'StripeAuthenticationError':
      case 'StripePermissionError':
        return 'Stripe didn’t accept this app’s keys, so nothing was refunded. Check the Stripe account in Settings → Payments.';
    }
    return 'Stripe didn’t refund this donation, so no money has moved. Try again, or check the Stripe dashboard.';
  })();
  return { error, detail };
}

/** What each field of a form means to the person filling it in, when zod refuses it. */
export type FieldWords = Record<string, string>;

/**
 * A zod refusal as ONE sentence about the field that caused it.
 *
 * "Please check the campaign settings." named nothing — and it was reachable from ordinary use:
 * pasting a long image address into a campaign's image box tripped a 500-character cap and the
 * admin was told to check everything. The first issue is enough: the panel fixes one thing at a
 * time, and a list of every problem is the "Invalid input at field 3" the spec gives as the thing
 * not to do.
 *
 * Nested paths are tried most-specific first ("address.country", then "address"), so one entry can
 * cover a whole group while another singles out the field in it that has its own rule.
 */
export function issueSentence(error: ZodError, words: FieldWords, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  // `.strict()` refuses a key it does not know. From our own panel that only happens when the page
  // predates the server it is talking to — a tab left open across an update.
  if (issue.code === 'unrecognized_keys') return 'This page is out of date. Reload it and try again.';
  const path = issue.path.map(String);
  for (let n = path.length; n > 0; n--) {
    const hit = words[path.slice(0, n).join('.')];
    if (hit) return hit;
  }
  return fallback;
}

const IMAGE_TOO_LONG = 'That image address is too long — use Upload instead.';
const AMOUNTS = 'Each amount must be a whole number more than zero.';
const COLOR = 'That color isn’t valid — pick one with the color picker.';
const SWITCH = 'One of the switches didn’t save. Reload the page and try again.';

/** Campaign editor (POST/PUT /api/admin/campaigns). The caps are CampaignBody's, in index.ts. */
export const CAMPAIGN_FIELD_WORDS: FieldWords = {
  title: 'Keep the campaign title under 120 characters.',
  type: 'Choose Donation, Zakat or Tuition for this campaign.',
  description: 'Keep the description under 1,000 characters.',
  deviceIds: 'One of the chosen kiosks wasn’t recognized. Reload the page and choose them again.',
  primaryColor: COLOR,
  accentColor: COLOR,
  backgroundImage: IMAGE_TOO_LONG,
  coverImage: IMAGE_TOO_LONG,
  logo: IMAGE_TOO_LONG,
  presetsMinor: 'Each suggested amount must be a whole number more than zero.',
  customMinMinor: 'The smallest amount a donor can type must be more than zero.',
  customMaxMinor: 'The largest amount a donor can type must be more than zero.',
  thankYouMessage: 'Keep the thank-you message under 500 characters.',
  theme: 'Choose Auto, Bright or Dark for the campaign’s appearance.',
  stripeAccountId: 'That Stripe account isn’t available any more. Reload the page and choose it again.',
  allowCustom: SWITCH,
  monthlyEnabled: SWITCH,
  coverFees: SWITCH,
  forceCoverFees: SWITCH,
  live: SWITCH,
};

/** Kiosk-wide giving settings (PUT /api/admin/giving). The caps are GivingBody's, in index.ts. */
export const GIVING_FIELD_WORDS: FieldWords = {
  presetsMinor: 'Each suggested amount must be a whole number more than zero.',
  customMinMinor: 'The smallest amount a donor can type must be more than zero.',
  customMaxMinor: 'The largest amount a donor can type must be more than zero.',
  namePolicy: 'Choose Off, Optional or Required for asking the donor’s name.',
  emailPolicy: 'Choose Off, Optional or Required for asking the donor’s email.',
  thankYouMessage: 'Keep the thank-you message under 500 characters.',
  footerText: 'Keep the footer text under 80 characters.',
  tabSize: 'Choose one of the listed sizes for the campaign tabs.',
  largeAmountThresholdMinor: AMOUNTS,
  largeAmountNote: 'Keep the large-donation note under 600 characters.',
  largeAmountImage: IMAGE_TOO_LONG,
  celebrateThresholdMinor: AMOUNTS,
  masjidName: 'Keep the masjid name under 160 characters.',
  allowCustom: SWITCH,
  monthlyEnabled: SWITCH,
  manualEntryEnabled: SWITCH,
  maxBrightness: SWITCH,
  celebrateEnabled: SWITCH,
};

/** Masjid details (PUT /api/admin/masjid). */
export const MASJID_FIELD_WORDS: FieldWords = {
  name: 'Keep the masjid name under 160 characters.',
  address: 'Part of the address is too long. Shorten it and try again.',
  'address.country': 'Use the 2-letter country code, for example US or GB.',
  logo: 'That logo address is too long — use Upload instead.',
  email: 'Keep the contact email under 200 characters.',
  phone: 'Keep the contact phone number under 60 characters.',
  website: 'Keep the website address under 200 characters.',
  timeZone: 'That time zone isn’t one we recognize. Choose it from the list.',
  clock24h: 'Choose a 12-hour or a 24-hour clock.',
  hijriOffset: 'The Hijri date can be moved by up to 3 days either way. Choose a number from −3 to +3.',
};

/**
 * The made-up donation a sample receipt is rendered with.
 *
 * Everything about the MASJID is real — its name, logo and contact line — because that is what the
 * admin is checking. Everything about the DONATION is plainly a sample, so a copy forwarded to a
 * committee, or found in a mailbox a year later, can never be mistaken for a real gift: the donor is
 * "Sample donor", the card line says no card was charged, and the reference reads SAMPLE.
 *
 * The amount is fifty whole units of the masjid's own currency, scaled by ITS decimals — ¥50 and
 * 50.000 KWD, not the ¥5,000 and 5.000 KWD that a fixed 5000 minor units would print.
 */
export function sampleReceiptContext(input: {
  masjidName: string;
  masjidLogo: string;
  contactEmail: string;
  contactPhone: string;
  contactWebsite: string;
  currency: string;
  money: (minor: number, currency: string) => string;
  datePaid: string;
}): ReceiptContext {
  const currency = (input.currency || 'USD').toUpperCase();
  return {
    name: 'Sample donor',
    amountText: input.money(50 * 10 ** currencyDecimals(currency), currency),
    campaignTitle: 'General Fund',
    masjidName: input.masjidName,
    masjidLogo: input.masjidLogo,
    datePaid: input.datePaid,
    paymentMethod: 'Sample donation — no card was charged',
    reference: 'SAMPLE',
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    contactWebsite: input.contactWebsite,
  };
}
