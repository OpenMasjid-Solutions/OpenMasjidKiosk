// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// WHAT THE ADMIN API SAYS WHEN SOMETHING IS WRONG.
//
// The reader is a masjid volunteer, not a sysadmin (app UI spec §9), so every answer says what
// happened and what to do next, and nothing raw — no Stripe message, no zod path, no "300s" — is the
// sentence itself. These are the replies that used to break that rule, pinned so they stay fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  CAMPAIGN_FIELD_WORDS,
  GIVING_FIELD_WORDS,
  MASJID_FIELD_WORDS,
  issueSentence,
  refundFailure,
  sampleReceiptContext,
  tooManyTries,
  waitWords,
} from './replies';
import { renderReceipt } from './email';
import { formatDateTime } from './dates';
import { formatMoney } from './money';

test('a lock-out wait is said in minutes, never "Try again in 300s"', () => {
  assert.equal(waitWords(2_000), 'a minute', 'a first backoff of two seconds');
  assert.equal(waitWords(60_000), 'a minute');
  assert.equal(waitWords(60_001), '2 minutes', 'rounded UP — never tell someone to wait less than they must');
  assert.equal(waitWords(5 * 60_000), '5 minutes', 'the limiter’s cap');
  assert.equal(waitWords(0), 'a minute');
  assert.equal(tooManyTries(300_000), 'Too many tries. Please wait 5 minutes and try again.');
  assert.ok(!/\d+s\b/.test(tooManyTries(300_000)));
});

test('a refused refund is words, says no money moved, and carries Stripe’s text only as detail', () => {
  const stripeError = (code: string, type = 'StripeInvalidRequestError', message = `Charge ch_3P123 ${code}.`) =>
    Object.assign(new Error(message), { code, type });

  const already = refundFailure(stripeError('charge_already_refunded', 'StripeInvalidRequestError', 'Charge ch_3P123 has already been refunded.'));
  assert.match(already.error, /already refunded/);
  assert.match(already.error, /Refresh/, 'a next step that exists');
  assert.equal(already.detail, 'Charge ch_3P123 has already been refunded.', 'the raw text survives for Technical details');
  assert.ok(!already.error.includes('ch_3P123'), 'but never in the main line');

  assert.match(refundFailure(stripeError('balance_insufficient')).error, /no money has moved/);
  assert.match(refundFailure(stripeError('charge_disputed')).error, /disput/);
  assert.match(refundFailure(stripeError('amount_too_large')).error, /more than is left/);

  const offline = refundFailure(Object.assign(new Error('An error occurred with our connection to Stripe. Request was retried 2 times.'), { type: 'StripeConnectionError' }));
  assert.match(offline.error, /couldn’t reach Stripe, so nothing was refunded/);
  assert.match(offline.detail, /retried 2 times/);

  const keys = refundFailure(Object.assign(new Error('Invalid API Key provided: sk_live_****'), { type: 'StripeAuthenticationError' }));
  assert.match(keys.error, /Settings → Payments/);
  assert.ok(!keys.error.includes('sk_'), 'nothing key-shaped in the sentence');

  // Anything else is still a HARD error that says no money moved — a refund the admin believes
  // happened but didn't is how a donor is told they were repaid and then isn't.
  for (const e of [new Error('something new'), 'a string', null, { code: 'resource_missing' }]) {
    const r = refundFailure(e);
    assert.match(r.error, /no money has moved/, String(e));
  }
  assert.ok(refundFailure(new Error('x'.repeat(1000))).detail.length <= 300, 'detail is bounded');
});

test('a refused campaign names the field — the long image address is the case that was reachable', () => {
  // The same caps as CampaignBody in index.ts, for the fields that matter here.
  const Campaign = z
    .object({
      title: z.string().max(120).optional(),
      backgroundImage: z.string().max(500).optional(),
      logo: z.string().max(500).optional(),
      presetsMinor: z.array(z.number().int().positive()).max(12).optional(),
      theme: z.enum(['auto', 'light', 'dark']).optional(),
    })
    .strict();
  const say = (body: unknown) => {
    const r = Campaign.safeParse(body);
    assert.equal(r.success, false);
    return issueSentence((r as { error: z.ZodError }).error, CAMPAIGN_FIELD_WORDS, 'fallback');
  };
  assert.equal(say({ backgroundImage: 'https://x/' + 'a'.repeat(600) }), 'That image address is too long — use Upload instead.');
  assert.equal(say({ logo: 'x'.repeat(501) }), 'That image address is too long — use Upload instead.');
  assert.match(say({ title: 't'.repeat(121) }), /120 characters/);
  assert.match(say({ presetsMinor: [500, -1] }), /more than zero/, 'a nested path finds its field');
  assert.match(say({ theme: 'neon' }), /Auto, Bright or Dark/);
  assert.equal(say({ somethingNew: 1 }), 'This page is out of date. Reload it and try again.', 'a page older than the server');
  // Never the zod wording, never a path.
  for (const s of [say({ title: 1 }), say({ logo: 'x'.repeat(501) })]) {
    assert.ok(!/Expected|String must|invalid_type|\bpath\b/i.test(s), s);
  }
});

