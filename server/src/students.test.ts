// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStudentPayment,
  computeTuitionAmount,
  createTuitionSession,
  getTuitionSession,
  grossUpForStudentsFee,
  kioskFeeRate,
  normalizeStudentCode,
  recordStudentPayment,
  studentsIdentify,
  studentsInfo,
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

function session(
  balanceCents: number,
  invoices: { id: string; balanceCents: number; studentId?: string; items?: { id: string; balanceCents: number }[] }[],
  opts: {
    allowAdvance?: boolean;
    minAmountCents?: number;
    creditCents?: number;
    students?: { studentId: string; name: string; balanceCents: number; creditCents: number }[];
    /** The processing rate the quote was made at (0.51.0). Default null = the school absorbs it,
     *  which is what every test written before the fee existed assumes. */
    feeRate?: { percentBps: number; fixedCents: number; capCents?: number } | null;
  } = {},
) {
  return createTuitionSession({
    campaignId: 'cmp_1',
    deviceId: 'dev_1',
    familyId: 'fam_1',
    studentId: 'stu_1',
    familyLabel: 'Ismail family',
    currency: 'USD',
    balanceCents,
    creditCents: opts.creditCents ?? 0,
    allowAdvance: opts.allowAdvance ?? true,
    feeRate: opts.feeRate ?? null,
    minAmountCents: opts.minAmountCents ?? 100,
    students: opts.students ?? [{ studentId: 'stu_1', name: 'Yusuf I', balanceCents, creditCents: opts.creditCents ?? 0 }],
    invoices: invoices.map((i) => ({ studentId: 'stu_1', items: [], ...i })),
  });
}

// ── Student ID normalization (contract v2 §11.0 — the ID replaced the name + PIN) ──
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
    // v2: bills are per child, so an invoice says whose it is (siblings ⇒ identical labels otherwise)
    // — as a name for the tablet, and as the internal id the pay step splits the charge with.
    assert.equal(r.family.openInvoices[0].studentName, 'Maryam');
    assert.equal(r.family.openInvoices[0].studentId, 'stu_2');
    // The internal id is kept HERE (the route needs it to build the session's per-child sections) but
    // is stripped before the response — the tablet only ever gets a positional key.
    assert.deepEqual(r.family.students, [
      { studentId: 'stu_1', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 20000, creditCents: 0 },
      { studentId: 'stu_2', firstName: 'Maryam', lastInitial: 'I', balanceCents: 15000, creditCents: 0 },
    ]);
    // No `items` from a pre-0.43.0 provider → the bill stays one line, exactly as before.
    assert.deepEqual(r.family.openInvoices[0].items, []);
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

// ── 0.41.0 additive fields: credit, and the advance/floor policy ──
test('lookup reads creditCents for the household and each child (a zero balance is ambiguous alone)', async () => {
  const broker = stubBroker({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_2', balanceCents: 0, creditCents: 5000 },
    family: {
      id: 'fam_x1',
      label: 'Ismail family',
      students: [
        { studentId: 'stu_1', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 0, creditCents: 0 },
        { studentId: 'stu_2', firstName: 'Maryam', lastInitial: 'I', balanceCents: 0, creditCents: 5000 },
      ],
      balanceCents: 0,
      creditCents: 5000,
      currency: 'usd',
      openInvoices: [],
    },
  });
  try {
    const r = await studentsLookup('MAR8802');
    assert.equal(r.status, 'found');
    if (r.status !== 'found') return;
    assert.equal(r.family.balanceCents, 0);
    assert.equal(r.family.creditCents, 5000);
    assert.deepEqual(r.family.students.map((s) => [s.firstName, s.creditCents]), [['Yusuf', 0], ['Maryam', 5000]]);
  } finally {
    broker.restore();
  }
});

