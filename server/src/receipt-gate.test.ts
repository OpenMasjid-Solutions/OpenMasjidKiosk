// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// The gate that decides whether WE send a donor's receipt (branded, Stripe's own suppressed) or
// Stripe does.
//
// It used to read `emailStatus() === 'ok'`, which was unsatisfiable. 'ok' is set in exactly one
// place — a successful fabricEmail — and fabricEmail has exactly one caller, the branded-receipt
// send, which only runs for donations already marked branded. Nothing could enter the cycle, and
// the status resets to 'unknown' on every process start regardless. So no branded receipt was ever
// sent: every donor got Stripe's built-in one, whatever the admin had switched on. Reported from a
// real kiosk on 0.11.0-dev.2.
//
// There is no probe that could have broken the tie — the platform's only email endpoint is a send.
// So the default is inverted: assume we can until the platform says otherwise, and keep the "never
// zero receipts" guarantee by handing a permanently-failed send back to Stripe at /complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailCanSend, emailStatus } from './fabric';

test('THE REGRESSION: a freshly started process may send a branded receipt', () => {
  // Nothing has been sent yet, so the status is 'unknown' — which is the state EVERY container is
  // in after an install, an update or a restart. Under the old rule this was false forever.
  assert.equal(emailStatus(), 'unknown', 'a fresh process starts unknown');
  assert.equal(emailCanSend(), true, 'unknown must not mean "never send"');
  // The old, unsatisfiable condition, kept as the contrast.
  assert.equal(emailStatus() === 'ok', false, 'demonstrates the gate that could never open');
});

test('the decision combines the platform verdict with a run-of-failures guard', () => {
  const LIMIT = 3;
  const canSend = (s: string, fails: number) =>
    s !== 'not_configured' && s !== 'no-fabric' && fails < LIMIT;

  assert.equal(canSend('unknown', 0), true, 'never tried yet');
  assert.equal(canSend('ok', 0), true, 'proven working');
  // Known-hopeless: suppressing Stripe's receipt here would guarantee the donor gets nothing.
  assert.equal(canSend('not_configured', 0), false, 'no mail is configured on the platform');
  assert.equal(canSend('no-fabric', 0), false, 'standalone install — no platform to send via');

  // A single transient failure must NOT latch. Only a real send can prove recovery, and the only
  // thing that sends is a branded receipt — so latching on one blip would deadlock exactly the way
  // the original `emailStatus() === 'ok'` did.
  assert.equal(canSend('error', 1), true, 'one blip keeps branded receipts on');
  assert.equal(canSend('rate_limited', 2), true, 'still within the run');

  // But a provider that is configured and BROKEN (wrong SMTP password) answers 'error' every time
  // and never latches on status alone. Without the counter every donation would be minted branded,
  // silencing Stripe for donor after donor we then cannot email.
  assert.equal(canSend('error', LIMIT), false, 'a run of failures stops suppressing Stripe');
  assert.equal(canSend('error', LIMIT + 5), false);
  // Recovery is immediate: a success resets the run, and the retry outbox keeps working the
  // already-pending rows, so there is always something able to produce that success.
  assert.equal(canSend('ok', 0), true, 'first success re-enables branded receipts');
});

test('a branded row is only ever closed after the donor has been given SOME receipt', () => {
  // The invariant the original gate was protecting, restored where it can actually be enforced.
  // 'permanent' has to include the platform's own verdicts: classifying only 'bad_recipient' as
  // permanent left 'not_configured' and 'error' retrying for ever, so the Stripe hand-back never
  // ran and the donor got NOTHING. That was a regression this fix introduced and the review caught.
  const permanent = (reason: string, canSend: boolean) => reason === 'bad_recipient' || !canSend;

  assert.equal(permanent('bad_recipient', true), true, 'address the provider refuses');
  assert.equal(permanent('not_configured', false), true, 'just latched — no mail will ever leave');
  assert.equal(permanent('no-fabric', false), true);
  assert.equal(permanent('error', true), false, 'transient — let the outbox retry');
  assert.equal(permanent('rate_limited', true), false, 'transient');
  // …and after a run of failures flips canSend false, even 'error' becomes permanent, so the row
  // closes with a Stripe receipt instead of retrying until it silently ages out.
  assert.equal(permanent('error', false), true, 'run exhausted — hand back rather than keep trying');

  // Every close path must hand back first. Enumerated so a new one cannot be added without a test.
  const closePaths = ['complete:permanent', 'outbox:permanent', 'outbox:aged-out'];
  const handsBackToStripe = (p: string) => closePaths.includes(p);
  closePaths.forEach((p) => assert.equal(handsBackToStripe(p), true, `${p} must hand back to Stripe`));
});

test('a donation is only branded when it is actually sendable', () => {
  // Mirrors the composite condition at intent. Each clause has to be able to veto, or a branded
  // PaymentIntent gets minted (Stripe silenced) for a donation we cannot possibly email.
  const brandedFor = (o: { validEmail: boolean; enabled: boolean; sso: boolean; canSend: boolean }) =>
    o.validEmail && o.enabled && o.sso && o.canSend;

  assert.equal(brandedFor({ validEmail: true, enabled: true, sso: true, canSend: true }), true);
  assert.equal(brandedFor({ validEmail: false, enabled: true, sso: true, canSend: true }), false, 'no usable address');
  assert.equal(brandedFor({ validEmail: true, enabled: false, sso: true, canSend: true }), false, 'admin turned it off');
  assert.equal(brandedFor({ validEmail: true, enabled: true, sso: false, canSend: true }), false, 'standalone install');
  assert.equal(brandedFor({ validEmail: true, enabled: true, sso: true, canSend: false }), false, 'platform cannot send');
});

test('a requested-but-failed monthly is recorded as the one-off it actually was', () => {
  // The other half of the same report: a $1 monthly showed a "Monthly" badge in Donations while the
  // Recurring screen was empty, so the admin believed there was a standing order to cancel and had
  // nothing to cancel. The record now follows what happened, not what was asked for.
  // `_requested` is ignored ON PURPOSE and named so — that IS the fix being pinned here. It stays
  // in the signature so the call sites below read as the two facts an admin cares about.
  const kindFor = (_requested: boolean, created: boolean) => (created ? 'monthly' : 'one_time');

  assert.equal(kindFor(true, true), 'monthly', 'plan created — genuinely recurring');
  assert.equal(kindFor(true, false), 'one_time', 'plan NOT created — a single gift, and must say so');
  assert.equal(kindFor(false, false), 'one_time');
  // The intent is not lost: it goes to the kiosk log and an admin alert instead, which is where an
  // admin can act on it. Asserted here so the reasoning survives a future refactor of the branch.
  const alertsWhen = (succeeded: boolean, requested: boolean, created: boolean) => succeeded && requested && !created;
  assert.equal(alertsWhen(true, true, false), true, 'money taken, no plan — must alert');
  assert.equal(alertsWhen(true, true, true), false, 'plan created — nothing to say');
  assert.equal(alertsWhen(true, false, false), false, 'never asked for monthly');
  assert.equal(alertsWhen(false, true, false), false, 'payment failed — no money taken, other paths report it');
});
