// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * OpenMasjid Students billing — the `tuition` campaign type talks to the OpenMasjid Students app
 * through the OpenMasjidOS Fabric app-to-app broker (never to Students directly). Contract:
 * `students/billing` v2 — authoritative source
 * `OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` §11 (also docs/STUDENTS_INTEGRATION.md).
 *
 * CONTRACT v2 (Students 0.39.0, §11.0) — the PIN is gone. `lookup` no longer takes `name` + `pin`; it
 * takes the **Student ID** alone (`YUS1234` — 3 letters + 4 digits, printed on the statement), and a
 * v1-shaped lookup now 400s, so this is not optional. What replaces the PIN is the new `identify`
 * method: we resolve the typed ID to a first name, the parent confirms "yes, that's my child" on the
 * tablet, and only then do we call `lookup` for the balance. Bills are also per STUDENT at v2, so the
 * open invoices come back tagged with the child they belong to.
 *
 * `info`, `record-payment` and `check` are byte-identical between v1 and v2 and are deliberately still
 * sent as `v: 1` (the provider accepts both) — the money path must not hinge on this upgrade.
 *
 * Transport: our backend POSTs
 *   ${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>
 * with OUR OWN per-app secret in `X-OpenMasjid-App-Secret`. The OS core verifies our secret + that our
 * manifest declares `fabric.consumes: [students/billing]`, then proxies to the Students app (injecting
 * the target's own secret + `X-OpenMasjid-Caller-App`). We never hold the Students secret and never
 * reach the app directly.
 *
 * FAIL-SOFT DOCTRINE (required of consumers): every broker error (`fabric_error`: target_not_installed /
 * target_unreachable / timeout / not_granted / rate_limited, or any network fault) means "tuition
 * unavailable, the rest of the kiosk is fine" — never a crash. A tuition tile hides itself / shows a
 * friendly notice when unavailable.
 *
 * SECURITY: the Student ID is INERT input — sent in the JSON body only, NEVER put in a URL, a log line,
 * Stripe metadata, a description, or a receipt, and never stored. (It is not a secret — it is printed
 * on statements — but it is the whole credential for "see a balance and pay it", so it gets the same
 * handling the PIN had.) We log method names only, never request/response bodies. Secrets are read from
 * env every start (config.ts), never persisted.
 *
 * This mirrors OpenMasjidDonations/server/src/students.ts almost verbatim; the kiosk differences are the
 * `channel: 'kiosk'` on record-payment and that the charge is card-present (Stripe Terminal reader) —
 * everything server-side (broker client, session, amount math) is identical.
 */
import crypto from 'node:crypto';
import { config } from './config';
import { makeLog } from './logger';

const log = makeLog('students');

const BILLING_PATH = 'students/billing'; // <target-app-id>/<capability> — the broker route + our grant

/** Request `v` for the two methods whose SHAPE changed at v2 (Student ID, no PIN — §11.0). */
const V_STUDENT_ID = 2;
/** Request `v` for the money path (`info`, `record-payment`, `check`) — unchanged between v1 and v2 and
 *  still accepted as v1 by the provider, so a Students downgrade can never strand a recorded payment. */
const V_MONEY = 1;

/** True when the Fabric is available (embedded under OpenMasjidOS with our per-app secret). */
export function billingConfigured(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

// ── Low-level broker call ───────────────────────────────────────────────────
type BrokerOk = { ok: true; data: Record<string, unknown> };
/** The broker/platform/target couldn't be reached, or refused us → fail soft (hide tuition). */
type BrokerUnavailable = { ok: false; unavailable: true; code: string };
/** The Students app itself answered with an app-level error (e.g. family_not_found) — a real,
 *  usually-permanent outcome we can act on (surface / stop retrying), not a transient outage. */
type BrokerAppError = { ok: false; unavailable: false; code: string; message: string };
type BrokerResult = BrokerOk | BrokerUnavailable | BrokerAppError;

async function brokerCall(method: string, body: Record<string, unknown>, v: number = V_MONEY): Promise<BrokerResult> {
  if (!billingConfigured()) return { ok: false, unavailable: true, code: 'no-fabric' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000); // contract: respond < 10 s
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/app/${BILLING_PATH}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ v, ...body }), // every request carries its method's contract version
      signal: ctrl.signal,
      redirect: 'error', // never follow a redirect to some other host
    });
    clearTimeout(t);
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // Broker-generated failure envelope (target_not_installed, timeout, not_granted, …) → fail soft.
    if (j && typeof j === 'object' && j.fabric_error && typeof j.fabric_error === 'object') {
      const code = (j.fabric_error as { code?: unknown }).code;
      return { ok: false, unavailable: true, code: typeof code === 'string' ? code : 'fabric_error' };
    }
    if (!res.ok) {
      // App-level error the target authored: { error: { code, message } }.
      const e = j && typeof j.error === 'object' && j.error ? (j.error as { code?: unknown; message?: unknown }) : null;
      if (e) {
        return { ok: false, unavailable: false, code: typeof e.code === 'string' ? e.code : 'error', message: typeof e.message === 'string' ? e.message : '' };
      }
      return { ok: false, unavailable: true, code: `http_${res.status}` }; // unrecognised non-2xx → fail soft
    }
    if (!j || typeof j !== 'object') return { ok: false, unavailable: true, code: 'bad_response' };
    return { ok: true, data: j };
  } catch (err) {
    // Message only (never the body) — the body carries the Student ID + family data.
    log.debug(`students/billing ${method} unreachable: ${err instanceof Error ? err.message : 'error'}`);
    return { ok: false, unavailable: true, code: 'unreachable' };
  }
}

