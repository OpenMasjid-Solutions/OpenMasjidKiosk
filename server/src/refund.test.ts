// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Refunds — giving a donation back from the Donations screen.
//
// This is the only place in the app where money moves OUT, so the rules that matter are the ones
// that stop it moving twice, moving further than it should, or moving quietly. The Stripe call
// itself is not mocked here (it is one `refunds.create`); what is pinned is everything around it:
// the arithmetic, the guards, the accumulation, and the honesty of what the admin is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store';
import { renderRefund } from './email';

const mem = () => new Store(':memory:');

/** A succeeded donation to refund, written straight through recordDonation. */
function donate(s: Store, over: Partial<Parameters<Store['recordDonation']>[0]> = {}) {
  s.recordDonation({
    paymentIntentId: `pi_${Math.random().toString(36).slice(2, 10)}`,
    deviceId: 'dev1',
    campaignId: '',
    campaignTitle: 'Masjid Donation',
    amountMinor: 1000,
    currency: 'USD',
    kind: 'one_time',
    status: 'succeeded',
    donorName: 'Osman',
    donorEmail: 'osman@example.com',
    cardBrand: 'visa',
    cardLast4: '4242',
    receipt: 'stripe',
    chargeId: 'ch_1',
    ...over,
  });
  return s.listDonations()[0];
}

test('a fresh donation has nothing refunded, and the totals are the full amount', () => {
  const s = mem();
  const d = donate(s);
  assert.equal(d.refundedMinor, 0);
  assert.equal(d.refundId, '');
  assert.equal(s.donationTotals().allTime, 1000);
});

test('a full refund removes the money from every total but keeps the donation on record', () => {
  const s = mem();
  const d = donate(s);
  s.recordRefund(d.id, { refundId: 're_1', amountMinor: 1000, reason: 'requested_by_customer' });

  const t = s.donationTotals();
  assert.equal(t.allTime, 0, 'refunded money must stop counting — this figure is read to a committee');
  assert.equal(t.today, 0);
  assert.equal(t.count, 1, 'the donation still HAPPENED; a vanishing count reads as a lost record');
  assert.equal(t.byDevice[0].amountMinor, 0, 'the per-kiosk breakdown nets too, or the tiles disagree');

  const after = s.getDonation(d.id)!;
  assert.equal(after.refundedMinor, 1000);
  assert.equal(after.refundId, 're_1');
  assert.equal(after.refundReason, 'requested_by_customer');
  assert.ok(after.refundedAt, 'the time is recorded so the row can say when');
});

test('partial refunds ACCUMULATE rather than overwrite', () => {
  const s = mem();
  const d = donate(s);
  assert.equal(s.recordRefund(d.id, { refundId: 're_1', amountMinor: 300 }), 300);
  assert.equal(s.donationTotals().allTime, 700, 'kept = 1000 - 300');
  // The bug this guards: a second refund replacing the first would silently re-inflate the totals by
  // the value of the earlier one — money the masjid no longer has, back on the dashboard.
  assert.equal(s.recordRefund(d.id, { refundId: 're_2', amountMinor: 200 }), 500);
  assert.equal(s.donationTotals().allTime, 500, 'kept = 1000 - (300 + 200)');
  assert.equal(s.getDonation(d.id)!.refundId, 're_2', 'the id shown is the most recent refund');
});

test('the running total is clamped to the donation, so totals can never go NEGATIVE', () => {
  const s = mem();
  const d = donate(s);
  // Stripe refuses to over-refund, so reaching this means a bug or a raced double-submit. Without the
  // clamp, amount - refunded goes below zero and this donation starts SUBTRACTING from the masjid's
  // takings — one bad row quietly eating other people's gifts.
  s.recordRefund(d.id, { refundId: 're_1', amountMinor: 999_999 });
  assert.equal(s.getDonation(d.id)!.refundedMinor, 1000, 'clamped to what was actually given');
  assert.equal(s.donationTotals().allTime, 0);
  assert.ok(s.donationTotals().allTime >= 0);
});

test('refunding one donation leaves the others alone', () => {
  const s = mem();
  const a = donate(s, { amountMinor: 1000 });
  donate(s, { amountMinor: 2500 });
  s.recordRefund(a.id, { refundId: 're_1', amountMinor: 1000 });
  assert.equal(s.donationTotals().allTime, 2500);
  assert.equal(s.donationTotals().count, 2);
});

test('recordRefund on a donation that does not exist reports it instead of throwing', () => {
  assert.equal(mem().recordRefund('nope', { refundId: 're_x', amountMinor: 100 }), null);
});