test('info reads allowAdvance + minAmountCents, and never lets the floor drop below $1', async () => {
  const low = stubBroker({ v: 2, enabled: true, schoolName: 'An-Noor', currency: 'usd', tagline: 't', allowAdvance: true, minAmountCents: 25 });
  try {
    const r = await studentsInfo(true);
    assert.equal(r.available && r.info.allowAdvance, true);
    assert.equal(r.available && r.info.minAmountCents, 100); // ours wins over a lower school floor
  } finally {
    low.restore();
  }
  const high = stubBroker({ v: 2, enabled: true, schoolName: 'An-Noor', currency: 'usd', tagline: 't', minAmountCents: 500 });
  try {
    const r = await studentsInfo(true);
    // Absent allowAdvance → false: "nothing due" and "can't pay here" look identical without it.
    assert.equal(r.available && r.info.allowAdvance, false);
    assert.equal(r.available && r.info.minAmountCents, 500);
  } finally {
    high.restore();
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
    assert.equal(rec.calls[0].body.students, undefined); // no split → nothing v2-only on the wire
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

test('a per-child split rides on record-payment and announces v: 2 (the field only exists there)', async () => {
  const rec = stubBroker({
    v: 2,
    recorded: true,
    paymentId: 'pay_71',
    duplicate: false,
    payments: [
      { studentId: 'stu_2', paymentId: 'pay_71', amountCents: 30000, duplicate: false },
      { studentId: 'stu_1', paymentId: 'pay_72', amountCents: 20000, duplicate: false },
    ],
  });
  try {
    const r = await recordStudentPayment({
      idempotencyKey: 'pi_3PabcDEF',
      familyId: 'fam_x1',
      amountCents: 50000,
      currency: 'USD',
      occurredAt: '2026-07-15T18:03:22Z',
      externalRef: { stripePaymentIntentId: 'pi_3PabcDEF' },
      students: [
        { studentId: 'stu_2', amountCents: 30000 },
        { studentId: 'stu_1', amountCents: 20000 },
      ],
    });
    assert.equal(rec.calls[0].body.v, 2);
    assert.deepEqual(rec.calls[0].body.students, [
      { studentId: 'stu_2', amountCents: 30000 },
      { studentId: 'stu_1', amountCents: 20000 },
    ]);
    assert.deepEqual(r, { status: 'recorded', paymentId: 'pay_71', duplicate: false });
  } finally {
    rec.restore();
  }
});

// ── 0.43.0 (§11.0b): itemized bills — the lines a bill is made of, and paying just one ──
test('the ticked LINES ride on record-payment as `lines`, alone, at v: 2', async () => {
  const rec = stubBroker({ v: 2, recorded: true, paymentId: 'pay_71', duplicate: false });
  try {
    await recordStudentPayment({
      idempotencyKey: 'pi_3PabcDEF',
      familyId: 'fam_x1',
      amountCents: 5000,
      currency: 'USD',
      occurredAt: '2026-07-15T18:03:22Z',
      externalRef: { stripePaymentIntentId: 'pi_3PabcDEF' },
      lines: [{ itemId: 'iti_2', amountCents: 5000 }],
      // Both of these are superseded by `lines` and must NOT reach the wire — the provider prefers
      // lines, and two breakdowns that could disagree is exactly the ambiguity the contract forbids.
      students: [{ studentId: 'stu_1', amountCents: 5000 }],
      allocations: [{ invoiceId: 'inv_9', amountCents: 5000 }],
    });
    assert.equal(rec.calls[0].body.v, 2);
    assert.deepEqual(rec.calls[0].body.lines, [{ itemId: 'iti_2', amountCents: 5000 }]);
    assert.equal(rec.calls[0].body.students, undefined);
    assert.equal(rec.calls[0].body.allocations, undefined);
  } finally {
    rec.restore();
  }
});

test('lookup reads a bill\'s items — kind, a SIGNED amount for a credit line, and a payable balance', async () => {
  const broker = stubBroker({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_1', balanceCents: 22000 },
    family: {
      id: 'fam_x1',
      label: 'Ismail family',
      students: [{ studentId: 'stu_1', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 22000, creditCents: 0 }],
      balanceCents: 22000,
      currency: 'usd',
      openInvoices: [
        {
          id: 'inv_9',
          studentId: 'stu_1',
          label: 'Tuition — Feb 2027',
          dueDate: '2027-02-01',
          balanceCents: 22000,
          // $200 tuition + $50 book fee − a $30 bursary = the $220 bill. The bursary's value is
          // deducted from the lines ABOVE it, so the tuition line reads $170 and the credit reads 0.
          items: [
            { id: 'iti_1', label: 'Monthly tuition', kind: 'tuition', amountCents: 20000, balanceCents: 17000 },
            { id: 'iti_2', label: 'Book fee', kind: 'charge', amountCents: 5000, balanceCents: 5000 },
            { id: 'iti_3', label: 'Sibling bursary', kind: 'credit', amountCents: -3000, balanceCents: 0 },
          ],
        },
      ],
    },
  });
  try {
    const r = await studentsLookup('YUS1234');
    assert.equal(r.status, 'found');
    if (r.status !== 'found') return;
    const items = r.family.openInvoices[0].items;
    assert.equal(items.length, 3);
    assert.deepEqual(items[1], { id: 'iti_2', label: 'Book fee', kind: 'charge', amountCents: 5000, balanceCents: 5000 });
    // A credit line keeps its NEGATIVE amount (clamping it to zero would render "Bursary $0") while
    // reporting nothing payable — its value is already off the lines above it.
    assert.equal(items[2].amountCents, -3000);
    assert.equal(items[2].balanceCents, 0);
    // The contract's arithmetic guarantee, which everything downstream leans on.
    assert.equal(items.reduce((n, i) => n + i.balanceCents, 0), r.family.openInvoices[0].balanceCents);
  } finally {
    broker.restore();
  }
});

test('lookup DROPS items that don\'t add up to the bill (a list that doesn\'t reconcile is worse than none)', async () => {
  const broker = stubBroker({
    v: 2,
    found: true,
    matchedStudent: { id: 'stu_1', balanceCents: 25000 },
    family: {
      id: 'fam_x1',
      label: 'Ismail family',
      students: [{ studentId: 'stu_1', firstName: 'Yusuf', lastInitial: 'I', balanceCents: 25000, creditCents: 0 }],
      balanceCents: 25000,
      currency: 'usd',
      openInvoices: [
        {
          id: 'inv_9',
          studentId: 'stu_1',
          label: 'Tuition — Feb 2027',
          dueDate: '2027-02-01',
          balanceCents: 25000,
          // Only $200 of a $250 bill: a `lines[]` built from this would be a 422 from the provider.
          items: [{ id: 'iti_1', label: 'Monthly tuition', kind: 'tuition', amountCents: 20000, balanceCents: 20000 }],
        },
      ],
    },
  });
  try {
    const r = await studentsLookup('YUS1234');
    assert.equal(r.status === 'found' && r.family.openInvoices[0].items.length, 0);
  } finally {
    broker.restore();
  }
});

/** A session whose one bill is itemized: $200 tuition + $50 book fee, and a settled $30 line. */
function itemisedSession(opts: { minAmountCents?: number } = {}) {
  return session(
    25000,
    [
      {
        id: 'inv_9',
        balanceCents: 25000,
        items: [
          { id: 'iti_1', balanceCents: 20000 },
          { id: 'iti_2', balanceCents: 5000 },
          { id: 'iti_3', balanceCents: 0 }, // already settled — listed on screen, never payable
        ],
      },
    ],
    opts,
  );
}

test('ticking ONE line pays exactly that line (the whole point of §11.0b)', () => {
  const r = computeTuitionAmount(itemisedSession(), { kind: 'items', itemIds: ['iti_2'] });
  assert.deepEqual(r, {
    amountCents: 5000,
    allocations: null,
    students: null, // superseded — a line already says whose bill it is
    lines: [{ itemId: 'iti_2', amountCents: 5000 }],
  });
});

test('ticked lines sum to the charge exactly, and repeats don\'t double-charge a line', () => {
  const r = computeTuitionAmount(itemisedSession(), { kind: 'items', itemIds: ['iti_1', 'iti_2', 'iti_1'] });
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.amountCents, 25000);
  assert.equal(r.lines?.reduce((n, l) => n + l.amountCents, 0), r.amountCents);
  assert.equal(r.lines?.length, 2);
});

test('a made-up, settled or credit line is refused — never a charge that differs from what was ticked', () => {
  assert.deepEqual(computeTuitionAmount(itemisedSession(), { kind: 'items', itemIds: ['iti_x'] }), { error: 'unknown-item' });
  assert.deepEqual(computeTuitionAmount(itemisedSession(), { kind: 'items', itemIds: ['iti_3'] }), { error: 'unknown-item' });
  assert.deepEqual(computeTuitionAmount(itemisedSession(), { kind: 'items', itemIds: [] }), { error: 'no-selection' });
});

test('the $1 floor applies to a ticked line too (a 60p line costs more in fees than it collects)', () => {
  const s = session(60, [{ id: 'inv_9', balanceCents: 60, items: [{ id: 'iti_1', balanceCents: 60 }] }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'items', itemIds: ['iti_1'] }), { error: 'below-min' });
});

test('"pay this whole bill" is sent as its LINES when the bill is itemized (honored, not a hint)', () => {
  const r = computeTuitionAmount(itemisedSession(), { kind: 'invoices', invoiceIds: ['inv_9'] });
  assert.deepEqual(r, {
    amountCents: 25000,
    allocations: null,
    students: null,
    lines: [
      { itemId: 'iti_1', amountCents: 20000 },
      { itemId: 'iti_2', amountCents: 5000 },
    ],
  });
});

test('a picked bill with NO items keeps the pre-0.43.0 shape — the two breakdowns are never mixed', () => {
  // Mixing is a hard 422: `lines` must cover the whole charge, so a partly-itemized pick has to fall
  // back to the invoice-level hint plus the per-child split for ALL of it.
  const s = session(45000, [
    { id: 'inv_9', balanceCents: 25000, items: [{ id: 'iti_1', balanceCents: 25000 }] },
    { id: 'inv_8', balanceCents: 20000, studentId: 'stu_2' },
  ]);
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_8'] });
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.lines, null);
  assert.equal(r.amountCents, 45000);
  assert.equal(r.students?.reduce((n, x) => n + x.amountCents, 0), 45000);
});

