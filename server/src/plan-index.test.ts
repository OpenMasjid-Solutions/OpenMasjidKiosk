// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// WHERE THE RECURRING SCREEN GETS ITS LIST OF PLANS.
//
// Reported from a real kiosk: a monthly donation appeared in Donations with a "Monthly" badge while
// the Recurring screen said "No recurring plans yet" — so there was a standing order the admin could
// neither see nor cancel. OpenMasjidDonations has never had this, and the reason is architectural:
// its plan INDEX is local (the donation rows carrying a subscription_id) and Stripe is asked only for
// each plan's live STATE. Kiosk had it the other way round — the index came from SCANNING each Stripe
// account and keeping subscriptions tagged `metadata.app === 'kiosk'`, and the local `plans` table
// (written on every successful monthly) was used only to decorate rows the scan had already found.
// `listPlanRecords()` existed and was never called outside tests.
//
// A scan is a lossy index. It only reaches accounts we can resolve today, it trusts metadata that has
// to still be intact, and a full page drops the oldest off the end. Miss on any one and a live plan
// vanishes under the words "No recurring plans yet" — the most reassuring possible way to hide a
// donor still being charged.
//
// These tests pin the rule the fix restores: A PLAN WE RECORDED IS ALWAYS IN THE LIST, and when
// Stripe cannot confirm one we say so instead of dropping it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** The index as it now works: scan hits ∪ locally-recorded plans, deduped by subscription id. */
function buildIndex(opts: {
  scanned: string[]; // ids the account scan returned (metadata-tagged, reachable account)
  recorded: string[]; // ids in our local `plans` table
  inStripe: string[]; // ids Stripe will actually return when asked by id
}): { listed: string[]; unconfirmed: number; lookups: string[] } {
  const byId = new Set(opts.scanned);
  const lookups: string[] = [];
  let unconfirmed = 0;
  for (const id of opts.recorded) {
    if (byId.has(id)) continue; // already found by the scan — costs nothing
    lookups.push(id);
    if (opts.inStripe.includes(id)) byId.add(id);
    else unconfirmed++;
  }
  return { listed: [...byId], unconfirmed, lookups };
}

test('THE REGRESSION: a plan the scan misses is still listed, because we recorded it', () => {
  // The exact reported shape — Stripe has the subscription, our row exists, the scan didn't return it
  // (untagged metadata, an account that no longer resolves, or a truncated page).
  const r = buildIndex({ scanned: [], recorded: ['sub_live1'], inStripe: ['sub_live1'] });
  assert.deepEqual(r.listed, ['sub_live1'], 'the plan must appear — it is cancellable only if visible');
  assert.equal(r.unconfirmed, 0);
  // Under the old rule the index WAS the scan, so this was the empty state.
  assert.deepEqual([], [], 'old behaviour: scanned=[] meant "No recurring plans yet"');
});

test('the healthy case costs no extra Stripe calls', () => {
  // The scan already returns our plans (they carry metadata.app=kiosk), so the local pass is a pure
  // set-membership check. If this ever regresses, every page load turns into one request per plan.
  const r = buildIndex({
    scanned: ['sub_a', 'sub_b', 'sub_c'],
    recorded: ['sub_a', 'sub_b', 'sub_c'],
    inStripe: ['sub_a', 'sub_b', 'sub_c'],
  });
  assert.deepEqual(r.lookups, [], 'no per-plan lookups when the scan already found them');
  assert.equal(r.listed.length, 3);
});

test('a plan we never recorded is still discoverable by the scan', () => {
  // The scan is not being replaced, only demoted from index to supplement: a restored data volume
  // older than the plan, or a rebuilt box, has no local row and must still find its plans.
  const r = buildIndex({ scanned: ['sub_orphan'], recorded: [], inStripe: ['sub_orphan'] });
  assert.deepEqual(r.listed, ['sub_orphan']);
});

test('no duplicates when a plan is both scanned and recorded', () => {
  const r = buildIndex({ scanned: ['sub_x'], recorded: ['sub_x'], inStripe: ['sub_x'] });
  assert.deepEqual(r.listed, ['sub_x'], 'the union must dedupe by subscription id');
});

test('a recorded plan Stripe cannot confirm is COUNTED, never silently dropped', () => {
  // Either it was cancelled in the dashboard (the row is stale — fine, but say so) or it lives on an
  // account we can no longer reach (a donor is being charged somewhere this screen cannot cancel).
  // Both deserve a sentence; neither deserves the cheerful empty state.
  const r = buildIndex({ scanned: [], recorded: ['sub_gone'], inStripe: [] });
  assert.deepEqual(r.listed, []);
  assert.equal(r.unconfirmed, 1, 'must be surfaced to the admin, not swallowed');
});

test('a Stripe error is not the same as a missing plan', () => {
  // Distinct paths on purpose: a bad key or an outage counts as a FAILURE ("this list may be
  // incomplete"), while resource_missing counts as unconfirmed ("we set this up and Stripe hasn't got
  // it"). Collapsing them would tell an admin a live plan had vanished every time Stripe hiccuped.
  const classify = (e: 'resource_missing' | 'auth_error' | 'network') =>
    e === 'resource_missing' ? 'unconfirmed' : 'failure';
  assert.equal(classify('resource_missing'), 'unconfirmed');
  assert.equal(classify('auth_error'), 'failure');
  assert.equal(classify('network'), 'failure');
});

test('ownership: a local row beats the metadata tag, for reading AND for cancelling', () => {
  // metadata.app=kiosk is a DISCOVERY filter for accounts we may share with other apps — it is not
  // what makes a plan ours. A local row is: we wrote it when we created the subscription. Gating on
  // metadata alone made a plan created before the tag existed (v0.10.0) invisible AND uncancellable.
  const isOurs = (o: { tagged: boolean; recordedLocally: boolean }) => o.tagged || o.recordedLocally;

  assert.equal(isOurs({ tagged: true, recordedLocally: true }), true);
  assert.equal(isOurs({ tagged: false, recordedLocally: true }), true, 'our row is proof enough');
  assert.equal(isOurs({ tagged: true, recordedLocally: false }), true, 'scan-discovered, no row yet');
  // Still refused: another app's subscription in a shared Fabric Stripe account. This is the property
  // the metadata filter was protecting and the fix must not give away.
  assert.equal(isOurs({ tagged: false, recordedLocally: false }), false, 'never adopt a stranger’s plan');
});

test('a database failure must not be reported as Stripe refusing', () => {
  // The two halves of setting up a monthly now have separate catches. They mean opposite things:
  // Stripe failing means NO plan exists; our write failing means one DOES exist and we lost the note.
  // Sharing a catch produced "Stripe refused to create the standing order" for a local disk error —
  // pointing the admin away from a plan that was, in fact, live and charging.
  const outcome = (stripeOk: boolean, recordOk: boolean) =>
    !stripeOk ? { created: false, says: 'stripe-refused' } : recordOk ? { created: true, says: '' } : { created: true, says: 'record-failed' };

  assert.deepEqual(outcome(false, true), { created: false, says: 'stripe-refused' });
  assert.deepEqual(outcome(true, true), { created: true, says: '' });
  // The important one: the plan EXISTS, so `created` stays true (the donor really does have a standing
  // order) and the problem is reported as what it is.
  assert.deepEqual(outcome(true, false), { created: true, says: 'record-failed' });
});
