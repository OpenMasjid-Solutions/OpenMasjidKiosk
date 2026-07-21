// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTuitionAmount, createTuitionSession, getTuitionSession } from './students';
import { Store } from './store';

function session(balanceCents: number, invoices: { id: string; balanceCents: number }[]) {
  return createTuitionSession({
    campaignId: 'cmp_1',
    deviceId: 'dev_1',
    familyId: 'fam_1',
    studentId: 'stu_1',
    familyLabel: 'Ismail family',
    currency: 'USD',
    balanceCents,
    invoices,
  });
}

test('computeTuitionAmount "full" pays the whole balance, no allocations (Students auto-allocates)', () => {
  const s = session(35000, [{ id: 'inv_9', balanceCents: 15000 }, { id: 'inv_10', balanceCents: 20000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'full' }), { amountCents: 35000, allocations: null });
});

test('computeTuitionAmount "full" with nothing due errors (never a zero charge)', () => {
  assert.deepEqual(computeTuitionAmount(session(0, []), { kind: 'full' }), { error: 'nothing-due' });
});

test('computeTuitionAmount invoices sums the SERVER-side stored amounts (client sends only ids)', () => {
  const s = session(35000, [{ id: 'inv_9', balanceCents: 15000 }, { id: 'inv_10', balanceCents: 20000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9'] }), {
    amountCents: 15000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
  });
});

test('computeTuitionAmount rejects an unknown invoice id (can\'t attribute a made-up charge)', () => {
  const s = session(15000, [{ id: 'inv_9', balanceCents: 15000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_x'] }), { error: 'unknown-invoice' });
});

test('computeTuitionAmount rejects an empty selection', () => {
  const s = session(15000, [{ id: 'inv_9', balanceCents: 15000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: [] }), { error: 'no-selection' });
});

test('computeTuitionAmount dedups repeated invoice ids (no double-charging one invoice)', () => {
  const s = session(15000, [{ id: 'inv_9', balanceCents: 15000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_9'] }), {
    amountCents: 15000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
  });
});

test('tuition session round-trips by opaque id and holds family/device server-side', () => {
  const s = session(15000, [{ id: 'inv_9', balanceCents: 15000 }]);
  const got = getTuitionSession(s.id);
  assert.ok(got);
  assert.equal(got?.familyId, 'fam_1');
  assert.equal(got?.deviceId, 'dev_1');
  assert.equal(getTuitionSession('not-a-real-session'), null);
});

test('tuition outbox: enqueued → pending until paid → recorded leaves the queue', () => {
  const s = new Store(':memory:');
  try {
    s.enqueueTuitionPayment({
      paymentIntentId: 'pi_1',
      deviceId: 'dev_1',
      campaignId: 'cmp_1',
      stripeAccountId: 'acct_1',
      familyId: 'fam_1',
      studentId: 'stu_1',
      familyLabel: 'Ismail family',
      amountMinor: 15000,
      currency: 'USD',
      allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    });
    // Not in the retry queue until the charge succeeds (never record a non-succeeded payment).
    assert.equal(s.listPendingTuitionRecords().length, 0);
    s.markTuitionPaid('pi_1', 'succeeded', 'ch_1');
    const pending = s.listPendingTuitionRecords();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].familyId, 'fam_1');
    assert.deepEqual(pending[0].allocations, [{ invoiceId: 'inv_9', amountCents: 15000 }]);
    // Once recorded in Students it drops out of the queue.
    s.setTuitionRecordStatus('pi_1', 'recorded', 'pay_71');
    assert.equal(s.listPendingTuitionRecords().length, 0);
    assert.equal(s.getTuitionOutbox('pi_1')?.recordStatus, 'recorded');
    assert.equal(s.getTuitionOutbox('pi_1')?.studentsPaymentId, 'pay_71');
  } finally {
    s.close();
  }
});