// ── Per-child advances: "add money for Maryam" (the tablet names a child by session KEY) ──
const TWO_KIDS = [
  { studentId: 'stu_1', name: 'Yusuf I', balanceCents: 20000, creditCents: 0 },
  { studentId: 'stu_2', name: 'Maryam I', balanceCents: 0, creditCents: 5000 },
];

test('a typed amount for a named child lands on THAT child\'s ledger, not the household\'s', () => {
  const s = session(20000, [{ id: 'inv_9', balanceCents: 20000 }], { students: TWO_KIDS });
  const r = computeTuitionAmount(s, { kind: 'amount', amountCents: 5000, studentKey: 's1' });
  assert.deepEqual(r, {
    amountCents: 5000,
    allocations: null,
    students: [{ studentId: 'stu_2', amountCents: 5000 }],
    lines: null,
    studentId: 'stu_2',
  });
});

test('the advance ceiling is the CHOSEN child\'s balance, not the household\'s', () => {
  // Maryam owes nothing while the household owes $200: paying $50 for her IS an advance, and needs the
  // school to have said it takes money that way.
  const off = session(20000, [{ id: 'inv_9', balanceCents: 20000 }], { students: TWO_KIDS, allowAdvance: false });
  assert.deepEqual(computeTuitionAmount(off, { kind: 'amount', amountCents: 5000, studentKey: 's1' }), { error: 'advance-not-allowed' });
  // …while paying part of what Yusuf actually owes never needed that permission.
  assert.equal('amountCents' in computeTuitionAmount(off, { kind: 'amount', amountCents: 5000, studentKey: 's0' }), true);
});