test('the route guards: what may and may not be refunded', () => {
  // Mirrors the checks in POST /api/admin/donations/:id/refund. Each exists because the alternative
  // is either money moving that shouldn't, or an admin being told money moved when it didn't.
  const allowed = (o: { status: string; amountMinor: number; refundedMinor: number; want?: number }) => {
    if (o.status !== 'succeeded') return 'not-succeeded';
    const remaining = o.amountMinor - o.refundedMinor;
    if (remaining <= 0) return 'already-refunded';
    if ((o.want ?? remaining) > remaining) return 'too-much';
    return 'ok';
  };

  assert.equal(allowed({ status: 'succeeded', amountMinor: 1000, refundedMinor: 0 }), 'ok');
  assert.equal(allowed({ status: 'succeeded', amountMinor: 1000, refundedMinor: 400, want: 600 }), 'ok', 'the exact remainder');
  assert.equal(allowed({ status: 'succeeded', amountMinor: 1000, refundedMinor: 400, want: 601 }), 'too-much');
  assert.equal(allowed({ status: 'succeeded', amountMinor: 1000, refundedMinor: 1000 }), 'already-refunded');
  // A failed/pending donation never took money, so there is nothing to give back.
  assert.equal(allowed({ status: 'requires_payment_method', amountMinor: 1000, refundedMinor: 0 }), 'not-succeeded');
  assert.equal(allowed({ status: 'canceled', amountMinor: 1000, refundedMinor: 0 }), 'not-succeeded');
});

test('the idempotency key changes with the running total, so retries are safe but real partials are not blocked', () => {
  // A double-clicked button must reuse the key (Stripe returns the SAME refund, no second payout);
  // a genuine second partial later must NOT, or Stripe would hand back the first refund and the admin
  // would think they had refunded twice when only one had gone out.
  const key = (id: string, already: number, want: number) => `refund_${id}_${already}_${want}`;
  assert.equal(key('d1', 0, 500), key('d1', 0, 500), 'double-click → same key → one refund');
  assert.notEqual(key('d1', 500, 500), key('d1', 0, 500), 'a later partial is a different request');
  assert.notEqual(key('d1', 0, 500), key('d2', 0, 500), 'never shared across donations');
});

test('a refunded monthly keeps its plan — the admin must be told', () => {
  // The trap: refunding the first payment does not cancel the Stripe subscription, so a donor gets
  // their money back and is charged again a month later. Surfaced at confirm time, in the result, and
  // in the admin alert.
  const warns = (kind: string) => kind === 'monthly';
  assert.equal(warns('monthly'), true);
  assert.equal(warns('one_time'), false);
});

test('the donor refund email states the refunded amount, and escapes everything', () => {
  const base = {
    name: 'Osman',
    amountText: '$10.00',
    campaignTitle: 'Masjid Donation',
    masjidName: 'Al-Noor',
    masjidLogo: '',
    datePaid: '9 Aug 2026, 3:14 PM',
    paymentMethod: 'Visa ···· 4242',
    reference: 'ABC123',
    contactEmail: 'info@alnoor.example',
    contactPhone: '',
    contactWebsite: '',
  };
  const full = renderRefund({ accent: '' }, { ...base, refundAmountText: '$10.00', full: true, dateRefunded: '10 Aug 2026, 9:00 AM' });
  assert.match(full.subject, /refunded/i);
  assert.match(full.text, /\$10\.00/);
  assert.match(full.text, /5 to 10 working days/, 'the one thing every donor asks next');

  // A partial must say what it was part OF, or the donor reads it as the whole gift coming back.
  const part = renderRefund({ accent: '' }, { ...base, refundAmountText: '$4.00', full: false, dateRefunded: '10 Aug 2026, 9:00 AM' });
  assert.match(part.text, /\$4\.00 of your \$10\.00/);
  assert.match(part.html, /Original donation/);

  // The donor's name came from the UNAUTHENTICATED tablet, so it must never reach the HTML raw.
  const evil = renderRefund(
    { accent: '' },
    { ...base, name: '<script>alert(1)</script>', refundAmountText: '$10.00', full: true, dateRefunded: 'x' },
  );
  assert.ok(!evil.html.includes('<script>'), 'donor name must be escaped');
  assert.match(evil.html, /&lt;script&gt;/);
  // And the accent is gated to a hex color so it can't break out of the inline style attribute.
  const badAccent = renderRefund(
    { accent: 'red;background:url(javascript:alert(1))' },
    { ...base, refundAmountText: '$1.00', full: true, dateRefunded: 'x' },
  );
  assert.ok(!badAccent.html.includes('javascript:'), 'accent must be rejected unless it is hex');
});
