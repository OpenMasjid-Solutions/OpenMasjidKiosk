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
 * ITEMISED BILLS (Students 0.43.0, §11.0b — additive, still `v: 2`). A bill is no longer one label and
 * one number: `lookup` now says what each invoice is MADE OF (`items[]` — "Monthly tuition £200",
 * "Book fee £50"), and `record-payment` takes `lines[]` — the exact lines the parent ticked. Unlike the
 * per-child `students[]` split, `lines` is HONOURED rather than merely accepted: the ticked line is the
 * one that ends up settled and stays settled when Students recomputes its allocations. `lines`
 * supersedes `students[]` (a line already says whose bill it is), so we send one or the other, never
 * both. We can only ever build `lines` from ids a lookup just handed us, which is itself proof the
 * provider is 0.43.0+ — an older Students simply returns no `items[]` and we keep the invoice-level
 * behaviour, so this is safe to run against any provider version.
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
/** A SIGNED money field, bounded. Only a bill line's `amountCents` needs this: a credit line (a bursary,
 *  a correction) is negative, and clamping it to zero would render "Bursary £0" on the bill. */
const intSigned = (v: unknown): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_TUITION_CENTS, Math.min(MAX_TUITION_CENTS, n));
};

// ── info ────────────────────────────────────────────────────────────────────
/** Our own floor, whatever the school advertises: a card-present charge under a pound/dollar costs
 *  more in card fees than it collects, and a mis-tap on the pad shouldn't be able to mint one. */
export const MIN_TUITION_CENTS = 100;
/** A sanity ceiling on a TYPED advance so a slipped finger can't charge $200,000 at a foyer kiosk.
 *  Generous enough for a family clearing a year for several children in one go. */
export const MAX_TUITION_CENTS = 2_000_000;

export interface StudentsInfo {
  enabled: boolean;
  schoolName: string;
  currency: string;
  tagline: string;
  /** 0.41.0 (§11.0a): the school takes money when NOTHING is due — a term up front, the year in one
   *  go. Absent on an older Students, and then deliberately false: a consumer cannot tell "nothing
   *  due" from "cannot pay here" on its own, so paying ahead is offered only when advertised. */
  allowAdvance: boolean;
  /** The floor for a typed amount, never below [MIN_TUITION_CENTS]. */
  minAmountCents: number;
}
export type InfoResult = { available: true; info: StudentsInfo } | { available: false };