test('a student key that isn\'t in the session is refused (the tablet can\'t name an arbitrary child)', () => {
  const s = session(20000, [{ id: 'inv_9', balanceCents: 20000 }], { students: TWO_KIDS });
  // A real internal id is refused too: the tablet is never given one, so it can never send one.
  for (const key of ['s9', 'stu_2', 'sx', 's-1']) {
    assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 5000, studentKey: key }), { error: 'unknown-student' });
  }
  // A BLANK key means "no child named" (the unattributed section carries one), not a bad child — the
  // charge falls back to the household path Students walks oldest-due-first.
  const blank = computeTuitionAmount(s, { kind: 'amount', amountCents: 5000, studentKey: '' });
  assert.deepEqual(blank, { amountCents: 5000, allocations: null, students: null, lines: null });
});

test('computeTuitionAmount "full" pays the whole balance, no allocations (Students auto-allocates)', () => {
  const s = session(35000, [{ id: 'inv_9', balanceCents: 15000 }, { id: 'inv_10', balanceCents: 20000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'full' }), { amountCents: 35000, allocations: null, students: null, lines: null });
});

test('computeTuitionAmount "full" with nothing due errors (never a zero charge)', () => {
  assert.deepEqual(computeTuitionAmount(session(0, []), { kind: 'full' }), { error: 'nothing-due' });
});

// Reported from a tablet: a family where one child was $340 in credit and another owed $160 showed
// three unpaid bills and NO way to pay any of them. Students nets the household figure, so it read
// balance 0 / credit 180 — and every pay control keyed off that balance.
test('"full" pays the open BILLS, not the household balance netted down by a sibling\'s credit', () => {
  const netted = session(
    0, // household balance: Yusuf's credit has canceled Yunus's bills out of it
    [
      { id: 'inv_jul', balanceCents: 2000, studentId: 'stu_2' },
      { id: 'inv_jan', balanceCents: 12000, studentId: 'stu_2' },
      { id: 'inv_jul26', balanceCents: 2000, studentId: 'stu_2' },
    ],
    {
      creditCents: 18000,
      students: [
        { studentId: 'stu_1', name: 'Yusuf M', balanceCents: 0, creditCents: 34000 },
        { studentId: 'stu_2', name: 'Yunus M', balanceCents: 16000, creditCents: 0 },
      ],
    },
  );
  assert.deepEqual(computeTuitionAmount(netted, { kind: 'full' }), {
    amountCents: 16000, // what Yunus actually owes — NOT the $0 household net
    allocations: null,
    students: null,
    lines: null,
  });
});