// ── Small coercion helpers (never trust the provider's response blindly) ────
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').slice(0, max);
const intNonNeg = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// ── info ────────────────────────────────────────────────────────────────────
export interface StudentsInfo {
  enabled: boolean;
  schoolName: string;
  currency: string;
  tagline: string;
}
export type InfoResult = { available: true; info: StudentsInfo } | { available: false };

function parseInfo(d: Record<string, unknown>): StudentsInfo {
  return {
    enabled: d.enabled === true,
    schoolName: str(d.schoolName, 120),
    currency: str(d.currency, 10).toUpperCase(),
    tagline: str(d.tagline, 200),
  };
}

// Cache info so rendering the tile doesn't hit the broker every load. A good copy lasts ~5 min; an
// "unavailable" answer is cached only briefly so we recover fast.
let infoCache: { at: number; value: InfoResult } | null = null;
const INFO_OK_MS = 5 * 60_000;
const INFO_BAD_MS = 30_000;

export async function studentsInfo(force = false): Promise<InfoResult> {
  const now = Date.now();
  if (!force && infoCache) {
    const ttl = infoCache.value.available ? INFO_OK_MS : INFO_BAD_MS;
    if (now - infoCache.at < ttl) return infoCache.value;
  }
  const r = await brokerCall('info', {});
  const value: InfoResult = r.ok ? { available: true, info: parseInfo(r.data) } : { available: false };
  infoCache = { at: now, value };
  return value;
}

/** Last cached info without a network call — for cheap sync paths. */
export function cachedStudentsInfo(): InfoResult {
  return infoCache?.value ?? { available: false };
}

// ── Student ID (the whole credential at v2) ─────────────────────────────────
/** Normalise a typed Student ID exactly as the provider does (trim, uppercase, drop the spaces and
 *  hyphens a parent might add), so "yus-1234" and "YUS 1234" reach it as `YUS1234`. The provider
 *  normalises again on its side — we do it here so what we send, cap and compare is one canonical form. */
export function normalizeStudentCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}

// ── identify (Student ID → "is this the right child?") ──────────────────────
/** The one disclosure `identify` makes: a first name + a last initial (§11.2 — no balance, no
 *  invoices, no siblings, not even the family id). It is what the parent confirms before any money
 *  or balance appears — the confirmation step that replaced the PIN. */
export interface IdentifiedStudent {
  studentCode: string;
  firstName: string;
  lastInitial: string;
}
export type IdentifyResult =
  | { status: 'found'; student: IdentifiedStudent }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/** Resolve a typed Student ID to the child's first name so the kiosk can ask "is this Yusuf?".
 *  Uniform `not-found` for an unknown/withdrawn/locked ID or tuition switched off — no enumeration
 *  oracle, and never a hint about which part was wrong. */
