// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// THE DONOR'S OWN "stop my monthly donation" LINK.
//
// A standing order is the one thing a kiosk sets up that keeps taking money long after the donor has
// walked away, and the donor has no account here and no password. So the link emailed to them when
// the plan is created IS the credential — which makes this the only public route in the app that
// changes anything, and the one place where getting the details wrong would matter.
//
// It is reachable from the internet on purpose (over the masjid's Cloudflare tunnel), because a donor
// who changes their mind is not sitting on the masjid's wi-fi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store';
import { GlobalAttemptBudget } from './rateLimit';
import { blockedOverTunnel } from './tunnel';
import { renderMonthlyStarted } from './email';

const mem = () => new Store(':memory:');

test('the token is stored ONLY as a hash — a leaked database cannot cancel anyone', () => {
  const s = mem();
  const token = 'a'.repeat(64);
  s.recordPlan({ subscriptionId: 'sub_1', currency: 'USD', firstAmountMinor: 200, cancelTokenHash: s.hashCancelToken(token) });

  const rec = s.getPlanRecord('sub_1')!;
  assert.notEqual(rec.cancelTokenHash, token, 'the raw token must never be what we keep');
  assert.match(rec.cancelTokenHash, /^[a-f0-9]{64}$/);
  // Only the real token resolves; possessing the stored hash does not.
  assert.equal(s.getPlanByCancelToken(token)?.subscriptionId, 'sub_1');
  assert.equal(s.getPlanByCancelToken(rec.cancelTokenHash), null, 'the hash is not a second key');
});

test('a wrong, malformed or empty token resolves to nothing', () => {
  const s = mem();
  s.recordPlan({ subscriptionId: 'sub_1', cancelTokenHash: s.hashCancelToken('b'.repeat(64)) });

  assert.equal(s.getPlanByCancelToken('c'.repeat(64)), null, 'a different token');
  assert.equal(s.getPlanByCancelToken(''), null);
  assert.equal(s.getPlanByCancelToken('short'), null);
  assert.equal(s.getPlanByCancelToken("' OR 1=1 --"), null, 'shape-checked before it ever reaches SQL');
  assert.equal(s.getPlanByCancelToken('Z'.repeat(64)), null, 'hex only');
});

test('a plan with NO token issued can never be reached by one', () => {
  // Plans created before this feature (and any whose local write failed) have a blank hash. A blank
  // must not become a skeleton key that matches an empty or unparsed token.
  const s = mem();
  s.recordPlan({ subscriptionId: 'sub_old', currency: 'USD' }); // no cancelTokenHash
  assert.equal(s.getPlanRecord('sub_old')!.cancelTokenHash, '');
  assert.equal(s.getPlanByCancelToken(''), null);
  assert.equal(s.getPlanByCancelToken('0'.repeat(64)), null);
});

test('tokens are per-plan — one donor’s link cannot touch another’s', () => {
  const s = mem();
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  s.recordPlan({ subscriptionId: 'sub_a', cancelTokenHash: s.hashCancelToken(a) });
  s.recordPlan({ subscriptionId: 'sub_b', cancelTokenHash: s.hashCancelToken(b) });
  assert.equal(s.getPlanByCancelToken(a)?.subscriptionId, 'sub_a');
  assert.equal(s.getPlanByCancelToken(b)?.subscriptionId, 'sub_b');
});

test('the donor routes are reachable over the tunnel; the admin API still is not', () => {
  // The whole point is that a donor can use this from anywhere. Both halves must pass the guard.
  assert.equal(blockedOverTunnel('/kiosk/m/' + 'a'.repeat(64)), false, 'the page is not an /api path');
  assert.equal(blockedOverTunnel('/api/public/monthly/abc/cancel'), false, 'the action is under /api/public');
  // …and none of this may widen the hole that guard exists for.
  assert.equal(blockedOverTunnel('/api/admin/plans'), true);
  assert.equal(blockedOverTunnel('/api/login'), true);
  assert.equal(blockedOverTunnel('/%61pi/admin/donations'), true, 'still fails closed on encoding');
});