test('a part payment isn\'t mistaken for an advance when a sibling\'s credit nets the household to zero', () => {
  // allowAdvance off: paying $50 towards Yunus's real $160 of bills must still be allowed. Measuring
  // against the netted household balance (0) would call every penny of it "paying ahead".
  const netted = session(0, [{ id: 'inv_jan', balanceCents: 16000, studentId: 'stu_2' }], {
    allowAdvance: false,
    creditCents: 18000,
    students: [
      { studentId: 'stu_1', name: 'Yusuf M', balanceCents: 0, creditCents: 34000 },
      { studentId: 'stu_2', name: 'Yunus M', balanceCents: 16000, creditCents: 0 },
    ],
  });
  assert.equal('amountCents' in computeTuitionAmount(netted, { kind: 'amount', amountCents: 5000 }), true);
  // …and the per-child route still measures against THAT child: Yusuf owes nothing, so money for him
  // is an advance and stays refused.
  assert.deepEqual(computeTuitionAmount(netted, { kind: 'amount', amountCents: 5000, studentKey: 's0' }), { error: 'advance-not-allowed' });
});

test('"full" still uses the household balance when there are no bills to add up (unchanged path)', () => {
  // A balance with no itemized invoices behind it (an older provider, or a lookup that returned
  // none) must keep working exactly as before rather than reading as nothing due.
  assert.deepEqual(computeTuitionAmount(session(35000, []), { kind: 'full' }), {
    amountCents: 35000,
    allocations: null,
    students: null,
    lines: null,
  });
});

test('computeTuitionAmount invoices sums the SERVER-side stored amounts (client sends only ids)', () => {
  const s = session(35000, [{ id: 'inv_9', balanceCents: 15000 }, { id: 'inv_10', balanceCents: 20000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9'] }), {
    amountCents: 15000,
    allocations: [{ invoiceId: 'inv_9', amountCents: 15000 }],
    students: [{ studentId: 'stu_1', amountCents: 15000 }],
    lines: null, // this session's bills carry no items (a pre-0.43.0 provider)
  });
});

// v2: Students derives the ledger split from students[], NOT from allocations[] — so a picked invoice
// must carry the child it belongs to or a sibling's older bill gets paid down instead.
test('computeTuitionAmount groups picked invoices per CHILD, summing exactly to the charge', () => {
  const s = session(50000, [
    { id: 'inv_9', balanceCents: 15000, studentId: 'stu_2' },
    { id: 'inv_8', balanceCents: 20000, studentId: 'stu_1' },
    { id: 'inv_7', balanceCents: 15000, studentId: 'stu_2' },
  ]);
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_7', 'inv_8'] });
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.amountCents, 50000);
  assert.deepEqual(r.students, [
    { studentId: 'stu_2', amountCents: 30000 }, // both of Maryam's months, added together
    { studentId: 'stu_1', amountCents: 20000 },
  ]);
  assert.equal(r.students?.reduce((n, x) => n + x.amountCents, 0), r.amountCents);
});

test('computeTuitionAmount drops the split when a provider omitted an invoice\'s child (never a short split)', () => {
  // A partial split sums to less than the charge and Students would reject it with
  // invalid_allocation — better to let it derive one than to fail the record.
  const s = session(35000, [
    { id: 'inv_9', balanceCents: 15000, studentId: 'stu_2' },
    { id: 'inv_8', balanceCents: 20000, studentId: '' },
  ]);
  const r = computeTuitionAmount(s, { kind: 'invoices', invoiceIds: ['inv_9', 'inv_8'] });
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.amountCents, 35000);
  assert.equal(r.students, null);
  assert.equal(r.allocations?.length, 2);
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
    students: [{ studentId: 'stu_1', amountCents: 15000 }],
    lines: null,
  });
});

// ── Advance / part payments (§11.0a) — a typed amount, floored, cap-checked ──
test('a typed amount pays part of a balance, with no breakdown (Students allocates oldest-first)', () => {
  const s = session(35000, [{ id: 'inv_9', balanceCents: 35000 }]);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 10000 }), {
    amountCents: 10000,
    allocations: null,
    students: null,
    lines: null,
  });
});