function parseInfo(d: Record<string, unknown>): StudentsInfo {
  return {
    enabled: d.enabled === true,
    schoolName: str(d.schoolName, 120),
    currency: str(d.currency, 10).toUpperCase(),
    tagline: str(d.tagline, 200),
    allowAdvance: d.allowAdvance === true,
    // Take the stricter of the school's floor and ours — never let a provider lower it below a pound.
    minAmountCents: Math.max(MIN_TUITION_CENTS, intNonNeg(d.minAmountCents)),
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
/** One LINE of a bill (0.43.0, §11.0b) — "Monthly tuition £200", "Book fee £50", "Bursary −£30".
 *  A February bill is routinely tuition plus a one-off, and a parent asking to pay just the book fee
 *  could not be served while a bill was one label and one number. */
export interface StudentInvoiceItem {
  id: string;
  label: string;
  /** `tuition` | `charge` | `credit`, treated as an OPEN set: an unrecognised kind is rendered as a
   *  plain line, never dropped — dropping one would make the lines stop adding up to the bill. */
  kind: string;
  /** What the line costs. SIGNED — a credit line is negative. Display only; never charged from. */
  amountCents: number;
  /** What is still payable on this line. Always ≥ 0; 0 for a settled line AND for a credit line
   *  (its value is already deducted from the lines above it), so summing what the parent ticked is
   *  safe with no special case. */
  balanceCents: number;
}
export interface StudentInvoice {
  id: string;
  label: string;
  dueDate: string;
  balanceCents: number;
  /** The lines this bill is made of (0.43.0). EMPTY on an older Students — and also emptied here if
   *  the lines don't add up to the bill, since a list that doesn't reconcile is worse than no list and
   *  a `lines[]` built from it would be rejected by the provider for not summing to the charge. */
  items: StudentInvoiceItem[];
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
  /** v2 adds a per-child `balanceCents` (and the sibling's own internal id, which never leaves the
   *  server — the tablet gets a per-session key instead); 0.41.0 adds that child's `creditCents`. */
  students: { studentId: string; firstName: string; lastInitial: string; balanceCents: number; creditCents: number }[];
  balanceCents: number;
  /** 0.41.0 (§11.0a): money already paid ahead. At most one of balance/credit is ever non-zero, and
   *  a zero balance is otherwise ambiguous — square, paid ahead, or "you can't pay here". */
  creditCents: number;
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
      creditCents: intNonNeg(s.creditCents),
    }));
  const nameOf = new Map(kids.filter((k) => k.studentId).map((k) => [k.studentId, k.firstName]));
  const invRaw = Array.isArray(f.openInvoices) ? f.openInvoices : [];
  const openInvoices = invRaw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .slice(0, 60)
    .map((i) => {
      const studentId = str(i.studentId, 128);
      const balanceCents = intNonNeg(i.balanceCents);
      const itemsRaw = Array.isArray(i.items) ? i.items : [];
      const items = itemsRaw
        .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
        .slice(0, 40)
        .map((it) => ({
          id: str(it.id, 128),
          label: str(it.label, 120),
          kind: str(it.kind, 20).toLowerCase(),
          amountCents: intSigned(it.amountCents),
          balanceCents: intNonNeg(it.balanceCents),
        }))
        .filter((it) => it.id);
      // The contract's one arithmetic guarantee: the lines add up to the bill (§11.0b). We verify it
      // rather than assume it, because everything downstream leans on it — a `lines[]` that doesn't
      // sum to the charge is a 422 from the provider, and a list that doesn't reconcile on screen is
      // worse than showing none. If it doesn't hold (an item we had to drop for a missing id, a
      // provider bug), fall back to the pre-0.43.0 whole-bill behaviour for this invoice.
      const covered = items.reduce((n, it) => n + it.balanceCents, 0);
      const usable = items.length > 0 && covered === balanceCents;
      return {
        id: str(i.id, 128),
        label: str(i.label, 120),
        dueDate: str(i.dueDate, 40),
        balanceCents,
        items: usable ? items : [],
        studentId,
        // Only worth showing when there is more than one child to tell apart.
        studentName: kids.length > 1 ? (nameOf.get(studentId) ?? '') : '',
      };
    })
    .filter((i) => i.id); // an invoice with no id can't be paid specifically
  return {
    id,
    label: str(f.label, 120),
    students: kids.map(({ studentId, firstName, lastInitial, balanceCents, creditCents }) => ({ studentId, firstName, lastInitial, balanceCents, creditCents })),
    balanceCents: intNonNeg(f.balanceCents),
    creditCents: intNonNeg(f.creditCents),
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
  /** 0.43.0 (§11.0b): the exact BILL LINES the parent ticked — must sum to `amountCents`, and every
   *  id must come from a lookup in this session. Supersedes `students[]` (a line already says whose
   *  bill it is), so the two are never sent together. This one is honoured, not merely accepted: the
   *  book fee a parent deliberately paid still reads settled on next month's statement. */
  lines?: { itemId: string; amountCents: number }[];
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
  // `lines` supersedes both other breakdowns (§11.0b), so a charge that has them sends ONLY them —
  // the provider prefers lines > allocations > students, and sending two that could disagree leaves
  // the wire saying two different things about the same money.
  const lines = input.lines && input.lines.length ? input.lines : null;
  const perChild = !lines && input.students && input.students.length ? input.students : null;
  if (lines) body.lines = lines;
  else {
    if (input.allocations && input.allocations.length) body.allocations = input.allocations;
    if (perChild) body.students = perChild;
  }
  // Stay on v:1 by default (the shape is identical at both versions, so the money path survives a
  // Students downgrade). Only a charge that actually carries a v2-era breakdown announces v:2 — and
  // either one can only exist after a v2 lookup, so the provider is new enough by construction.
  const r = await brokerCall('record-payment', body, lines || perChild ? V_STUDENT_ID : V_MONEY);
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
  /** Money already paid ahead at lookup time — display only; it never reduces a charge (the school's
   *  ledger absorbs credit against the next invoice, we don't net it off here). */
  creditCents: number;
  /** Whether the school takes money when nothing is due, and the floor for a typed amount. Captured
   *  from `info` at lookup time so the pay step validates against the SERVER's copy, not the tablet's. */
  allowAdvance: boolean;
  minAmountCents: number;
  /** The family's children, in the order the tablet renders them. Their internal ids stay HERE: the
   *  tablet addresses a child by its position (`s0`, `s1`, … — see [studentKey]), which is what lets
   *  "add £50 for Maryam" name the right ledger without ever handing an id to a device. */
  students: { studentId: string; name: string; balanceCents: number; creditCents: number }[];
  /** `studentId` is held here (never handed to the tablet) so a picked-invoice charge can tell
   *  Students which child each pound belongs to — see RecordPaymentInput.students. `items` is the
   *  bill's lines (0.43.0; empty on an older Students), which is what a ticked "Book fee" resolves
   *  against — see RecordPaymentInput.lines. */
  invoices: { id: string; balanceCents: number; studentId: string; items: { id: string; balanceCents: number }[] }[];
  expires: number;
}

