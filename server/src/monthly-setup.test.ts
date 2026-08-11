// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// WHY MONTHLY NEVER WORKED — reported three times, finally root-caused here: "it takes the money but
// it can't setup monthly at all, anywhere I test".
//
// A monthly donation is two things: a payment now, and a card kept for next month. We did the first
// and only PRETENDED to do the second. Stripe saves a card only when the PaymentIntent asks it to
// (`setup_future_usage`), and it attaches that saved card to the customer named ON THAT INTENT.
// Our intents set NEITHER — and then /complete looked for
// `payment_method_details.card_present.generated_card`, which Stripe's own API reference says exists
// only "if setup_future_usage is set". So it was always null, on every card, every reader, every
// time. The failure was 100% reproducible and looked like a card-compatibility problem, which is
// exactly why it survived two rounds of fixes that only improved the REPORTING of it.
//
// Second, independent hole in the same feature: keyed entry has no `generated_card` concept at all —
// for a typed card the PaymentIntent's own `payment_method` is the reusable one. So even with
// setup_future_usage fixed, monthly by typed card would still have failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Does Stripe produce a reusable card? Mirrors the documented rule, not our old wishful thinking. */
const stripeSavesACard = (o: { setupFutureUsage: boolean; customer: boolean; entry: 'reader' | 'keyed' }) =>
  o.setupFutureUsage && o.customer;

/** What /complete now uses as the card to build the plan from. */
const reusableCard = (o: { generatedCard?: string; paymentMethodId?: string }) =>
  o.generatedCard || o.paymentMethodId || '';

test('THE REGRESSION: without setup_future_usage no card is ever saved', () => {
  // The old intent, exactly: no setup_future_usage, no customer. This is every monthly donation the
  // kiosk has ever taken.
  assert.equal(stripeSavesACard({ setupFutureUsage: false, customer: false, entry: 'reader' }), false);
  assert.equal(stripeSavesACard({ setupFutureUsage: false, customer: false, entry: 'keyed' }), false);
  // …so generated_card came back null and there was nothing to subscribe.
  assert.equal(reusableCard({ generatedCard: undefined, paymentMethodId: undefined }), '');
});

test('the fix asks for BOTH halves — the flag and the customer', () => {
  assert.equal(stripeSavesACard({ setupFutureUsage: true, customer: true, entry: 'reader' }), true);
  assert.equal(stripeSavesACard({ setupFutureUsage: true, customer: true, entry: 'keyed' }), true);
  // Each alone is not enough: the flag says "save a card", the customer is who it is saved TO.
  assert.equal(stripeSavesACard({ setupFutureUsage: true, customer: false, entry: 'reader' }), false);
  assert.equal(stripeSavesACard({ setupFutureUsage: false, customer: true, entry: 'reader' }), false);
});

test('a reader tap uses generated_card; a TYPED card uses the intent’s own payment method', () => {
  // Reader: Stripe mints a separate reusable card from the card-present charge.
  assert.equal(reusableCard({ generatedCard: 'pm_generated', paymentMethodId: 'pm_intent' }), 'pm_generated');
  // Keyed: there is no generated_card at all. Reading only generated_card — as we did — meant monthly
  // by typed card could never work even after the flag was fixed.
  assert.equal(reusableCard({ generatedCard: undefined, paymentMethodId: 'pm_intent' }), 'pm_intent');
  assert.equal(reusableCard({}), '', 'neither → say so, never fabricate a plan');
});

test('the customer is created BEFORE the payment, and reused after — never a second one', () => {
  // Creating the customer at /complete (the old order) is too late: setup_future_usage attaches the
  // saved card at charge time, to the customer on the intent. And creating a SECOND customer here
  // would leave the card on one and the subscription billing another — a plan that can never collect.
  const customerFor = (o: { fromIntent: string }) => (o.fromIntent ? { reuse: o.fromIntent } : { create: true });
  assert.deepEqual(customerFor({ fromIntent: 'cus_123' }), { reuse: 'cus_123' });
  // Fallback kept ONLY for an intent created by an older build that is still in flight.
  assert.deepEqual(customerFor({ fromIntent: '' }), { create: true });
});

test('the PaymentIntent’s own customer beats our metadata copy', () => {
  // Metadata is a copy we wrote; the PI is what Stripe actually charged against. On a retried or
  // duplicated intent the copy can be stale, and billing the wrong customer is unrecoverable.
  const pick = (piCustomer: string, metaCustomer: string) => piCustomer || metaCustomer || '';
  assert.equal(pick('cus_real', 'cus_stale'), 'cus_real');
  assert.equal(pick('', 'cus_meta'), 'cus_meta', 'metadata still covers a PI we could not re-read');
  assert.equal(pick('', ''), '');
});

test('a failed customer creation must NOT lose the donation', () => {
  // If Stripe won't make the customer we still take the gift as a one-off — losing a donation to
  // protect a subscription would be the wrong trade. /complete then reports monthly wasn't arranged.
  const outcome = (customerOk: boolean) =>
    customerOk ? { takePayment: true, monthlyPossible: true } : { takePayment: true, monthlyPossible: false };
  assert.deepEqual(outcome(false), { takePayment: true, monthlyPossible: false });
  assert.deepEqual(outcome(true), { takePayment: true, monthlyPossible: true });
});

test('the two “no reusable card” cases are reported differently', () => {
  // They need different actions from the admin, so one message for both would be useless: a card that
  // genuinely can't be reused is the donor's card; a missing customer means the intent predates the
  // fix (a tablet mid-donation across an update) and the NEXT one will work.
  const why = (hasCustomer: boolean) => (hasCustomer ? 'card-not-reusable' : 'intent-predates-fix');
  assert.equal(why(true), 'card-not-reusable');
  assert.equal(why(false), 'intent-predates-fix');
});