test('a typed amount may EXCEED the balance — the surplus becomes the child\'s credit', () => {
  const s = session(35000, [{ id: 'inv_9', balanceCents: 35000 }]);
  const r = computeTuitionAmount(s, { kind: 'amount', amountCents: 140000 });
  assert.deepEqual(r, { amountCents: 140000, allocations: null, students: null, lines: null });
});

test('paying ahead with NOTHING due is allowed when the school advertised it', () => {
  const s = session(0, [], { allowAdvance: true });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 50000 }), {
    amountCents: 50000,
    allocations: null,
    students: null,
    lines: null,
  });
});

test('paying ahead is refused when the school did NOT advertise it (an older Students, too)', () => {
  const s = session(0, [], { allowAdvance: false });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 50000 }), { error: 'advance-not-allowed' });
  // …but paying part of a REAL balance never needed that permission.
  const owing = session(35000, [{ id: 'inv_9', balanceCents: 35000 }], { allowAdvance: false });
  assert.equal('amountCents' in computeTuitionAmount(owing, { kind: 'amount', amountCents: 20000 }), true);
});

test('the floor blocks a sub-$1 charge on EVERY path (typed, full balance, picked invoice)', () => {
  const typed = session(35000, [{ id: 'inv_9', balanceCents: 35000 }]);
  assert.deepEqual(computeTuitionAmount(typed, { kind: 'amount', amountCents: 99 }), { error: 'below-min' });
  assert.deepEqual(computeTuitionAmount(typed, { kind: 'amount', amountCents: 0 }), { error: 'no-amount' });
  // A 60c leftover balance costs more in card fees than it collects — let it roll into next month.
  assert.deepEqual(computeTuitionAmount(session(60, [{ id: 'inv_9', balanceCents: 60 }]), { kind: 'full' }), { error: 'below-min' });
  assert.deepEqual(
    computeTuitionAmount(session(60, [{ id: 'inv_9', balanceCents: 60 }]), { kind: 'invoices', invoiceIds: ['inv_9'] }),
    { error: 'below-min' },
  );
});

test('the floor honors a school minimum ABOVE ours, and a typed fortune is capped', () => {
  const s = session(500000, [{ id: 'inv_9', balanceCents: 500000 }], { minAmountCents: 500 });
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 400 }), { error: 'below-min' });
  assert.equal('amountCents' in computeTuitionAmount(s, { kind: 'amount', amountCents: 500 }), true);
  assert.deepEqual(computeTuitionAmount(s, { kind: 'amount', amountCents: 99_999_999 }), { error: 'too-large' });
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
      students: [{ studentId: 'stu_1', amountCents: 15000 }],
    });
    // Not in the retry queue until the charge succeeds (never record a non-succeeded payment).
    assert.equal(s.listPendingTuitionRecords().length, 0);
    s.markTuitionPaid('pi_1', 'succeeded', 'ch_1');
    const pending = s.listPendingTuitionRecords();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].familyId, 'fam_1');
    assert.deepEqual(pending[0].allocations, [{ invoiceId: 'inv_9', amountCents: 15000 }]);
    // The per-child split must survive a restart, or a retried push would be attributed by
    // Students' own oldest-due-first derivation instead of what the parent chose.
    assert.deepEqual(pending[0].students, [{ studentId: 'stu_1', amountCents: 15000 }]);
    // Once recorded in Students it drops out of the queue.
    s.setTuitionRecordStatus('pi_1', 'recorded', 'pay_71');
    assert.equal(s.listPendingTuitionRecords().length, 0);
    assert.equal(s.getTuitionOutbox('pi_1')?.recordStatus, 'recorded');
    assert.equal(s.getTuitionOutbox('pi_1')?.studentsPaymentId, 'pay_71');
  } finally {
    s.close();
  }
});

// ── Who pays Stripe's cut (Students 0.51.0, §11.2) ──────────────────────────
// Off by default and off almost everywhere, so the first thing worth pinning is that OFF changes
// nothing at all. Then the arithmetic, which decides what a parent is charged and therefore gets the
// same treatment as computeTuitionAmount: the contract's own worked examples, verbatim.

const CARD = { percentBps: 290, fixedCents: 30 };
const BANK = { percentBps: 80, fixedCents: 0, capCents: 500 };
const INFO_BASE = { v: 2, enabled: true, schoolName: 'An-Noor', currency: 'usd', tagline: 't' };