export async function studentsIdentify(studentCode: string): Promise<IdentifyResult> {
  const code = normalizeStudentCode(studentCode);
  if (!code) return { status: 'not-found' };
  const r = await brokerCall('identify', { studentCode: code }, V_STUDENT_ID);
  if (r.ok) {
    if (r.data.found === true) {
      const s = r.data.student && typeof r.data.student === 'object' ? (r.data.student as Record<string, unknown>) : null;
      const firstName = str(s?.firstName, 60);
      if (!firstName) return { status: 'unavailable' }; // "found" with nothing to confirm → don't guess
      return {
        status: 'found',
        student: { studentCode: str(s?.studentCode, 32) || code, firstName, lastInitial: str(s?.lastInitial, 4) },
      };
    }
    return { status: 'not-found' };
  }
  // Fail soft on every broker/app error: "temporarily unavailable", never "wrong ID".
  return { status: 'unavailable' };
}

// ── lookup (Student ID → family + balance) ──────────────────────────────────
export interface StudentInvoice {
  id: string;
  label: string;
  dueDate: string;
  balanceCents: number;
  /** v2: whose bill this is. SERVER-SIDE ONLY (never sent to the tablet) — it is what lets us tell
   *  Students the per-child split of a "choose what to pay" charge. */
  studentId: string;
  /** The same child as a display name, resolved from the family's student list, so a family with two
   *  children doesn't see two identical "Tuition — Jul 2026" rows with no way to tell them apart.
   *  Blank for an only child (nothing to disambiguate). */
  studentName: string;
}
export interface StudentFamily {
  id: string;
  label: string;
  /** v2 adds a per-child `balanceCents` (and the sibling's own id/code, which stay server-side). */
  students: { firstName: string; lastInitial: string; balanceCents: number }[];
  balanceCents: number;
  currency: string;
  openInvoices: StudentInvoice[];
}
export type LookupResult =
  | { status: 'found'; matchedStudentId: string; family: StudentFamily }
  | { status: 'not-found' }
  | { status: 'unavailable' };

function parseFamily(d: Record<string, unknown>): StudentFamily | null {
  const f = d.family && typeof d.family === 'object' ? (d.family as Record<string, unknown>) : null;
  if (!f) return null;
  const id = str(f.id, 128);
  if (!id) return null; // no family id = unusable for the pay step
  const studentsRaw = Array.isArray(f.students) ? f.students : [];
  const kids = studentsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .slice(0, 40)
    .map((s) => ({
      // Held only to label this family's invoices — the internal id never leaves the server.
      studentId: str(s.studentId, 128),
      firstName: str(s.firstName, 60),
      lastInitial: str(s.lastInitial, 4),
      balanceCents: intNonNeg(s.balanceCents),
    }));
  const nameOf = new Map(kids.filter((k) => k.studentId).map((k) => [k.studentId, k.firstName]));
  const invRaw = Array.isArray(f.openInvoices) ? f.openInvoices : [];
  const openInvoices = invRaw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .slice(0, 60)
    .map((i) => {
      const studentId = str(i.studentId, 128);
      return {
        id: str(i.id, 128),
        label: str(i.label, 120),
        dueDate: str(i.dueDate, 40),
        balanceCents: intNonNeg(i.balanceCents),
        studentId,
        // Only worth showing when there is more than one child to tell apart.
        studentName: kids.length > 1 ? (nameOf.get(studentId) ?? '') : '',
      };
    })
    .filter((i) => i.id); // an invoice with no id can't be paid specifically
  return {
    id,
    label: str(f.label, 120),
    students: kids.map(({ firstName, lastInitial, balanceCents }) => ({ firstName, lastInitial, balanceCents })),
    balanceCents: intNonNeg(f.balanceCents),
    currency: str(f.currency, 10).toUpperCase(),
    openInvoices,
  };
}

/** Resolve a Student ID to a family + balance (v2 — no name, no PIN). The ID is sent in the body only
 *  and is NEVER logged. `not-found` is uniform (the provider answers identically for an unknown,
 *  withdrawn or locked ID — no enumeration oracle).
 *
 *  Per §11.2 the kiosk must call [studentsIdentify] FIRST and have the parent confirm the child's name;
 *  that confirmation, not a shared secret, is what stops a mistyped ID from paying a stranger's bill. */
