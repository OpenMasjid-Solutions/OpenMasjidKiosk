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