test('fee: the contract worked examples, to the cent', () => {
  // §11.2. If any of these three move, a school is being paid the wrong amount.
  assert.deepEqual(grossUpForStudentsFee(10_000, CARD), { grossCents: 10_330, feeCents: 330 });
  assert.deepEqual(grossUpForStudentsFee(25_000, CARD), { grossCents: 25_778, feeCents: 778 });
  assert.deepEqual(grossUpForStudentsFee(200_000, BANK), { grossCents: 200_500, feeCents: 500 });
});

test('fee: the rate applies to the GROSS, not to the tuition', () => {
  // The naive version - tuition * 1.029 + 30 - gives 10320 on a $100 bill. Stripe then takes its cut
  // of THAT, the charge settles at $99.91, the invoice stays 9c open, and the family reads as unpaid
  // for ever over nine cents. This test is that 10c.
  assert.equal(Math.round(10_000 * 1.029) + 30, 10_320);
  assert.equal(grossUpForStudentsFee(10_000, CARD).grossCents, 10_330);

  // The property that actually matters, across a spread: after Stripe takes 2.9% + 30c of the GROSS,
  // the school is never left short of the tuition.
  for (const tuition of [100, 999, 10_000, 25_000, 123_456, 2_000_000]) {
    const { grossCents } = grossUpForStudentsFee(tuition, CARD);
    const stripeTakes = Math.round(grossCents * 0.029) + 30;
    assert.ok(grossCents - stripeTakes >= tuition, `${tuition}: school nets ${grossCents - stripeTakes}, short`);
  }
});

test('fee: rounding is UP, never to nearest', () => {
  // Rounding to nearest leaves the school a cent short half the time - the same open-invoice bug,
  // quieter. The most this can ever over-collect is one cent.
  for (let tuition = 1_000; tuition < 1_100; tuition++) {
    const { grossCents, feeCents } = grossUpForStudentsFee(tuition, CARD);
    const exact = (tuition + CARD.fixedCents) / (1 - CARD.percentBps / 10_000);
    assert.ok(grossCents >= exact - 1e-9, `${tuition}: ${grossCents} is below the exact ${exact}`);
    assert.ok(grossCents - exact < 1 + 1e-9, `${tuition}: ${grossCents} overshot ${exact} by over a cent`);
    assert.equal(grossCents, tuition + feeCents, 'gross is always tuition + fee');
  }
});

test('fee: a cap bounds the FEE, not the gross', () => {
  // Without this a $2,000 payment has $16 added to cover a $5 charge - $11 taken for nothing.
  const uncapped = grossUpForStudentsFee(200_000, { percentBps: 80, fixedCents: 0 });
  assert.ok(uncapped.feeCents > 500, 'the uncapped fee must exceed the cap or this proves nothing');
  assert.deepEqual(grossUpForStudentsFee(200_000, BANK), { grossCents: 200_500, feeCents: 500 });
  const small = grossUpForStudentsFee(10_000, BANK); // below the cap: untouched
  assert.ok(small.feeCents < 500);
  assert.equal(small.grossCents, 10_000 + small.feeCents);
});

test('fee: no rate means add nothing - the default, and the safe direction', () => {
  assert.deepEqual(grossUpForStudentsFee(10_000, null), { grossCents: 10_000, feeCents: 0 });
  // A nonsense rate is refused rather than guessed at: the school absorbs it for that charge, which
  // is exactly today's behavior. The failure can never be "charged something nobody quoted".
  assert.deepEqual(grossUpForStudentsFee(10_000, { percentBps: 10_000, fixedCents: 0 }), { grossCents: 10_000, feeCents: 0 });
  assert.deepEqual(grossUpForStudentsFee(0, CARD), { grossCents: 0, feeCents: 0 });
});

test('fee: enabled:false is off, and an absent fee block is off', async () => {
  // The overwhelmingly common install. Nothing may change: no rate, so no gross-up.
  const off = stubBroker({ ...INFO_BASE, fee: { enabled: false, card: null, bank: null } });
  try {
    const r = await studentsInfo(true);
    assert.equal(r.available && r.info.fee.enabled, false);
    assert.equal(kioskFeeRate(r.available ? r.info : null), null);
  } finally {
    off.restore();
  }
  // An older Students omits `fee` entirely - additive field, contract still v:2.
  const old = stubBroker({ ...INFO_BASE });
  try {
    const r = await studentsInfo(true);
    assert.equal(r.available && r.info.fee.enabled, false);
    assert.equal(kioskFeeRate(r.available ? r.info : null), null);
  } finally {
    old.restore();
  }
});