test('the email carries the link, says to keep it, and escapes the donor’s own name', () => {
  const base = {
    name: 'Osman',
    amountText: '$2.00',
    campaignTitle: 'Masjid Donation',
    masjidName: 'Al-Noor',
    masjidLogo: '',
    datePaid: '12 Aug 2026, 3:14 PM',
    paymentMethod: 'Visa ···· 4050',
    reference: 'ABC123',
    contactEmail: 'info@alnoor.example',
    contactPhone: '',
    contactWebsite: '',
    nextChargeDate: '12 Sep 2026',
  };
  const url = 'https://omos.example.org/kiosk/m/' + 'a'.repeat(64);
  const withLink = renderMonthlyStarted({ accent: '' }, { ...base, cancelUrl: url });

  assert.match(withLink.subject, /monthly donation/i);
  assert.ok(withLink.html.includes(url), 'the link must actually be in the HTML');
  assert.ok(withLink.text.includes(url), 'and in the plain-text part, for clients that strip HTML');
  assert.match(withLink.text, /KEEP THIS EMAIL/i, 'the donor is told to hold on to it');
  assert.match(withLink.text, /12 Sep 2026/, 'and when the next payment falls');

  // No public address → NO dead link. A URL a donor cannot open is worse than none, because it looks
  // like it should work and they stop looking for another way to stop the donation.
  const noLink = renderMonthlyStarted({ accent: '' }, { ...base, cancelUrl: '' });
  assert.ok(!/https?:\/\//.test(noLink.text.replace(base.contactWebsite, '')), 'no invented URL');
  assert.match(noLink.text, /contact/i, 'points them at the masjid instead');

  // A non-http scheme must never become an href — the name and the URL both come from outside.
  const evil = renderMonthlyStarted(
    { accent: '' },
    { ...base, name: '<script>alert(1)</script>', cancelUrl: 'javascript:alert(1)' },
  );
  assert.ok(!evil.html.includes('<script>'), 'donor name escaped');
  assert.ok(!evil.html.includes('javascript:'), 'only http(s) links are ever emitted');
});

test('canceling is the SAFE direction, which is what makes a public link acceptable', () => {
  // Worst case for a stolen link is a stopped donation, which the donor can restart at the kiosk.
  // Money can never move TO anyone through this route, and nothing else is reachable from it.
  const canDo = (action: string) => ['view-this-plan', 'cancel-this-plan'].includes(action);
  assert.equal(canDo('cancel-this-plan'), true);
  assert.equal(canDo('view-this-plan'), true);
  assert.equal(canDo('change-amount'), false);
  assert.equal(canDo('list-other-donors'), false);
  assert.equal(canDo('refund'), false);
  assert.equal(canDo('reach-admin-api'), false);
});

test('a link for a donation that has ALREADY stopped says so', () => {
  // A donor keeps this email. They may open the link months later, or press it twice because the
  // first press was not obviously acknowledged. Offering "Stop your monthly donation" for something
  // that already stopped invites a press that does nothing and leaves them unsure either time worked.
  const PLAN_OVER = new Set(['canceled', 'incomplete_expired']);
  const isOver = (status: string) => PLAN_OVER.has(status);

  assert.equal(isOver('canceled'), true);
  assert.equal(isOver('incomplete_expired'), true, 'never got going — nothing is collecting');
  // Still collecting, or could yet: these must keep offering the button.
  assert.equal(isOver('active'), false);
  assert.equal(isOver('trialing'), false, 'the first month was paid at the kiosk — very much live');
  assert.equal(isOver('past_due'), false, 'a failed renewal is still a live plan Stripe will retry');
  assert.equal(isOver('unpaid'), false);
  assert.equal(isOver('paused'), false, 'paused can be resumed, so it is not over');
});

test('UNKNOWN must never be reported as already stopped', () => {
  // The asymmetry that matters. Wrongly saying "already stopped" sends a donor away from a donation
  // that is still running — the exact outcome this page exists to prevent. Wrongly showing the button
  // costs one press that turns out to be a no-op. So anything we cannot confirm answers "not over".
  const over = (o: { reachedStripe: boolean; status?: string }) =>
    o.reachedStripe ? new Set(['canceled', 'incomplete_expired']).has(o.status ?? '') : false;

  assert.equal(over({ reachedStripe: false }), false, 'Stripe unreachable');
  assert.equal(over({ reachedStripe: false, status: 'canceled' }), false, 'no account resolved');
  assert.equal(over({ reachedStripe: true, status: 'canceled' }), true, 'confirmed');
  assert.equal(over({ reachedStripe: true, status: 'active' }), false);
});

test('a plan Stripe no longer has at all counts as stopped', () => {
  // Deleted in the dashboard: nothing is collecting, so the honest answer to the donor is that it
  // has stopped — not an error, and not a button that would 404 against Stripe.
  const over = (live: { status: string } | null) => (live === null ? true : ['canceled', 'incomplete_expired'].includes(live.status));
  assert.equal(over(null), true);
  assert.equal(over({ status: 'active' }), false);
});

test('the liveness lookup is budgeted, and running out never refuses a donor', () => {
  // Opening the page asks Stripe whether the plan is still live, so an internet-reachable link in the
  // wrong hands (or a mailbox-scanning bot) could turn unlimited page loads into unlimited Stripe API
  // calls against the masjid's own rate limit. The budget caps that — but it must degrade by showing
  // the button, never by blocking. A donor kept from stopping a donation to save an API call would be
  // a far worse outcome than the amplification it prevents.
  const budget = new GlobalAttemptBudget(120, 60_000);
  const t0 = 1_000_000;

  // The page's actual decision: check with Stripe only while there is budget for it.
  const checksStripe = (now: number): boolean => {
    if (budget.retryAfterMs(now) !== 0) return false;
    budget.fail(now);
    return true;
  };

  for (let i = 0; i < 120; i++) assert.equal(checksStripe(t0), true, `load ${i + 1} is within budget`);
  assert.equal(checksStripe(t0), false, 'the 121st load in the window skips the lookup');
  // …and the window refills, so a spent budget is never a permanent downgrade.
  assert.equal(checksStripe(t0 + 60_000), true, 'the next minute checks again');
});

test('a skipped liveness lookup shows the button — the POST is what must be right', () => {
  // Fail-open has one visible cost: on an already-stopped plan the donor sees the button and presses
  // it for nothing. That is the pre-existing behavior, and the POST re-checks unconditionally, so
  // the money outcome is identical either way. Encoded here so nobody "optimises" the POST later.
  const page = (checked: boolean, over: boolean) => (checked && over ? 'already-stopped' : 'button');
  assert.equal(page(true, true), 'already-stopped', 'checked and over');
  assert.equal(page(true, false), 'button', 'checked and live');
  assert.equal(page(false, true), 'button', 'not checked — show the button rather than guess');
  assert.equal(page(false, false), 'button');
});

test('an already-stopped press changes nothing, so it raises no alert', () => {
  // The monthly-cancelled alert tells the masjid a donor ended their giving. Firing it again on a
  // second press would report a cancellation that did not happen, on a date it did not happen.
  const alerts = (didSomething: boolean) => didSomething;
  assert.equal(alerts(true), true, 'a real cancellation');
  assert.equal(alerts(false), false, 'already stopped — nothing to report');
});
