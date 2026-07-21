// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * OpenMasjid Students billing — the `tuition` campaign type talks to the OpenMasjid Students app
 * through the OpenMasjidOS Fabric app-to-app broker (never to Students directly). Contract:
 * `students/billing` v1 — authoritative source
 * `OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` §11 (also docs/STUDENTS_INTEGRATION.md).
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
 * SECURITY: the PIN + the typed name are INERT input — sent in the JSON body only, NEVER put in a URL, a
 * log line, Stripe metadata, a description, or a receipt, and never stored. We log method names only,
 * never request/response bodies. Secrets are read from env every start (config.ts), never persisted.
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

async function brokerCall(method: string, body: Record<string, unknown>): Promise<BrokerResult> {
  if (!billingConfigured()) return { ok: false, unavailable: true, code: 'no-fabric' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000); // contract: respond < 10 s
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/app/${BILLING_PATH}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ v: 1, ...body }), // every request/response carries "v":1
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
    // Message only (never the body) — the body carries the PIN + family data.
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

// ── lookup (name + PIN → family + balance) ──────────────────────────────────
export interface StudentInvoice {
  id: string;
  label: string;
  dueDate: string;
  balanceCents: number;
}
export interface StudentFamily {
  id: string;
  label: string;
  students: { firstName: string; lastInitial: string }[];
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
  const students = studentsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .slice(0, 40)
    .map((s) => ({ firstName: str(s.firstName, 60), lastInitial: str(s.lastInitial, 4) }));
  const invRaw = Array.isArray(f.openInvoices) ? f.openInvoices : [];
  const openInvoices = invRaw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .slice(0, 60)
    .map((i) => ({ id: str(i.id, 128), label: str(i.label, 120), dueDate: str(i.dueDate, 40), balanceCents: intNonNeg(i.balanceCents) }))
    .filter((i) => i.id); // an invoice with no id can't be paid specifically
  return {
    id,
    label: str(f.label, 120),
    students,
    balanceCents: intNonNeg(f.balanceCents),
    currency: str(f.currency, 10).toUpperCase(),
    openInvoices,
  };
}

/** Resolve a student name + PIN to a family + balance. The PIN/name are sent in the body only and are
 *  NEVER logged. `not-found` is uniform (the provider returns the same shape for a wrong PIN or a name
 *  mismatch — no enumeration oracle). */
export async function studentsLookup(name: string, pin: string): Promise<LookupResult> {
  const r = await brokerCall('lookup', { name, pin });
  if (r.ok) {
    if (r.data.found === true) {
      const family = parseFamily(r.data);
      if (!family) return { status: 'unavailable' }; // malformed "found" payload → don't guess
      const matchedStudentId = str((r.data.matchedStudent as { id?: unknown } | undefined)?.id, 128);
      return { status: 'found', matchedStudentId, family };
    }
    return { status: 'not-found' };
  }
  // Any broker/app error on a lookup is treated as unavailable (fail soft) — we never leak whether the
  // PIN or name was the problem, and a transient outage isn't a "wrong PIN".
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
  const r = await brokerCall('record-payment', body);
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
  invoices: { id: string; balanceCents: number }[];
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
  | { amountCents: number; allocations: { invoiceId: string; amountCents: number }[] | null }
  | { error: string };

/** Compute the charge amount + allocations from the SERVER-side session, never the client's numbers.
 *  "full" pays the whole balance (allocations omitted → Students auto-allocates oldest-due-first);
 *  otherwise pay exactly the chosen open invoices, at their stored amounts. */
export function computeTuitionAmount(session: TuitionSession, selection: TuitionSelection): AmountResult {
  if (selection.kind === 'full') {
    if (session.balanceCents <= 0) return { error: 'nothing-due' };
    return { amountCents: session.balanceCents, allocations: null };
  }
  const ids = [...new Set(selection.invoiceIds)];
  if (!ids.length) return { error: 'no-selection' };
  const allocations: { invoiceId: string; amountCents: number }[] = [];
  let sum = 0;
  for (const id of ids) {
    const inv = session.invoices.find((i) => i.id === id);
    if (!inv || inv.balanceCents <= 0) return { error: 'unknown-invoice' };
    allocations.push({ invoiceId: id, amountCents: inv.balanceCents });
    sum += inv.balanceCents;
  }
  if (sum <= 0) return { error: 'nothing-due' };
  return { amountCents: sum, allocations };
}