test('fee: a kiosk quotes the CARD rate and never the bank rate', async () => {
  // A Terminal reader is a card by definition (§11.5). Quoting the cheaper bank rate at a reader
  // would under-collect on every single payment.
  const on = stubBroker({ ...INFO_BASE, fee: { enabled: true, card: CARD, bank: BANK } });
  try {
    const r = await studentsInfo(true);
    assert.ok(r.available);
    assert.deepEqual(kioskFeeRate(r.available ? r.info : null), CARD);
    assert.deepEqual(r.available && r.info.fee.bank, BANK, 'the bank rate is understood...');
    assert.notDeepEqual(kioskFeeRate(r.available ? r.info : null), BANK, '...and then never used');
  } finally {
    on.restore();
  }
});

test('fee: enabled with a null card rate still adds nothing', async () => {
  // `card: null` while enabled means the office is absorbing the card fee. A null is a decision.
  const on = stubBroker({ ...INFO_BASE, fee: { enabled: true, card: null, bank: BANK } });
  try {
    const r = await studentsInfo(true);
    const rate = kioskFeeRate(r.available ? r.info : null);
    assert.equal(rate, null);
    assert.deepEqual(grossUpForStudentsFee(10_000, rate), { grossCents: 10_000, feeCents: 0 });
  } finally {
    on.restore();
  }
});

test('record-payment sends the TUITION in amountCents, with the fee beside it', async () => {
  // The lopsided failure the contract calls out (§11.3): a gross in `amountCents` credits Stripe's
  // cut to the family as an overpayment, which quietly eats into their next bill and compounds for
  // as long as the setting is on. Forgetting the metadata key costs one family a small credit;
  // getting THIS wrong corrupts the ledger until a human notices. When in doubt, send the tuition.
  const rec = stubBroker({ v: 1, recorded: true, paymentId: 'sp_1' });
  try {
    await recordStudentPayment({
      idempotencyKey: 'pi_fee1',
      familyId: 'fam_x1',
      amountCents: 10_000, // the TUITION — what the family owed
      feeCents: 330, // Stripe's cut, which the payer covered on top
      currency: 'USD',
      occurredAt: '2026-08-19T10:00:00Z',
      externalRef: { stripePaymentIntentId: 'pi_fee1' },
    });
    assert.equal(rec.calls[0].body.amountCents, 10_000, 'amountCents is the tuition, never the gross');
    assert.equal(rec.calls[0].body.feeCents, 330);
  } finally {
    rec.restore();
  }
});

test('record-payment omits feeCents entirely when the school absorbed the fee', async () => {
  // The common path. An absent key is cleaner than a zero and says the same thing.
  const rec = stubBroker({ v: 1, recorded: true, paymentId: 'sp_2' });
  try {
    await recordStudentPayment({
      idempotencyKey: 'pi_fee2',
      familyId: 'fam_x1',
      amountCents: 10_000,
      currency: 'USD',
      occurredAt: '2026-08-19T10:00:00Z',
      externalRef: { stripePaymentIntentId: 'pi_fee2' },
    });
    assert.equal('feeCents' in rec.calls[0].body, false);
  } finally {
    rec.restore();
  }
});

test('a tuition session pins the rate it was quoted at', () => {
  // `info` is cached and an office can change the rate mid-session. Reading it again at charge time
  // could hand a parent a total they were never shown, so the session holds the rate the quote was
  // made with and the charge uses that copy.
  const s = createTuitionSession({
    campaignId: 'c1',
    deviceId: 'd1',
    familyId: 'fam_x1',
    studentId: 'stu_1',
    familyLabel: 'The Yusuf family',
    currency: 'USD',
    balanceCents: 10_000,
    creditCents: 0,
    allowAdvance: false,
    minAmountCents: 100,
    feeRate: CARD,
    students: [{ studentId: 'stu_1', name: 'Yusuf A', balanceCents: 10_000, creditCents: 0 }],
    invoices: [{ id: 'inv_1', balanceCents: 10_000, studentId: 'stu_1', items: [] }],
  });
  const held = getTuitionSession(s.id);
  assert.deepEqual(held?.feeRate, CARD);
  // And the charge computed from it is the quoted one.
  const amt = computeTuitionAmount(held!, { kind: 'full' });
  assert.ok(!('error' in amt));
  if (!('error' in amt)) {
    assert.equal(amt.amountCents, 10_000, 'the tuition is unchanged by the fee — it is added on top');
    assert.deepEqual(grossUpForStudentsFee(amt.amountCents, held!.feeRate), { grossCents: 10_330, feeCents: 330 });
  }
});
