// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStudentPayment,
  computeTuitionAmount,
  createTuitionSession,
  getTuitionSession,
  normalizeStudentCode,
  recordStudentPayment,
  studentsIdentify,
  studentsLookup,
} from './students';
import { config } from './config';
import { Store } from './store';

/** One captured broker request (what we actually put on the wire). */
interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** Point the broker client at a stubbed Fabric and capture every request it makes. Restores the real
 *  fetch (and the real config) when the returned function is called. */
function stubBroker(reply: unknown): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const origFetch = globalThis.fetch;
  const origBase = config.omosBaseUrl;
  const origSecret = config.omosAppSecret;
  config.omosBaseUrl = 'http://omos.test';
  config.omosAppSecret = 'test-secret';
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = origFetch;
      config.omosBaseUrl = origBase;
      config.omosAppSecret = origSecret;
    },
  };
}

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

// ── Student ID normalisation (contract v2 §11.0 — the ID replaced the name + PIN) ──
test('normalizeStudentCode canonicalises what a parent types (case, spaces, hyphens)', () => {
  assert.equal(normalizeStudentCode('yus-1234'), 'YUS1234');
  assert.equal(normalizeStudentCode('  YUS 1234 '), 'YUS1234');
  assert.equal(normalizeStudentCode('Yus1234'), 'YUS1234');
});

test('normalizeStudentCode leaves an empty entry empty (so we never probe with a blank ID)', () => {
  assert.equal(normalizeStudentCode('   '), '');
  assert.equal(normalizeStudentCode('- -'), '');
});

// ── The v2 wire shape: identify + lookup send the Student ID (never a name/PIN) ──
test('identify posts { v: 2, studentCode } and returns just the child\'s name', async () => {
  const broker = stubBroker({ v: 2, found: true, student: { studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I' } });
  try {
    const r = await studentsIdentify(' yus-1234 ');
    assert.equal(broker.calls.length, 1);
    assert.equal(broker.calls[0].url, 'http://omos.test/api/fabric/app/students/billing/identify');
    assert.deepEqual(broker.calls[0].body, { v: 2, studentCode: 'YUS1234' });
    assert.deepEqual(r, { status: 'found', student: { studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I' } });
  } finally {
    broker.restore();
  }
});

test('identify: a uniform not-found (never a hint about what mismatched)', async () => {
  const broker = stubBroker({ v: 2, found: false });
  try {
    assert.deepEqual(await studentsIdentify('YUS1234'), { status: 'not-found' });
  } finally {
    broker.restore();
  }
});

test('lookup posts { v: 2, studentCode } — no name, no pin (the 0.39.0 break)', async () => {
  const broker = stubBroker({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_1', balanceCents: 20000 },
    family: {
      id: 'fam_x1',
      label: 'Ismail family',
      students: [
        { studentId: 'stu_1', studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 20000 },
        { studentId: 'stu_2', studentCode: 'MAR8802', firstName: 'Maryam', lastInitial: 'I', balanceCents: 15000 },
      ],
      balanceCents: 35000,
      currency: 'usd',
      openInvoices: [{ id: 'inv_9', studentId: 'stu_2', label: 'Tuition — Jul 2026', dueDate: '2026-07-01', balanceCents: 15000 }],
    },
  });
  try {
    const r = await studentsLookup('yus 1234');
    assert.deepEqual(broker.calls[0].body, { v: 2, studentCode: 'YUS1234' });
    assert.equal(broker.calls[0].url, 'http://omos.test/api/fabric/app/students/billing/lookup');
    assert.equal(r.status, 'found');
    if (r.status !== 'found') return;
    assert.equal(r.matchedStudentId, 'stu_1');
    assert.equal(r.family.balanceCents, 35000);
    // v2: bills are per child, so an invoice says whose it is (siblings ⇒ identical labels otherwise).
    assert.equal(r.family.openInvoices[0].studentName, 'Maryam');
    // Internal student ids never reach the tablet — only display fields do.
    assert.deepEqual(r.family.students, [
      { firstName: 'Yusuf', lastInitial: 'I', balanceCents: 20000 },
      { firstName: 'Maryam', lastInitial: 'I', balanceCents: 15000 },
    ]);
  } finally {
    broker.restore();
  }
});

test('lookup: an only child gets no per-invoice name (nothing to disambiguate)', async () => {
  const broker = stubBroker({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_1', balanceCents: 15000 },
    family: {
      id: 'fam_x1',
      label: 'Ismail family',
      students: [{ studentId: 'stu_1', studentCode: 'YUS1234', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 15000 }],
      balanceCents: 15000,
      currency: 'usd',
      openInvoices: [{ id: 'inv_9', studentId: 'stu_1', label: 'Tuition — Jul 2026', dueDate: '2026-07-01', balanceCents: 15000 }],
    },
  });
  try {
    const r = await studentsLookup('YUS1234');
    assert.equal(r.status === 'found' && r.family.openInvoices[0].studentName, '');
  } finally {
    broker.restore();
  }
});

test('the money path stays on v: 1 — record-payment and check are unchanged by the v2 upgrade', async () => {
  const rec = stubBroker({ v: 2, recorded: true, paymentId: 'pay_71', duplicate: false });
  try {
    await recordStudentPayment({
      idempotencyKey: 'pi_3PabcDEF',
      familyId: 'fam_x1',
      studentId: 'stu_1',
      amountCents: 15000,
      currency: 'USD',
      occurredAt: '2026-07-15T18:03:22Z',
      externalRef: { stripePaymentIntentId: 'pi_3PabcDEF' },
      allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    });
    assert.equal(rec.calls[0].body.v, 1);
    assert.equal(rec.calls[0].body.channel, 'kiosk');
  } finally {
    rec.restore();
  }
  const chk = stubBroker({ v: 2, recorded: true, paymentId: 'pay_71' });
  try {
    assert.deepEqual(await checkStudentPayment('pi_3PabcDEF'), { status: 'recorded', paymentId: 'pay_71' });
    assert.deepEqual(chk.calls[0].body, { v: 1, idempotencyKey: 'pi_3PabcDEF' });
  } finally {
    chk.restore();
  }
});

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
