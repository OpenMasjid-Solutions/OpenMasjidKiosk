// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Recurring screen: the standing orders donors set up by choosing "Monthly" on a kiosk. Stripe
 *  owns these outright — it takes every renewal on its own, and with no webhooks (we're LAN-only) we
 *  never hear about them — so this screen reads the live subscription list back from Stripe through
 *  the server, and offers the three things an admin would otherwise open the Stripe dashboard for:
 *  pause one, end one, or give one a finish line. Polls slowly and fails soft; each action re-reads
 *  its plan from its own response, so a cancelled plan looks cancelled without a full reload. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  CalendarClock,
  CalendarX,
  CheckCircle2,
  Coins,
  CreditCard,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  ReceiptText,
  Repeat,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  cancelPlan,
  getPlan,
  getPlans,
  pausePlan,
  schedulePlan,
  type Plan,
  type PlanInvoice,
} from './api';
import { formatMoney } from './money';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

/** Statuses where Stripe will never charge again — no action we offer can bring these back. */
const ENDED = new Set(['canceled', 'incomplete_expired']);
/** Statuses an admin has to do something about: a card that stopped working, mostly. */
const NEEDS_HELP = new Set(['past_due', 'unpaid', 'incomplete']);

// ── Dates ────────────────────────────────────────────────────────────────────────
/** A warm "2 min ago" style relative time from an ISO timestamp. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'a while ago';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** The forward-looking twin of relativeTime — the next charge is ahead of us, and relativeTime
 *  clamps the future to "just now", which would read as if the money had already gone. */
function untilTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  const h = Math.round(s / 3600);
  if (h < 1) return 'within the hour';
  if (h < 24) return `in ${h} hr${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return d === 1 ? 'tomorrow' : `in ${d} days`;
}

/** Date only, e.g. "3 Mar 2027". A plan's dates are month-scale — the time of day is noise. */
function fullDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** ISO → the value an `<input type="date">` wants. Built from the LOCAL parts so the field agrees
 *  with the "3 Mar 2027" shown everywhere else on this screen (which is local too) — reading the
 *  UTC parts instead shows a plan ending late in the evening as the day after. */
function toDateInput(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date field → an ISO instant at the END of that day, local time. An admin picking 3 March means
 *  "the 3rd still counts"; UTC midnight would stop the plan a day early for anyone west of London. */
function fromDateInput(v: string): string {
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

// ── Reading a plan out loud ──────────────────────────────────────────────────────
/** "monthly" / "yearly" / "every 3 months" — how an admin says it, not Stripe's interval enum. */
function cadence(interval: string, count: number): string {
  // The server sends '' for a price that lost its recurring block, and the rest of this file guards
  // that with '|| period'. Without the same guard here a row reads '£25 every ' and stops mid-word.
  if (!interval) return 'on a repeating schedule';
  const n = Math.max(1, Math.round(count || 1));
  if (n === 1) {
    const once: Record<string, string> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' };
    return once[interval] ?? `every ${interval}`;
  }
  const many: Record<string, string> = { day: 'days', week: 'weeks', month: 'months', year: 'years' };
  return `every ${n} ${many[interval] ?? `${interval}s`}`;
}

/** Stripe's status enum in plain words, with a severity so the pill colour matches how worried an
 *  admin should be. past_due and unpaid are the two that need a human — a donor's card has stopped
 *  working and nobody will tell them but us. */
function statusOf(p: Plan): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (p.paused && !ENDED.has(p.status)) return { text: 'Paused', tone: 'warn' };
  switch (p.status) {
    case 'active':
      return { text: 'Active', tone: 'ok' };
    // Stripe says `trialing`, but THIS APP NEVER CREATES A TRIAL and a donation has nothing to try
    // out. Every kiosk plan carries a `trial_end` one month ahead for one reason: month one was
    // already collected on the reader, and that is how Stripe is told not to charge again straight
    // away. Stripe files "no invoice due yet" as a trial; calling that "Free trial" on the Recurring
    // screen told an admin the exact opposite of the truth — that the donor is giving nothing yet,
    // when in fact they have already paid. Operationally this is simply a live plan, and the row
    // already shows the next charge date beside it, so nothing is lost by saying so.
    case 'trialing':
      return { text: 'Active', tone: 'ok' };
    case 'past_due':
      return { text: 'Payment failed', tone: 'danger' };
    case 'unpaid':
      return { text: 'Unpaid — Stripe gave up', tone: 'danger' };
    case 'paused':
      return { text: 'Paused', tone: 'warn' };
    case 'incomplete':
      return { text: 'Never got going', tone: 'warn' };
    case 'incomplete_expired':
      return { text: 'Never started', tone: 'muted' };
    case 'canceled':
      return { text: 'Ended', tone: 'muted' };
    default:
      return { text: p.status || 'Unknown', tone: 'muted' };
  }
}

/** "ends 3 Mar 2027" / "ends after this month" — a plan with a finish line has to say so on the row,
 *  or an admin reads "Active" and assumes it runs forever. */
function endsNote(p: Plan): string {
  if (ENDED.has(p.status)) return '';
  if (p.cancelAt) return `ends ${fullDate(p.cancelAt)}`;
  if (p.cancelAtPeriodEnd) return `ends after this ${p.interval || 'period'}`;
  return '';
}

/** Roughly what one plan brings in per month, so the headline figure still means something when a
 *  donor picked weekly or yearly. Deliberately approximate (a month is 4.35 weeks) and used for that
 *  one tile only — never for anything anybody is charged. */
function monthlyMinor(p: Plan): number {
  const perMonth: Record<string, number> = { day: 30.4375, week: 4.348, month: 1, year: 1 / 12 };
  const f = perMonth[p.interval];
  if (!f) return 0;
  return Math.round((p.amountMinor * f) / Math.max(1, Math.round(p.intervalCount || 1)));
}

/** Sort order: whatever an admin must act on first, then the living plans newest-first, with the
 *  finished ones last. Someone opening this page needs the failing standing orders, not the newest. */
function rank(p: Plan): number {
  if (p.status === 'past_due' || p.status === 'unpaid') return 0;
  if (p.status === 'incomplete') return 1;
  if (ENDED.has(p.status)) return 3;
  return 2;
}

function invoiceLabel(inv: PlanInvoice): string {
  if (inv.paid) return 'Paid';
  switch (inv.status) {
    case 'open':
      return inv.failureReason ? 'Payment failed' : 'Awaiting payment';
    case 'draft':
      return 'Draft';
    case 'uncollectible':
      return 'Written off';
    case 'void':
      return 'Cancelled';
    default:
      return inv.status || 'Unknown';
  }
}

function invoiceTone(inv: PlanInvoice): 'ok' | 'warn' | 'bad' | 'idle' {
  if (inv.paid) return 'ok';
  if (inv.status === 'uncollectible' || inv.failureReason || inv.attempts > 1) return 'bad';
  if (inv.status === 'open') return 'warn';
  return 'idle';
}

/** Donor name and email as one line, however little of it the plan actually carries. */
function donorLine(p: Plan): string {
  const bits = [p.donorName, p.donorEmail].filter(Boolean);
  return bits.length ? bits.join(' · ') : 'Donor details weren’t recorded';
}

/** "Visa ····4242", or as much of it as Stripe handed over. Stripe gives the brand lowercase, which
 *  looks like a typo next to everything else on the row. '' when the plan carries no card at all. */
function cardLine(p: Plan): string {
  if (!p.cardBrand && !p.cardLast4) return '';
  const brand = p.cardBrand ? p.cardBrand.charAt(0).toUpperCase() + p.cardBrand.slice(1) : 'Card';
  return p.cardLast4 ? `${brand} ····${p.cardLast4}` : brand;
}

function StatTile({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: 'accent' | 'alert';
}) {
  return (
    <div className={`stat-tile${tone ? ` stat-tile--${tone}` : ''}`}>
      <span className="stat-tile__icon" aria-hidden="true">{icon}</span>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__sub">{sub ?? ' '}</span>
    </div>
  );
}

// ── The Recurring screen ─────────────────────────────────────────────────────────
export function PlansSection() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [err, setErr] = useState('');
  // The open plan is held in its OWN state, not looked up in the polled list. Deriving it meant the
  // window vanished the moment a poll came back without that plan — one Stripe blip returns an empty
  // list, and the admin's half-typed end date, open confirm step and invoice history went with it.
  const [selected, setSelected] = useState<Plan | null>(null);
  // Every load carries a ticket; only the newest one may write. Without this a poll that started
  // BEFORE an action can land after it and paint the pre-action plan back over the result — the
  // admin sees Paused under a pill that says Active, on the one screen whose job is stopping a
  // real person's standing order.
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    try {
      const r = await getPlans();
      if (mine !== gen.current) return;
      setPlans(r.plans);
      setUnavailable(r.unavailable);
      setErr('');
    } catch (e) {
      if (mine !== gen.current) return;
      setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // Every 60s, not the donations log's 20s: each load asks Stripe for the live subscription list,
    // and an admin page left open on a desk shouldn't spend the masjid's rate limit on data that
    // only moves once a month.
    const iv = setInterval(() => void load(), 60_000);
    return () => clearInterval(iv);
  }, [load]);

  /** Patch one plan in place from an action's own response. Stable (no deps) on purpose — the detail
   *  window depends on it in an effect, and a fresh function every render would re-fetch forever. */
  const applyUpdate = useCallback((next: Plan) => {
    // Retire any poll already in flight: it is carrying a snapshot from before this action.
    gen.current++;
    setPlans((cur) => (cur ? cur.map((p) => (p.id === next.id ? next : p)) : cur));
    setSelected((cur) => (cur && cur.id === next.id ? next : cur));
  }, []);

  const sorted = useMemo(
    () => (plans ? [...plans].sort((a, b) => rank(a) - rank(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt)) : null),
    [plans],
  );

  // Plans can sit on more than one Stripe account, so more than one currency can turn up. Adding
  // pounds to dollars would be a lie, so the tiles total the commonest currency and say what they
  // left out; every row still shows its own plan's currency.
  const totals = useMemo(() => {
    const all = plans ?? [];
    const counts = new Map<string, number>();
    for (const p of all) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
    let currency = '';
    let inCurrency = 0;
    for (const [c, n] of counts) {
      if (n > inCurrency) {
        currency = c;
        inCurrency = n;
      }
    }
    const mine = all.filter((p) => p.currency === currency);
    const active = mine.filter((p) => !p.paused && (p.status === 'active' || p.status === 'trialing'));
    return {
      currency,
      otherCurrencies: all.length - inCurrency,
      activeCount: active.length,
      pausedCount: mine.filter((p) => p.paused && !ENDED.has(p.status)).length,
      perMonth: active.reduce((sum, p) => sum + monthlyMinor(p), 0),
      collected: mine.reduce((sum, p) => sum + p.totalMinor, 0),
      attention: mine.filter((p) => NEEDS_HELP.has(p.status)).length,
      anyPartial: mine.some((p) => p.totalPartial),
    };
  }, [plans]);

  if (!sorted) {
    return (
      <section className="glass panel">
        {err ? (
          <p className="hint">We couldn't load recurring plans just now — trying again shortly.</p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
    );
  }



  return (
    <section className="metrics">
      {sorted.length > 0 && (
        <div className="stat-grid">
          <StatTile
            icon={<Repeat size={17} />}
            label="Active plans"
            value={String(totals.activeCount)}
            sub={totals.pausedCount ? `${totals.pausedCount} paused` : ' '}
            tone="accent"
          />
          <StatTile
            icon={<TrendingUp size={17} />}
            label="Per month"
            value={formatMoney(totals.perMonth, totals.currency)}
            sub="from the active plans"
          />
          <StatTile
            icon={<Coins size={17} />}
            label="Collected"
            value={formatMoney(totals.collected, totals.currency)}
            sub={totals.anyPartial ? 'first kiosk taps not counted' : 'across every plan'}
          />
          <StatTile
            icon={totals.attention ? <TriangleAlert size={17} /> : <CheckCircle2 size={17} />}
            label="Need a look"
            value={String(totals.attention)}
            sub={totals.attention ? 'a card has stopped working' : 'everything is collecting'}
            tone={totals.attention ? 'alert' : undefined}
          />
        </div>
      )}

      {totals.otherCurrencies > 0 && (
        <p className="hint">
          These totals cover the {totals.currency.toUpperCase()} plans. {totals.otherCurrencies} plan
          {totals.otherCurrencies === 1 ? '' : 's'} on another currency {totals.otherCurrencies === 1 ? 'is' : 'are'}{' '}
          listed below but left out of the figures — we won't add different currencies together.
        </p>
      )}

      <section className="glass panel">
        <div className="card-head">
          <Repeat size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Recurring giving</h2>
            <p className="muted">Standing orders donors set up at a kiosk. Stripe collects these on its own.</p>
          </div>
        </div>

        {err && sorted.length > 0 && <p className="hint">Couldn't refresh just now — showing the last known list.</p>}

        {sorted.length === 0 ? (
          <div className="empty-state">
            <div className="empty-emblem" aria-hidden="true"><Repeat size={26} /></div>
            <p className="empty-title">{unavailable ? 'Recurring plans aren’t available' : 'No recurring plans yet'}</p>
            {unavailable ? (
              <p className="muted">{unavailable}</p>
            ) : (
              <p className="muted">
                When a donor picks <strong>Monthly</strong> on a kiosk, that one tap of their card sets up a standing
                order with Stripe. It appears here and renews on its own — you can pause it, end it, or give it a
                finish line whenever the donor asks.
              </p>
            )}
          </div>
        ) : (
          <>
            {unavailable && <p className="note-amber">{unavailable}</p>}
            <ul className="plan-list">
              {sorted.map((p) => (
                <li key={p.id}>
                  <PlanRow plan={p} onOpen={() => setSelected(p)} />
                </li>
              ))}
            </ul>
            {totals.anyPartial && (
              <p className="plan-foot faint">
                * The first payment, taken on the reader, isn't part of this total — Stripe records that tap as its own
                donation rather than an invoice on the plan. You'll find it in Donations.
              </p>
            )}
          </>
        )}
      </section>

      {selected && <PlanModal plan={selected} onUpdated={applyUpdate} onClose={() => setSelected(null)} />}
    </section>
  );
}

// ── One plan in the list ─────────────────────────────────────────────────────────
function PlanRow({ plan, onOpen }: { plan: Plan; onOpen: () => void }) {
  const money = (m: number) => formatMoney(m, plan.currency);
  const status = statusOf(plan);
  const ends = endsNote(plan);
  return (
    <button type="button" className="plan-row" onClick={onOpen}>
      <div className="plan-row__top">
        <span className="plan-amt">
          {money(plan.amountMinor)} {cadence(plan.interval, plan.intervalCount)}
        </span>
        <span className={`status-pill status-pill--${status.tone}`}>{status.text}</span>
        {ends && (
          <span className="status-pill status-pill--muted">
            <CalendarX size={12} aria-hidden="true" /> {ends}
          </span>
        )}
      </div>
      <div className="plan-who">
        {donorLine(plan)}
        {plan.campaignTitle && <span className="faint"> · {plan.campaignTitle}</span>}
      </div>
      <div className="plan-facts">
        <span className="plan-fact"><b>Started</b> {fullDate(plan.startedAt)}</span>
        <span className="plan-fact"><b>Last charge</b> {plan.lastChargeAt ? fullDate(plan.lastChargeAt) : 'none yet'}</span>
        <span className="plan-fact"><b>Next charge</b> {plan.nextChargeAt ? fullDate(plan.nextChargeAt) : '—'}</span>
        <span className="plan-fact"><b>Card</b> {cardLine(plan) || 'not recorded'}</span>
        <span className="plan-fact">
          <b>Collected</b> {money(plan.totalMinor)}
          {plan.totalPartial && (
            <span className="plan-star" title="The first payment, taken on the reader, isn't included — see the note below the list.">*</span>
          )}
        </span>
      </div>
    </button>
  );
}

// ── The detail window ────────────────────────────────────────────────────────────
type Busy = '' | 'pause' | 'cancel' | 'cancel-now' | 'schedule' | 'clear';

function PlanModal({ plan, onUpdated, onClose }: { plan: Plan; onUpdated: (p: Plan) => void; onClose: () => void }) {
  const [invoices, setInvoices] = useState<PlanInvoice[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState<Busy>('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [cancelStage, setCancelStage] = useState<'' | 'choose' | 'confirm'>('');
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedMode, setSchedMode] = useState<'date' | 'charges'>('date');
  const [endDate, setEndDate] = useState(() => toDateInput(plan.cancelAt));
  const [charges, setCharges] = useState('');

  const planId = plan.id;
  const money = (m: number) => formatMoney(m, plan.currency);
  const status = statusOf(plan);
  const ends = endsNote(plan);
  const ended = ENDED.has(plan.status);
  const who = plan.donorName || plan.donorEmail || 'this donor';
  const every = cadence(plan.interval, plan.intervalCount);
  // Either kind of finish line counts here — a date Stripe is holding, or "stop at the end of this
  // period". Both are cleared by the same call, and an admin who mis-tapped the end-of-period button
  // needs a way back either way.
  const scheduledEnd = !!plan.cancelAt || plan.cancelAtPeriodEnd;

  // The invoice history only arrives with the detail call, and that same call hands back a fresher
  // plan than the list is holding — so pass it up rather than let the two disagree on screen.
  useEffect(() => {
    let alive = true;
    getPlan(planId)
      .then((r) => {
        if (!alive) return;
        setInvoices(r.invoices);
        onUpdated(r.plan);
      })
      .catch((e) => alive && setLoadErr(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [planId, onUpdated]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Every action shares this: clear the last message, run, take the returned plan as the new truth. */
  const run = async (kind: Busy, fn: () => Promise<{ plan: Plan }>, done: string) => {
    setErr('');
    setNote('');
    setBusy(kind);
    try {
      const r = await fn();
      onUpdated(r.plan);
      setNote(done);
      setCancelStage('');
      setSchedOpen(false);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy('');
    }
  };

  const saveSchedule = () => {
    if (schedMode === 'date') {
      const iso = fromDateInput(endDate);
      if (!iso) {
        setErr('Please pick the date this plan should stop.');
        return;
      }
      if (Date.parse(iso) <= Date.now()) {
        setErr('Please pick a date in the future — to stop it now, end the plan instead.');
        return;
      }
      void run('schedule', () => schedulePlan(planId, { endAt: iso }), `Saved — this plan stops after ${fullDate(iso)}.`);
      return;
    }
    const n = Math.round(Number(charges));
    if (!Number.isFinite(n) || n < 1) {
      setErr('Enter how many more payments to take — at least one.');
      return;
    }
    void run(
      'schedule',
      () => schedulePlan(planId, { charges: n }),
      `Saved — ${n} more payment${n === 1 ? '' : 's'}, then this plan stops.`,
    );
  };

  const kv: { k: string; v: ReactNode }[] = [
    { k: 'Donor', v: plan.donorName || '—' },
    { k: 'Email', v: plan.donorEmail || '—' },
    { k: 'Campaign', v: plan.campaignTitle || <span className="faint">not recorded</span> },
    { k: 'Amount', v: <strong>{money(plan.amountMinor)} {every}</strong> },
    { k: 'Status', v: status.text },
    { k: 'Started', v: fullDate(plan.startedAt) },
    { k: 'Last charge', v: plan.lastChargeAt ? `${fullDate(plan.lastChargeAt)} · ${relativeTime(plan.lastChargeAt)}` : 'none yet' },
    { k: 'Next charge', v: plan.nextChargeAt ? `${fullDate(plan.nextChargeAt)} · ${untilTime(plan.nextChargeAt)}` : '—' },
    { k: 'Card', v: cardLine(plan) || '—' },
    { k: 'Collected so far', v: money(plan.totalMinor) },
    // 'local' is the resolver's own word for the standalone keys — not something to show an admin.
    { k: 'Stripe account', v: !plan.accountId || plan.accountId === 'local' ? 'Primary' : plan.accountId },
    { k: 'Set up on', v: plan.deviceId ? <code className="mono">{plan.deviceId}</code> : '—' },
    { k: 'Plan ID', v: <code className="mono">{plan.id}</code> },
  ];

  return createPortal(
    <div className="modal-scrim" role="presentation" onClick={onClose}>
      <div
        className="modal modal--window glass-raised"
        role="dialog"
        aria-modal="true"
        aria-label={`Recurring plan for ${who}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tl-bar tl-bar--static">
          <button type="button" className="tl tl--red" aria-label="Close" onClick={onClose}>
            <X size={9} strokeWidth={3} />
          </button>
          <span className="tl tl--amber" aria-hidden="true" />
          <span className="tl tl--green" aria-hidden="true" />
        </div>
        <div className="modal-head">
          <div className="card-head__main">
            <h3 className="section-title-inline">{plan.donorName || plan.donorEmail || 'Recurring donation'}</h3>
            <p className="muted">
              {money(plan.amountMinor)} {every}
              {plan.campaignTitle ? ` · ${plan.campaignTitle}` : ''}
            </p>
          </div>
        </div>

        <div className="modal-body">
          <div className="detail-amt">{money(plan.amountMinor)}</div>
          <div className="plan-row__top" style={{ justifyContent: 'center', marginBlockEnd: '1rem' }}>
            <span className={`status-pill status-pill--${status.tone}`}>{status.text}</span>
            {ends && (
              <span className="status-pill status-pill--muted">
                <CalendarX size={12} aria-hidden="true" /> {ends}
              </span>
            )}
          </div>

          <div className="kv">
            {kv.map((r) => (
              <div className="kv-row" key={r.k}>
                <span className="kv-k">{r.k}</span>
                <span className="kv-v">{r.v}</span>
              </div>
            ))}
          </div>

          {plan.totalPartial && (
            <p className="hint" style={{ marginBlockStart: '0.5rem', lineHeight: 1.5 }}>
              "Collected so far" leaves out the first payment, the one taken on the reader — Stripe files that tap as
              its own donation rather than as an invoice on this plan, so the real figure is higher. It's in Donations.
            </p>
          )}

          {/* ── Actions ─────────────────────────────────────────────────────── */}
          <div className="plan-actions">
            {ended ? (
              <p className="muted" style={{ lineHeight: 1.55 }}>
                This plan has ended — Stripe won't take anything more on it. If the donor wants to start again, they can
                give monthly at any kiosk.
              </p>
            ) : (
              <>
                <div className="plan-act">
                  <p className="plan-act__title">{plan.paused ? 'Resume this plan' : 'Pause this plan'}</p>
                  <p className="hint" style={{ marginBlockEnd: '0.45rem', lineHeight: 1.5 }}>
                    Pausing keeps the plan and the donor's card, but stops Stripe collecting. Resume whenever they're
                    ready and it carries on from the next date.
                  </p>
                  <div className="plan-act__row">
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={busy !== ''}
                      onClick={() =>
                        void run(
                          'pause',
                          () => pausePlan(planId, !plan.paused),
                          plan.paused
                            ? 'Resumed — Stripe will collect again from the next date.'
                            : 'Paused — nothing will be collected until you resume.',
                        )
                      }
                    >
                      {busy === 'pause' ? (
                        <>
                          <Loader2 size={14} className="spin" aria-hidden="true" /> Saving…
                        </>
                      ) : plan.paused ? (
                        <>
                          <Play size={14} aria-hidden="true" /> Resume
                        </>
                      ) : (
                        <>
                          <Pause size={14} aria-hidden="true" /> Pause
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="plan-act">
                  <p className="plan-act__title">Give it an end date</p>
                  <p className="hint" style={{ marginBlockEnd: '0.45rem', lineHeight: 1.5 }}>
                    For a donor who's pledged "£25 a month until Ramadan" — Stripe keeps collecting until then, and
                    stops on its own.
                  </p>
                  {schedOpen ? (
                    <>
                      <div className="seg" role="tablist" aria-label="How should this plan end?">
                        <button
                          role="tab"
                          aria-selected={schedMode === 'date'}
                          className={`seg__opt${schedMode === 'date' ? ' seg__opt--on' : ''}`}
                          onClick={() => setSchedMode('date')}
                        >
                          <CalendarClock size={15} aria-hidden="true" /> On a date
                        </button>
                        <button
                          role="tab"
                          aria-selected={schedMode === 'charges'}
                          className={`seg__opt${schedMode === 'charges' ? ' seg__opt--on' : ''}`}
                          onClick={() => setSchedMode('charges')}
                        >
                          <ReceiptText size={15} aria-hidden="true" /> After a number of payments
                        </button>
                      </div>
                      {schedMode === 'date' ? (
                        <div className="field">
                          <label className="label" htmlFor="plan-end-date">
                            Stop after this date
                          </label>
                          <input
                            id="plan-end-date"
                            type="date"
                            className="input"
                            style={{ maxWidth: '12rem' }}
                            value={endDate}
                            onChange={(e) => setEndDate(e.target.value)}
                          />
                        </div>
                      ) : (
                        <div className="field">
                          <label className="label" htmlFor="plan-end-charges">
                            More payments to take
                          </label>
                          <input
                            id="plan-end-charges"
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            className="input"
                            style={{ maxWidth: '8rem' }}
                            placeholder="e.g. 3"
                            value={charges}
                            onChange={(e) => setCharges(e.target.value.replace(/\D/g, ''))}
                          />
                          <p className="hint">We'll work out the date from this plan's schedule.</p>
                        </div>
                      )}
                      <div className="plan-act__row">
                        <button className="btn btn--primary btn--sm" disabled={busy !== ''} onClick={saveSchedule}>
                          {busy === 'schedule' ? (
                            <>
                              <Loader2 size={14} className="spin" aria-hidden="true" /> Saving…
                            </>
                          ) : (
                            'Save end date'
                          )}
                        </button>
                        <button className="btn btn--ghost btn--sm" disabled={busy !== ''} onClick={() => setSchedOpen(false)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="plan-act__row">
                      <button className="btn btn--ghost btn--sm" disabled={busy !== ''} onClick={() => setSchedOpen(true)}>
                        <CalendarClock size={14} aria-hidden="true" /> {scheduledEnd ? 'Change the end date' : 'Set an end date'}
                      </button>
                      {scheduledEnd && (
                        <button
                          className="btn btn--ghost btn--sm"
                          disabled={busy !== ''}
                          onClick={() =>
                            void run('clear', () => schedulePlan(planId, { endAt: null }), 'End date cleared — this plan runs on until you stop it.')
                          }
                        >
                          {busy === 'clear' ? (
                            <>
                              <Loader2 size={14} className="spin" aria-hidden="true" /> Clearing…
                            </>
                          ) : (
                            'Let it run on'
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="plan-act">
                  <p className="plan-act__title">End this plan</p>
                  {cancelStage === '' && (
                    <div className="plan-act__row">
                      <button className="btn btn--ghost btn--sm plan-end-btn" onClick={() => setCancelStage('choose')}>
                        <Ban size={14} aria-hidden="true" /> End this plan
                      </button>
                    </div>
                  )}
                  {cancelStage === 'choose' && (
                    <>
                      <p className="hint" style={{ marginBlockEnd: '0.45rem', lineHeight: 1.5 }}>
                        Payments already taken are unaffected and the donor keeps their receipts. Letting it finish the{' '}
                        {plan.interval || 'period'} they've paid for is the kinder option.
                      </p>
                      <div className="plan-act__row">
                        {/* Harmless option FIRST, and deliberately: it sits exactly where the "End this
                            plan" button the admin just pressed was, so a double tap or an impatient
                            second press on a laggy tablet browser backs out instead of setting a real
                            donor's standing order to stop. */}
                        <button className="btn btn--ghost btn--sm" disabled={busy !== ''} onClick={() => setCancelStage('')}>
                          Keep the plan
                        </button>
                        <button
                          className="btn btn--ghost btn--sm"
                          disabled={busy !== ''}
                          onClick={() =>
                            void run(
                              'cancel',
                              () => cancelPlan(planId, false),
                              `Set to end after this ${plan.interval || 'period'} — no payments after that.`,
                            )
                          }
                        >
                          {busy === 'cancel' ? (
                            <>
                              <Loader2 size={14} className="spin" aria-hidden="true" /> Saving…
                            </>
                          ) : (
                            <>
                              <CalendarX size={14} aria-hidden="true" /> At the end of this {plan.interval || 'period'}
                            </>
                          )}
                        </button>
                        <button className="btn btn--sm device-danger" disabled={busy !== ''} onClick={() => setCancelStage('confirm')}>
                          <Ban size={14} aria-hidden="true" /> End it immediately
                        </button>
                      </div>
                    </>
                  )}
                  {cancelStage === 'confirm' && (
                    <>
                      <p className="note-danger">
                        This ends <strong>{who}</strong>'s {money(plan.amountMinor)} {every} donation right now. Stripe
                        won't collect it again and it can't be restarted from here — {who} would have to give monthly at
                        a kiosk again. To stop only the next payment, pause it instead.
                      </p>
                      <div className="plan-act__row" style={{ marginBlockStart: '0.5rem' }}>
                        <button
                          className="btn btn--sm device-danger"
                          disabled={busy !== ''}
                          onClick={() => void run('cancel-now', () => cancelPlan(planId, true), 'Ended — no further payments will be taken.')}
                        >
                          {busy === 'cancel-now' ? (
                            <>
                              <Loader2 size={14} className="spin" aria-hidden="true" /> Ending…
                            </>
                          ) : (
                            'Yes, end it now'
                          )}
                        </button>
                        <button className="btn btn--ghost btn--sm" disabled={busy !== ''} onClick={() => setCancelStage('choose')}>
                          Go back
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}

            {note && (
              <p className="plan-note">
                <CheckCircle2 size={14} aria-hidden="true" /> {note}
              </p>
            )}
            {err && <p className="form-error" style={{ marginBlockStart: '0.4rem' }}>{err}</p>}
          </div>

          {/* ── Invoice history ─────────────────────────────────────────────── */}
          <div className="plan-actions">
            <p className="plan-act__title">
              <CreditCard size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginInlineEnd: '0.3rem' }} />
              Payments on this plan
            </p>
            {loadErr && <p className="form-error">{loadErr}</p>}
            {!invoices && !loadErr && <p className="muted">Loading…</p>}
            {invoices && invoices.length === 0 && (
              <p className="muted">Nothing yet — the first renewal will appear here once Stripe has taken it.</p>
            )}
            {invoices && invoices.length > 0 && (
              <ul className="inv-list">
                {invoices.map((inv) => (
                  <InvoiceRow key={inv.id} inv={inv} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One renewal. A failed one has to be unmissable — it's the only sign an admin gets that a donor's
 *  card has stopped working (Stripe emails them, we get no webhook). */
function InvoiceRow({ inv }: { inv: PlanInvoice }) {
  const tone = invoiceTone(inv);
  return (
    <li className={`inv-row inv-row--${tone}`}>
      <span className="inv-dot" aria-hidden="true" />
      <div className="inv-main">
        <div className="inv-top">
          <span className="inv-date">{fullDate(inv.date)}</span>
          <span className="inv-amt">{formatMoney(inv.amountMinor, inv.currency)}</span>
        </div>
        <span className="inv-sub">
          {invoiceLabel(inv)}
          {inv.attempts > 1 && ` · ${inv.attempts} attempts`}
          {inv.failureReason && ` · ${inv.failureReason}`}
        </span>
      </div>
      {inv.hostedUrl && (
        <a className="btn btn--ghost btn--sm" href={inv.hostedUrl} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={13} aria-hidden="true" /> View
        </a>
      )}
    </li>
  );
}