test('masjid details: a nested field wins over its group, and the clock fields have their own words', () => {
  const Masjid = z.object({
    address: z.object({ line1: z.string().max(200).optional(), country: z.string().max(2).optional() }).optional(),
    timeZone: z.string().refine((tz) => tz === '' || tz === 'Europe/London').optional(),
    hijriOffset: z.number().int().min(-3).max(3).optional(),
  });
  const say = (body: unknown) => {
    const r = Masjid.safeParse(body);
    assert.equal(r.success, false);
    return issueSentence((r as { error: z.ZodError }).error, MASJID_FIELD_WORDS, 'fallback');
  };
  assert.match(say({ address: { country: 'GBR' } }), /2-letter country code/);
  assert.match(say({ address: { line1: 'x'.repeat(201) } }), /Part of the address/);
  assert.match(say({ timeZone: 'Mars/Olympus' }), /time zone/);
  assert.match(say({ hijriOffset: 5 }), /−3 to \+3/);
  assert.match(say({ hijriOffset: 1.5 }), /−3 to \+3/);
});

test('an unlisted field falls back to the caller’s sentence, and every giving field has words', () => {
  const r = z.object({ mystery: z.string() }).safeParse({ mystery: 1 });
  assert.equal(issueSentence((r as { error: z.ZodError }).error, GIVING_FIELD_WORDS, 'We couldn’t save that.'), 'We couldn’t save that.');
  for (const [k, v] of Object.entries({ ...CAMPAIGN_FIELD_WORDS, ...GIVING_FIELD_WORDS, ...MASJID_FIELD_WORDS })) {
    assert.ok(v.endsWith('.'), `${k} is a full sentence`);
    assert.ok(!/[a-z][A-Z]|_/.test(v.replace(/OpenMasjidOS/g, '')), `${k} names no internal identifier: ${v}`);
  }
});

test('a sample receipt is plainly a sample, in the masjid’s currency at its own scale', () => {
  const clock = { timeZone: 'Europe/London', clock24h: false, hijriOffset: 0, locale: 'en-GB' };
  const money = (minor: number, c: string) => formatMoney(minor, c, clock.locale);
  const base = {
    masjidName: 'Masjid al-Nūr',
    masjidLogo: '',
    contactEmail: 'office@alnoor.example',
    contactPhone: '',
    contactWebsite: '',
    money,
    datePaid: formatDateTime('2026-09-30T18:03:11.123Z', clock),
  };
  const gbp = sampleReceiptContext({ ...base, currency: 'gbp' });
  assert.equal(gbp.amountText, '£50');
  // Fifty whole units, scaled by each currency's own decimals — not a fixed 5000 minor units.
  assert.equal(sampleReceiptContext({ ...base, currency: 'JPY' }).amountText, money(50, 'JPY'));
  assert.match(sampleReceiptContext({ ...base, currency: 'JPY' }).amountText, /50\b/);
  assert.match(sampleReceiptContext({ ...base, currency: 'KWD' }).amountText, /50/);
  assert.ok(!/5\.000|500/.test(sampleReceiptContext({ ...base, currency: 'KWD' }).amountText));

  // The masjid half is real; the donation half cannot be mistaken for a gift.
  assert.equal(gbp.masjidName, 'Masjid al-Nūr');
  assert.equal(gbp.contactEmail, 'office@alnoor.example');
  assert.equal(gbp.campaignTitle, 'General Fund');
  assert.match(gbp.name, /Sample/);
  assert.match(gbp.paymentMethod, /no card was charged/);
  assert.equal(gbp.reference, 'SAMPLE');

  const rendered = renderReceipt({ subject: '', heading: '', body: '', accent: '' }, gbp);
  assert.match(rendered.text, /£50/);
  assert.match(rendered.text, /no card was charged/);
  // The date on it is the masjid's words, not the ISO stamp every receipt used to carry.
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(rendered.text), 'no ISO timestamp');
  assert.match(rendered.text, /30 Sept 2026|Sep 30, 2026|30 Sep 2026/);
});