export async function studentsLookup(studentCode: string): Promise<LookupResult> {
  const code = normalizeStudentCode(studentCode);
  if (!code) return { status: 'not-found' };
  const r = await brokerCall('lookup', { studentCode: code }, V_STUDENT_ID);
  if (r.ok) {
    if (r.data.found === true) {
      const family = parseFamily(r.data);
      if (!family) return { status: 'unavailable' }; // malformed "found" payload → don't guess
      const matchedStudentId = str((r.data.matchedStudent as { id?: unknown } | undefined)?.id, 128);
      return { status: 'found', matchedStudentId, family };
    }
    return { status: 'not-found' };
  }
  // Any broker/app error on a lookup is treated as unavailable (fail soft) — a transient outage, or a
  // Students build older than 0.39.0 that 400s this v2 shape, must never read as "wrong Student ID".
  return { status: 'unavailable' };
}

// ── record-payment (book it in the Students ledger; idempotent) ─────────────
export interface RecordPaymentInput {
  idempotencyKey: string; // = the Stripe PaymentIntent id
  familyId: string;
  studentId?: string;
  amountCents: number;
  currency: string;
  occurredAt: string;
  externalRef: { stripePaymentIntentId: string; stripeChargeId?: string; stripeAccountId?: string };
  /** One entry per paid invoice; omit for "pay full balance" (Students auto-allocates). */
  allocations?: { invoiceId: string; amountCents: number }[];
  /** v2 (§11.2): the per-CHILD split of this one charge — must sum exactly to `amountCents`.
   *
   *  This is what makes "choose what to pay" land on the right child's ledger. Bills are per student
   *  at v2 and Students 0.39.0 derives the split from THIS field; when it is absent it walks the whole
   *  family's open invoices oldest-due-first, which for a picked-invoice charge can book Maryam's
   *  July bill against Yusuf's older one (the money is right, the attribution isn't). Omit it for
   *  "pay the full balance", where oldest-due-first across the family is exactly what was asked for. */
  students?: { studentId: string; amountCents: number }[];
}
export type RecordResult =
  | { status: 'recorded'; paymentId: string; duplicate: boolean }
  | { status: 'unavailable' } // transient → retry via the outbox
  | { status: 'rejected'; code: string }; // permanent app error → stop; Students' reconciliation is the backstop

export async function recordStudentPayment(input: RecordPaymentInput): Promise<RecordResult> {
  const body: Record<string, unknown> = {
    idempotencyKey: input.idempotencyKey,
    familyId: input.familyId,
    amountCents: input.amountCents,
    currency: input.currency.toLowerCase(),
    channel: 'kiosk',
    occurredAt: input.occurredAt,
    externalRef: input.externalRef,
  };
  if (input.studentId) body.studentId = input.studentId;
  if (input.allocations && input.allocations.length) body.allocations = input.allocations;
  const perChild = input.students && input.students.length ? input.students : null;
  if (perChild) body.students = perChild;
  // Stay on v:1 by default (the shape is identical at both versions, so the money path survives a
  // Students downgrade). Only a charge that actually carries the v2-only `students[]` announces v:2 —
  // and such a split can only exist after a v2 lookup, so the provider is 0.39.0+ by construction.
  const r = await brokerCall('record-payment', body, perChild ? V_STUDENT_ID : V_MONEY);
  if (r.ok) {
    if (r.data.recorded === true) {
      return { status: 'recorded', paymentId: str(r.data.paymentId, 128), duplicate: r.data.duplicate === true };
    }
    return { status: 'unavailable' }; // 200 but not recorded — treat as transient, retry
  }
  if (!r.unavailable) return { status: 'rejected', code: r.code }; // family_not_found / invalid_allocation → permanent
  return { status: 'unavailable' };
}

// ── check (outbox retry helper) ─────────────────────────────────────────────
export type CheckResult = { status: 'recorded'; paymentId: string } | { status: 'not-recorded' } | { status: 'unavailable' };

export async function checkStudentPayment(idempotencyKey: string): Promise<CheckResult> {
  const r = await brokerCall('check', { idempotencyKey });
  if (r.ok) {
    if (r.data.recorded === true) return { status: 'recorded', paymentId: str(r.data.paymentId, 128) };
    return { status: 'not-recorded' };
  }
  return { status: 'unavailable' };
}