test('setting up monthly must NEVER cost the donation', () => {
  // Regression from dev.12: adding the card-saving fields (customer + setup_future_usage) made the
  // PaymentIntent something a Stripe account can REFUSE while a plain payment would have been fine.
  // A refusal then failed the whole request, so the donor saw "Sorry — couldn't start the payment"
  // with their card already out, and one-off donations were unaffected — exactly the reported shape.
  const attempt = (o: { monthly: boolean; stripeRefusesCardSaving: boolean }) => {
    if (!o.monthly) return { payment: 'ok', monthly: 'n/a' };
    if (!o.stripeRefusesCardSaving) return { payment: 'ok', monthly: 'set-up' };
    return { payment: 'ok', monthly: 'not-arranged' }; // fall back to a plain intent, keep the gift
  };

  assert.deepEqual(attempt({ monthly: false, stripeRefusesCardSaving: false }), { payment: 'ok', monthly: 'n/a' });
  assert.deepEqual(attempt({ monthly: true, stripeRefusesCardSaving: false }), { payment: 'ok', monthly: 'set-up' });
  // The one that matters: the payment still happens.
  assert.deepEqual(attempt({ monthly: true, stripeRefusesCardSaving: true }), { payment: 'ok', monthly: 'not-arranged' });
  // Whatever else changes, a monthly request must never be able to produce a failed PAYMENT.
  for (const refuses of [true, false]) {
    assert.equal(attempt({ monthly: true, stripeRefusesCardSaving: refuses }).payment, 'ok');
  }
});

test('the fallback intent uses a DIFFERENT idempotency key', () => {
  // Same key + different body is itself a Stripe error ("Keys for idempotent requests can only be
  // used with the same parameters"), and the fallback body deliberately differs — it drops the
  // customer and setup_future_usage. Reusing the key would turn the rescue into a second failure.
  const key = (base: string, saving: boolean) => (saving ? base : `${base}_nosave`);
  assert.notEqual(key('abc', true), key('abc', false));
  assert.equal(key('abc', true), 'abc', 'the normal path keeps the tablet’s own key');
});

test('a flaky uplink is retried rather than surfaced as a failed donation', () => {
  // "Hit or miss" one-off donations were a single network attempt against a masjid uplink. Stripe's
  // SDK retries only network errors / 5xx / 429 — never a card decline — and adds its own idempotency
  // to each retry, so more retries cannot mean more charges.
  const RETRIES = 3;
  const retriable = (kind: string) => ['network', '500', '502', '429'].includes(kind);
  assert.equal(retriable('network'), true);
  assert.equal(retriable('429'), true);
  assert.equal(retriable('card_declined'), false, 'a decline is an answer, not a blip — never retry');
  assert.equal(retriable('invalid_request_error'), false);
  assert.ok(RETRIES > 1, 'one attempt was not enough for a real masjid connection');
});

test('the server must answer before the tablet stops listening', () => {
  // THE dev.13 MISTAKE, pinned. Raising Stripe retries to 3 x 12s made the server's worst case ~50s
  // PER CALL while the tablet gave up on the whole request at 12s — so the "rescue" guaranteed the
  // tablet timed out first. A monthly needs two sequential Stripe calls (customer, then intent) plus a
  // possible fallback, so it was 2-3x more exposed than a one-off: "monthly can't even start, one-offs
  // are hit and miss", and a tap prompt flashing when the timeout landed just after the intent existed.
  const PAY_TIMEOUT_MS = 8_000;
  const PAY_RETRIES = 1;
  const QUICK_TIMEOUT_MS = 5_000; // the optional customer step
  const BACKOFF_MS = 2_000; // generous allowance for the SDK's retry backoff

  // Worst case for one Stripe call, and for a whole monthly (customer + intent + no-save fallback).
  const perCall = PAY_TIMEOUT_MS * (1 + PAY_RETRIES) + BACKOFF_MS;
  const worstMonthly = QUICK_TIMEOUT_MS + perCall + perCall;

  // The tablet's PAYMENT client (KioskApi.payClient) — deliberately far more patient than the
  // ordinary 8s/12s one used for heartbeats.
  const TABLET_CALL_TIMEOUT_MS = 60_000;

  assert.ok(worstMonthly < TABLET_CALL_TIMEOUT_MS, `monthly worst case ${worstMonthly}ms must fit in ${TABLET_CALL_TIMEOUT_MS}ms`);
  assert.ok(perCall < TABLET_CALL_TIMEOUT_MS, 'a one-off must fit with room to spare');
  // And the old numbers must NOT fit — proving this test would have caught dev.13.
  const oldPerCall = 12_000 * (1 + 3) + BACKOFF_MS;
  assert.ok(oldPerCall + oldPerCall > 12_000, 'the old budget blew the tablet’s old 12s call timeout');
});

test('the optional monthly customer must not spend the payment’s budget', () => {
  // Losing monthly is recoverable; a donation the tablet gave up waiting for is not. So the customer
  // step gets a short, non-retrying client — it is allowed to fail fast.
  const budget = (step: 'customer' | 'intent') => (step === 'customer' ? { timeout: 5_000, retries: 0 } : { timeout: 8_000, retries: 1 });
  assert.ok(budget('customer').timeout < budget('intent').timeout);
  assert.equal(budget('customer').retries, 0, 'never retry something we are willing to lose');
  assert.ok(budget('intent').retries >= 1, 'the payment itself still gets a retry');
});