/** The handle the TABLET uses for a child: its position in the session's student list. Deliberately
 *  not the real `studentId` — a kiosk in a foyer has no business holding the school's internal ids,
 *  and a key is only meaningful inside the one short-lived session that minted it. */
export function studentKey(index: number): string {
  return `s${index}`;
}

function studentByKey(session: TuitionSession, key: string): { studentId: string; balanceCents: number } | null {
  const m = /^s(\d{1,3})$/.exec(key);
  if (!m) return null;
  return session.students[Number(m[1])] ?? null;
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
export type TuitionSelection =
  | { kind: 'full' }
  | { kind: 'invoices'; invoiceIds: string[] }
  /** Ticked BILL LINES (0.43.0) — "just the book fee". The precise selection, when the provider gave
   *  us items to tick; `invoices` remains for a provider that didn't. */
  | { kind: 'items'; itemIds: string[] }
  /** A typed amount: a part payment against what's owed, or money paid AHEAD (§11.0a). `studentKey`
   *  names WHICH child it belongs to — with one ledger per child, "add £50" has to say for whom. */
  | { kind: 'amount'; amountCents: number; studentKey?: string };
export type AmountResult =
  | {
      amountCents: number;
      allocations: { invoiceId: string; amountCents: number }[] | null;
      /** The same charge grouped per CHILD (v2 §11.2) — null for "pay the full balance", and null
       *  whenever `lines` is set (lines supersede it; §11.0b). */
      students: { studentId: string; amountCents: number }[] | null;
      /** The exact bill lines being paid (0.43.0) — null when the provider gave us no items to tick. */
      lines: { itemId: string; amountCents: number }[] | null;
      /** The child this charge is FOR, when the parent picked one, overriding the session's matched
       *  student on record-payment so a surplus lands as that child's credit. */
      studentId?: string;
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
    if (session.balanceCents < session.minAmountCents) return { error: 'below-min' };
    return { amountCents: session.balanceCents, allocations: null, students: null, lines: null };
  }
  if (selection.kind === 'amount') {
    // A TYPED amount — the advance/part-payment path (§11.0a). No line breakdown is possible (there is
    // nothing ticked to point it at): Students walks the child's open invoices oldest-due-first and
    // holds anything beyond them as that child's credit, which is exactly "pay $1,400 against a $350
    // month and settle the next three too".
    const amountCents = Math.trunc(selection.amountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return { error: 'no-amount' };
    // The floor is the SERVER's copy from `info`, never a number the tablet sent.
    if (amountCents < session.minAmountCents) return { error: 'below-min' };
    if (amountCents > MAX_TUITION_CENTS) return { error: 'too-large' };
    // A named child (the "add money for Maryam" button) is sent as a one-entry per-child split, so the
    // credit lands on HER ledger rather than being walked across the household oldest-due-first.
    const kid = selection.studentKey ? studentByKey(session, selection.studentKey) : null;
    if (selection.studentKey && !kid) return { error: 'unknown-student' };
    // Paying ahead is only offered when the school advertised it; paying part of a real balance is
    // always fine, so an amount within what's owed needs no such permission. The ceiling is the chosen
    // child's balance when there is one — £50 for a child who owes nothing is an advance even in a
    // household that owes £200.
    const ceiling = kid ? kid.balanceCents : session.balanceCents;
    if (amountCents > ceiling && !session.allowAdvance) return { error: 'advance-not-allowed' };
    return kid
      ? { amountCents, allocations: null, students: [{ studentId: kid.studentId, amountCents }], lines: null, studentId: kid.studentId }
      : { amountCents, allocations: null, students: null, lines: null };
  }
  if (selection.kind === 'items') {
    // Ticked BILL LINES (§11.0b) — the one selection the provider honours exactly, so the book fee a
    // parent chose stays settled instead of sliding onto the oldest unpaid bill next month.
    const itemIds = [...new Set(selection.itemIds)];
    if (!itemIds.length) return { error: 'no-selection' };
    const byId = new Map<string, number>();
    for (const inv of session.invoices) for (const it of inv.items) byId.set(it.id, it.balanceCents);
    const lines: { itemId: string; amountCents: number }[] = [];
    let total = 0;
    for (const id of itemIds) {
      const bal = byId.get(id);
      // Unknown, settled or credit lines are refused rather than silently skipped: a charge that
      // quietly differs from what the parent ticked is the failure this whole field exists to end.
      if (bal === undefined || bal <= 0) return { error: 'unknown-item' };
      lines.push({ itemId: id, amountCents: bal });
      total += bal;
    }
    if (total <= 0) return { error: 'nothing-due' };
    if (total < session.minAmountCents) return { error: 'below-min' };
    return { amountCents: total, allocations: null, students: null, lines };
  }
  const ids = [...new Set(selection.invoiceIds)];
  if (!ids.length) return { error: 'no-selection' };
  const allocations: { invoiceId: string; amountCents: number }[] = [];
  const perChild = new Map<string, number>();
  const wholeBillLines: { itemId: string; amountCents: number }[] = [];
  let everyBillItemised = true;
  let sum = 0;
  for (const id of ids) {
    const inv = session.invoices.find((i) => i.id === id);
    if (!inv || inv.balanceCents <= 0) return { error: 'unknown-invoice' };
    allocations.push({ invoiceId: id, amountCents: inv.balanceCents });
    if (inv.studentId) perChild.set(inv.studentId, (perChild.get(inv.studentId) ?? 0) + inv.balanceCents);
    // "Pay this whole bill" is expressible as its lines when the provider gave us any, and saying it
    // that way is strictly better: lines are honoured, allocations are only a hint (§11.0b).
    if (inv.items.length) {
      for (const it of inv.items) {
        if (it.balanceCents > 0) wholeBillLines.push({ itemId: it.id, amountCents: it.balanceCents });
      }
    } else {
      everyBillItemised = false;
    }
    sum += inv.balanceCents;
  }
  if (sum <= 0) return { error: 'nothing-due' };
  // The floor applies to every path, not just typed amounts — a leftover 50c invoice costs more in
  // card fees than it collects, and the parent is better off letting it roll into the next month.
  if (sum < session.minAmountCents) return { error: 'below-min' };
  // Lines must cover the charge exactly or the provider refuses the record (§11.2), so they are used
  // only when every picked bill was itemised and the arithmetic lands. Mixing the two breakdowns is
  // never safe: a `lines[]` covering part of the charge is a hard 422, not a partial credit.
  const linesCover = wholeBillLines.reduce((n, l) => n + l.amountCents, 0);
  if (everyBillItemised && wholeBillLines.length && linesCover === sum) {
    return { amountCents: sum, allocations: null, students: null, lines: wholeBillLines };
  }
  // Otherwise the pre-0.43.0 shape: an invoice-level hint plus a per-child split we can vouch for. It
  // must cover the whole charge to the penny or Students rejects it with `invalid_allocation` — a
  // provider that omitted an invoice's studentId leaves us short, so drop the split and let Students
  // derive it rather than fail the record.
  const students = [...perChild].map(([studentId, amountCents]) => ({ studentId, amountCents }));
  const covered = students.reduce((n, s) => n + s.amountCents, 0);
  return { amountCents: sum, allocations, students: covered === sum && students.length ? students : null, lines: null };
}