// ── Server-side tuition session (so the client never dictates the family or amount) ──
// On a successful lookup we stash the family + its open invoices here, keyed by a random 128-bit id
// handed to the tablet. At pay time the tablet sends only that id + which invoices it wants (or "full")
// — we recompute the amount + the familyId SERVER-SIDE from this stash, so a crafted request can't
// attribute a charge to an arbitrary family or pay a tampered amount. Short-lived + in-memory only
// (nothing about a lookup is persisted).
export interface TuitionSession {
  id: string;
  campaignId: string;
  deviceId: string;
  familyId: string;
  studentId: string;
  familyLabel: string;
  currency: string;
  balanceCents: number;
  /** `studentId` is held here (never handed to the tablet) so a picked-invoice charge can tell
   *  Students which child each pound belongs to — see RecordPaymentInput.students. */
  invoices: { id: string; balanceCents: number; studentId: string }[];
  expires: number;
}

const sessions = new Map<string, TuitionSession>();
const SESSION_TTL_MS = 15 * 60_000;
const SESSION_MAX = 2000;

export function createTuitionSession(input: Omit<TuitionSession, 'id' | 'expires'>): TuitionSession {
  const now = Date.now();
  if (sessions.size > SESSION_MAX) {
    for (const [k, v] of sessions) if (v.expires <= now) sessions.delete(k);
  }
  const s: TuitionSession = { ...input, id: crypto.randomBytes(16).toString('hex'), expires: now + SESSION_TTL_MS };
  sessions.set(s.id, s);
  return s;
}

export function getTuitionSession(id: string): TuitionSession | null {
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expires <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return s;
}

/** Drop a session once it has been used to mint a PaymentIntent (single-use for the pay step). */
export function consumeTuitionSession(id: string): void {
  sessions.delete(id);
}

// ── Amount computation (PURE — the security-critical bit; unit-tested) ──────
export type TuitionSelection = { kind: 'full' } | { kind: 'invoices'; invoiceIds: string[] };
export type AmountResult =
  | {
      amountCents: number;
      allocations: { invoiceId: string; amountCents: number }[] | null;
      /** The same charge grouped per CHILD (v2 §11.2) — null for "pay the full balance". */
      students: { studentId: string; amountCents: number }[] | null;
    }
  | { error: string };

/** Compute the charge amount + allocations + the per-child split from the SERVER-side session, never
 *  the client's numbers.
 *
 *  "full" pays the whole balance and omits both breakdowns — Students then auto-allocates
 *  oldest-due-first across the family, which is exactly what "pay everything" means. Otherwise we pay
 *  exactly the chosen open invoices at their stored amounts, and group them by child: Students 0.39.0
 *  derives the ledger split from `students[]` (it does not read `allocations[]`), so without this a
 *  picked invoice can be booked against a sibling's older bill. We still send `allocations[]` — the
 *  contract still documents it and a later Students may honour it again. */
export function computeTuitionAmount(session: TuitionSession, selection: TuitionSelection): AmountResult {
  if (selection.kind === 'full') {
    if (session.balanceCents <= 0) return { error: 'nothing-due' };
    return { amountCents: session.balanceCents, allocations: null, students: null };
  }
  const ids = [...new Set(selection.invoiceIds)];
  if (!ids.length) return { error: 'no-selection' };
  const allocations: { invoiceId: string; amountCents: number }[] = [];
  const perChild = new Map<string, number>();
  let sum = 0;
  for (const id of ids) {
    const inv = session.invoices.find((i) => i.id === id);
    if (!inv || inv.balanceCents <= 0) return { error: 'unknown-invoice' };
    allocations.push({ invoiceId: id, amountCents: inv.balanceCents });
    if (inv.studentId) perChild.set(inv.studentId, (perChild.get(inv.studentId) ?? 0) + inv.balanceCents);
    sum += inv.balanceCents;
  }
  if (sum <= 0) return { error: 'nothing-due' };
  // Only send a split we can vouch for: it must cover the whole charge to the penny, or Students
  // rejects it with `invalid_allocation` (§11.2). A provider that omitted an invoice's studentId
  // leaves us short — drop the split and let Students derive it rather than fail the record.
  const students = [...perChild].map(([studentId, amountCents]) => ({ studentId, amountCents }));
  const covered = students.reduce((n, s) => n + s.amountCents, 0);
  return { amountCents: sum, allocations, students: covered === sum && students.length ? students : null };
}
