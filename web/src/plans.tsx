// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Recurring screen: the standing orders donors set up by choosing "Monthly" on a kiosk. Stripe
 *  owns these outright — it takes every renewal on its own, and with no webhooks (we're LAN-only) we
 *  never hear about them — so this screen reads the live subscription list back from Stripe through
 *  the server, and offers the three things an admin would otherwise open the Stripe dashboard for:
 *  pause one, end one, or give one a finish line. Polls slowly and fails soft; each action re-reads
 *  its plan from its own response, so a canceled plan looks canceled without a full reload. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
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
  RefreshCw,
  Repeat,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  ApiError,
  cancelPlan,
  errorText,
  getPlan,
  getPlans,
  pausePlan,
  schedulePlan,
  type Plan,
  type PlanInvoice,
} from './api';
import { endOfDayFromInput, formatDate, relativeTime, toDateInputValue } from './dates';
import { Modal } from './modal';
import { formatMoney } from './money';
import { figures, ResultLine, Skeleton, useClock } from './ui';

/** Statuses where Stripe will never charge again — no action we offer can bring these back. */
const ENDED = new Set(['canceled', 'incomplete_expired']);
/** Statuses an admin has to do something about: a card that stopped working, mostly. */
const NEEDS_HELP = new Set(['past_due', 'unpaid', 'incomplete']);

// ── Dates ────────────────────────────────────────────────────────────────────────
// Every date here is formatDate from dates.ts: the masjid's zone, with the Hijri date beside the
// Gregorian (spec §10). Date only, never formatDateTime — a plan's dates are month-scale, and the
// time of day is noise. Relative times ("5 days ago") are not dates and stay relative.

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

// ── Reading a plan out loud ──────────────────────────────────────────────────────
/** "monthly" / "yearly" / "every 3 months" — how an admin says it, not Stripe's interval enum. */
function cadence(interval: string, count: number): string {
  // The server sends '' for a price that lost its recurring block, and the rest of this file guards
  // that with '|| period'. Without the same guard here a row reads '$25 every ' and stops mid-word.
  if (!interval) return 'on a repeating schedule';
  const n = Math.max(1, Math.round(count || 1));
  if (n === 1) {
    const once: Record<string, string> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' };
    return once[interval] ?? `every ${interval}`;
  }
  const many: Record<string, string> = { day: 'days', week: 'weeks', month: 'months', year: 'years' };
  return `every ${n} ${many[interval] ?? `${interval}s`}`;
}

/** Stripe's status enum in plain words, with a severity so the pill color matches how worried an
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
  if (p.cancelAt) return `ends ${formatDate(p.cancelAt)}`;
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
      return 'Canceled';
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

/** "Recurring plan needs a look: $25 monthly — Payment failed." Amount, schedule and status only —
 *  a live region is read aloud, and a donor's name has no business being spoken into a room. */
function needsLookSentence(fresh: Plan[]): string {
  if (fresh.length === 1) {
    const p = fresh[0];
    return `Recurring plan needs a look: ${formatMoney(p.amountMinor, p.currency)} ${cadence(p.interval, p.intervalCount)} — ${statusOf(p).text}.`;
  }
  return `${fresh.length} recurring plans need a look.`;
}

/**
 * A polite, screen-reader-only announcement of something that changed ON ITS OWN — here, a plan
 * newly needing attention on a poll (spec §7). The same helper as the Donations screen's: the text is
 * cleared a few seconds after it is set, because a live region only speaks when its text CHANGES, and
 * the same sentence on two consecutive polls would otherwise go unheard the second time.
 */
function useAnnouncer(): [string, (message: string) => void] {
  const [text, setText] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = useCallback((message: string) => {
    window.clearTimeout(timer.current);
    setText(message);
    timer.current = window.setTimeout(() => setText(''), 8000);
  }, []);
  return [text, say];
}

function StatTile({
  i,
  icon,
  label,
  value,
  sub,
  tone,
}: {
  /** Position in the grid, for its one-time staggered entrance (.stagger in app.css). */
  i: number;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: 'accent' | 'alert';
}) {
  return (
    <div className={`stat-tile${tone ? ` stat-tile--${tone}` : ''}`} style={{ '--i': i } as CSSProperties}>
      <span className="stat-tile__icon" aria-hidden="true">{icon}</span>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__sub">{figures(sub ?? ' ')}</span>
    </div>
  );
}

/** A label/value list — the plan window's facts, and the technical id behind its disclosure. */
function Facts({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <div className="kv">
      {rows.map((r) => (
        <div className="kv-row" key={r.k}>
          <span className="kv-k">{r.k}</span>
          <span className="kv-v">{figures(r.v)}</span>
        </div>
      ))}
    </div>
  );
}

// ── The Recurring screen ─────────────────────────────────────────────────────────
export function PlansSection() {
  // Re-render when the masjid's locale, zone or hour cycle load: every amount and date below uses them.
  useClock();
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
  const [announcement, announce] = useAnnouncer();
  /** Ids of the plans that needed a look on the last load — null until the first one, which
   *  announces nothing (the page the admin just opened is not news). */
  const troubled = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    try {
      const r = await getPlans();
      if (mine !== gen.current) return;
      const before = troubled.current;
      const now = r.plans.filter((p) => NEEDS_HELP.has(p.status));
      if (before) {
        const fresh = now.filter((p) => !before.has(p.id));
        if (fresh.length) announce(needsLookSentence(fresh));
      }
      // A SHORT list (`unavailable` set: an account couldn't be read) must not forget the plans it
      // failed to bring back, or the next full load would announce every one of them as new.
      troubled.current = new Set([...(r.unavailable && before ? before : []), ...now.map((p) => p.id)]);
      setPlans(r.plans);
      setUnavailable(r.unavailable);
      setErr('');
    } catch (e) {
      if (mine !== gen.current) return;
      setErr(errorText(e));
    }
  }, [announce]);

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
    if (err) {
      return (
        <section className="glass panel">
          <p className="hint">We couldn't load recurring plans just now — trying again shortly.</p>
        </section>
      );
    }
    // Shaped like what is coming (spec §5). The same StatTiles at the same place in the tree as the
    // loaded grid below, so React keeps their nodes when the list lands and the entrance plays once.
    const pending = <span className="skeleton" aria-hidden="true" />;
    return (
      <section className="metrics">
        <div className="stat-grid stagger" aria-busy="true">
          <StatTile i={0} icon={<Repeat size={17} />} label="Active plans" value={pending} tone="accent" />
          <StatTile i={1} icon={<TrendingUp size={17} />} label="Per month" value={pending} />
          <StatTile i={2} icon={<Coins size={17} />} label="Collected" value={pending} />
          <StatTile i={3} icon={<CheckCircle2 size={17} />} label="Need a look" value={pending} />
        </div>
        <section className="glass panel">
          <Skeleton rows={4} height="4.2rem" label="Loading recurring plans…" />
        </section>
      </section>
    );
  }

  return (
    <section className="metrics">
      {sorted.length > 0 && (
        <div className="stat-grid stagger">
          <StatTile
            i={0}
            icon={<Repeat size={17} />}
            label="Active plans"
            value={String(totals.activeCount)}
            sub={totals.pausedCount ? `${totals.pausedCount} paused` : ' '}
            tone="accent"
          />
          <StatTile
            i={1}
            icon={<TrendingUp size={17} />}
            label="Per month"
            value={formatMoney(totals.perMonth, totals.currency)}
            sub="from the active plans"
          />
          <StatTile
            i={2}
            icon={<Coins size={17} />}
            label="Collected"
            value={formatMoney(totals.collected, totals.currency)}
            sub={totals.anyPartial ? 'first kiosk taps not counted' : 'across every plan'}
          />
          <StatTile
            i={3}
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
          These totals cover the {totals.currency.toUpperCase()} plans. <span className="num">{totals.otherCurrencies}</span> plan
          {totals.otherCurrencies === 1 ? '' : 's'} on another currency {totals.otherCurrencies === 1 ? 'is' : 'are'}{' '}
          listed below but left out of the figures — we won't add different currencies together.
        </p>
      )}

      <section className="glass panel">
        <div className="card-head">
          <Repeat size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Recurring giving</h2>
            <p className="muted">Plans donors set up by choosing Monthly at a kiosk. Stripe collects these on its own.</p>
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
                When a donor picks <strong>Monthly</strong> on a kiosk, that one tap of their card sets up a recurring
                donation with Stripe. It appears here and renews on its own — you can pause it, end it, or give it a
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

      {/* Last in the tree on purpose: anything inserted before the stat grid would shift it to a new
          position and make React rebuild it, replaying the entrance the skeleton already played. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    </section>
  );
}

// ── One plan in the list ─────────────────────────────────────────────────────────
function PlanRow({ plan, onOpen }: { plan: Plan; onOpen: () => void }) {
  const clock = useClock();
  const money = (m: number) => formatMoney(m, plan.currency);
  const status = statusOf(plan);
  const ends = endsNote(plan);
  return (
    <button type="button" className="plan-row" onClick={onOpen}>
      <div className="plan-row__top">
        <span className="plan-amt">
          <span className="num">{money(plan.amountMinor)}</span> {figures(cadence(plan.interval, plan.intervalCount))}
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
        <span className="plan-fact"><b>Started</b> {figures(formatDate(plan.startedAt, clock))}</span>
        <span className="plan-fact"><b>Last charge</b> {plan.lastChargeAt ? figures(formatDate(plan.lastChargeAt, clock)) : 'none yet'}</span>
        <span className="plan-fact"><b>Next charge</b> {plan.nextChargeAt ? figures(formatDate(plan.nextChargeAt, clock)) : '—'}</span>
        <span className="plan-fact"><b>Card</b> {cardLine(plan) || 'not recorded'}</span>
        <span className="plan-fact">
          <b>Collected</b> <span className="num">{money(plan.totalMinor)}</span>
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
  const clock = useClock();
  const titleId = useId();
  const [invoices, setInvoices] = useState<PlanInvoice[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  // Bumped by "Try again" under a failed invoice history, to re-run the detail call. The error says
  // to try again, so there has to be something to press (spec §9).
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<Busy>('');
  // What went wrong, in words — plus whatever Stripe itself said, for the "Technical details" line.
  const [err, setErr] = useState<{ text: string; detail: string } | null>(null);
  const [note, setNote] = useState('');
  const [cancelStage, setCancelStage] = useState<'' | 'choose' | 'confirm'>('');
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedMode, setSchedMode] = useState<'date' | 'charges'>('date');
  // The date field shows the end day IN THE MASJID'S ZONE, the same zone every date on this screen is
  // written in — built from the browser's own zone instead, a plan ending late in the evening read as
  // ending the day after for a trustee checking from elsewhere.
  const [endDate, setEndDate] = useState(() => toDateInputValue(plan.cancelAt));
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
  const idle = busy === '';

  // ── Where focus goes when a stage swap removes the button that held it ──
  // Each step here replaces the button just pressed ("End this plan" becomes a choice, the choice
  // becomes a confirm). Left alone, focus falls to the top of the window and a keyboard user has to
  // find their place again — on the screen that stops a real person's donation. So: forward, focus
  // the first control of the new step; back, return it to the button that opened the step; after an
  // action, the control now standing where the pressed one was — or, if the action removed that
  // whole section (a plan ended outright), the outcome line itself.
  const endBtnRef = useRef<HTMLButtonElement>(null);
  const immediateBtnRef = useRef<HTMLButtonElement>(null);
  const schedBtnRef = useRef<HTMLButtonElement>(null);
  const schedFirstRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<RefObject<HTMLElement | null> | null>(null);
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    (want.current ?? noteRef.current)?.focus();
  });

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
      .catch((e) => alive && setLoadErr(errorText(e, 'We couldn’t load this plan’s payments just now.')));
    return () => {
      alive = false;
    };
  }, [planId, onUpdated, attempt]);

  /** Every action shares this: clear the last message, run, take the returned plan as the new truth.
   *  `after` is where focus should land once it has worked (none for Pause, whose button stays put). */
  const run = async (kind: Busy, fn: () => Promise<{ plan: Plan }>, done: string, after?: RefObject<HTMLElement | null>) => {
    // The buttons stay focusable while an action runs (aria-disabled, not disabled — disabling the
    // one just pressed throws a keyboard user out of the window), so the guard is here instead.
    if (!idle) return;
    setErr(null);
    setNote('');
    setBusy(kind);
    try {
      const r = await fn();
      if (after) focusNext.current = after;
      onUpdated(r.plan);
      setNote(done);
      setCancelStage('');
      setSchedOpen(false);
    } catch (e) {
      setErr({ text: errorText(e), detail: e instanceof ApiError ? e.detail : '' });
    } finally {
      setBusy('');
    }
  };

  /** Open or close a step, moving focus with it. Ignored while an action is running. With no `focus`,
   *  the new step's own autoFocus decides — the confirm step starts on its harmless "Go back". */
  const step = (to: () => void, focus?: RefObject<HTMLElement | null>) => {
    if (!idle) return;
    if (focus) focusNext.current = focus;
    to();
  };

  const saveSchedule = () => {
    if (!idle) return;
    if (schedMode === 'date') {
      // The END of the chosen day, in the masjid's zone. An admin picking 3 March means "the 3rd still
      // counts"; UTC midnight would stop the plan a day early for anyone west of London, and the
      // browser's own zone would move it for a trustee checking from abroad.
      const iso = endOfDayFromInput(endDate);
      if (!iso) {
        setErr({ text: 'Please pick the date this plan should stop.', detail: '' });
        return;
      }
      if (Date.parse(iso) <= Date.now()) {
        setErr({ text: 'Please pick a date in the future — to stop it now, end the plan instead.', detail: '' });
        return;
      }
      void run('schedule', () => schedulePlan(planId, { endAt: iso }), `Saved — this plan stops after ${formatDate(iso, clock)}.`, schedBtnRef);
      return;
    }
    const n = Math.round(Number(charges));
    if (!Number.isFinite(n) || n < 1) {
      setErr({ text: 'Enter how many more payments to take — at least one.', detail: '' });
      return;
    }
    void run(
      'schedule',
      () => schedulePlan(planId, { charges: n }),
      `Saved — ${n} more payment${n === 1 ? '' : 's'}, then this plan stops.`,
      schedBtnRef,
    );
  };

  const kv: { k: string; v: ReactNode }[] = [
    { k: 'Donor', v: plan.donorName || '—' },
    { k: 'Email', v: plan.donorEmail || '—' },
    { k: 'Campaign', v: plan.campaignTitle || <span className="faint">not recorded</span> },
    { k: 'Amount', v: <strong><span className="num">{money(plan.amountMinor)}</span> {every}</strong> },
    { k: 'Status', v: status.text },
    { k: 'Started', v: formatDate(plan.startedAt, clock) || '—' },
    {
      k: 'Last charge',
      v: plan.lastChargeAt ? `${formatDate(plan.lastChargeAt, clock)} (${relativeTime(plan.lastChargeAt)})` : 'none yet',
    },
    {
      k: 'Next charge',
      v: plan.nextChargeAt
        ? `${formatDate(plan.nextChargeAt, clock)}${untilTime(plan.nextChargeAt) ? ` (${untilTime(plan.nextChargeAt)})` : ''}`
        : '—',
    },
    { k: 'Card', v: cardLine(plan) || '—' },
    { k: 'Collected so far', v: money(plan.totalMinor) },
    // The account's own name from OpenMasjidOS, never its vault id; '' is the primary account (the
    // resolver's 'local' standalone keys included, which were never something to show an admin).
    { k: 'Stripe account', v: plan.accountLabel || 'Primary' },
    // The kiosk's current name. A plan outlives the tablet it was set up on, and a device UUID in its
    // place told an admin nothing — so say what happened to it instead.
    { k: 'Set up on', v: plan.deviceName || (plan.deviceId ? 'A kiosk that has since been removed' : 'Not recorded') },
  ];

  return (
    <Modal titleId={titleId} onClose={onClose} className="modal--window">
      <div className="tl-bar tl-bar--static">
        <button type="button" className="tl tl--red" aria-label="Close" onClick={onClose}>
          <X size={9} strokeWidth={3} aria-hidden="true" />
        </button>
        <span className="tl tl--amber" aria-hidden="true" />
        <span className="tl tl--green" aria-hidden="true" />
      </div>
      <div className="modal-head">
        <div className="card-head__main">
          <h3 id={titleId} className="section-title-inline">{plan.donorName || plan.donorEmail || 'Recurring donation'}</h3>
          <p className="muted">
            <span className="num">{money(plan.amountMinor)}</span> {figures(every)}
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

        <Facts rows={kv} />
        {/* Stripe's subscription id — what you'd search for in the Stripe dashboard, and nothing a
            volunteer reading the window needs, so it sits behind a disclosure (spec §9). */}
        <details className="tech-details">
          <summary>Technical details</summary>
          <p className="hint">For looking this plan up in your Stripe dashboard.</p>
          <Facts rows={[{ k: 'Stripe plan ID', v: <code className="mono">{plan.id}</code> }]} />
        </details>

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
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-disabled={!idle}
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
                  {/* This plan's own amount and currency — never a hardcoded "$" (spec §10). */}
                  For a donor who's pledged “<span className="num">{money(plan.amountMinor)}</span> {figures(every)} until Ramadan” — Stripe keeps collecting
                  until then, and stops on its own.
                </p>
                {schedOpen ? (
                  <>
                    {/* Two buttons that pick an option, not tabs: there is no tab panel for them to
                        control, and a tablist promises arrow-key navigation this never had. */}
                    <div className="seg" role="group" aria-label="How should this plan end?">
                      <button
                        ref={schedFirstRef}
                        type="button"
                        aria-pressed={schedMode === 'date'}
                        className={`seg__opt${schedMode === 'date' ? ' seg__opt--on' : ''}`}
                        onClick={() => setSchedMode('date')}
                      >
                        <CalendarClock size={15} aria-hidden="true" /> On a date
                      </button>
                      <button
                        type="button"
                        aria-pressed={schedMode === 'charges'}
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
                          dir="ltr"
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
                      <button type="button" className="btn btn--primary btn--sm" aria-disabled={!idle} onClick={saveSchedule}>
                        {busy === 'schedule' ? (
                          <>
                            <Loader2 size={14} className="spin" aria-hidden="true" /> Saving…
                          </>
                        ) : (
                          'Save end date'
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-disabled={!idle}
                        onClick={() => step(() => setSchedOpen(false), schedBtnRef)}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="plan-act__row">
                    <button
                      ref={schedBtnRef}
                      type="button"
                      className="btn btn--ghost btn--sm"
                      aria-disabled={!idle}
                      onClick={() => step(() => setSchedOpen(true), schedFirstRef)}
                    >
                      <CalendarClock size={14} aria-hidden="true" /> {scheduledEnd ? 'Change the end date' : 'Set an end date'}
                    </button>
                    {scheduledEnd && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-disabled={!idle}
                        onClick={() =>
                          void run(
                            'clear',
                            () => schedulePlan(planId, { endAt: null }),
                            'End date cleared — this plan runs on until you stop it.',
                            schedBtnRef,
                          )
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
                    <button
                      ref={endBtnRef}
                      type="button"
                      className="btn btn--ghost btn--sm plan-end-btn"
                      onClick={() => setCancelStage('choose')}
                    >
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
                          donor's standing order to stop. Focus starts on it for the same reason — a
                          second Enter lands here too. */}
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-disabled={!idle}
                        autoFocus
                        onClick={() => step(() => setCancelStage(''), endBtnRef)}
                      >
                        Keep the plan
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-disabled={!idle}
                        onClick={() =>
                          void run(
                            'cancel',
                            () => cancelPlan(planId, false),
                            `Set to end after this ${plan.interval || 'period'} — no payments after that.`,
                            endBtnRef,
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
                      <button
                        ref={immediateBtnRef}
                        type="button"
                        className="btn btn--sm device-danger"
                        aria-disabled={!idle}
                        onClick={() => step(() => setCancelStage('confirm'))}
                      >
                        <Ban size={14} aria-hidden="true" /> End it immediately
                      </button>
                    </div>
                  </>
                )}
                {cancelStage === 'confirm' && (
                  <>
                    <p className="note-danger">
                      This ends <strong>{who}</strong>'s <span className="num">{money(plan.amountMinor)}</span> {figures(every)} donation right now. Stripe
                      won't collect it again and it can't be restarted from here — {who} would have to give monthly at
                      a kiosk again. To stop only the next payment, pause it instead.
                    </p>
                    <div className="plan-act__row" style={{ marginBlockStart: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn--sm device-danger"
                        aria-disabled={!idle}
                        onClick={() =>
                          void run('cancel-now', () => cancelPlan(planId, true), 'Ended — no further payments will be taken.', noteRef)
                        }
                      >
                        {busy === 'cancel-now' ? (
                          <>
                            <Loader2 size={14} className="spin" aria-hidden="true" /> Ending…
                          </>
                        ) : (
                          'Yes, end it now'
                        )}
                      </button>
                      {/* The harmless half of the pair takes focus, so a repeated Enter backs out. */}
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-disabled={!idle}
                        autoFocus
                        onClick={() => step(() => setCancelStage('choose'), immediateBtnRef)}
                      >
                        Go back
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* tabIndex -1 so focus can land on the outcome when the action removed the button that
              held it (a plan ended outright takes the whole actions section with it). */}
          {note && (
            <div ref={noteRef} tabIndex={-1}>
              <ResultLine ok>{note}</ResultLine>
            </div>
          )}
          {err && (
            <>
              <ResultLine ok={false}>{err.text}</ResultLine>
              {err.detail && (
                <details className="tech-details">
                  <summary>Technical details</summary>
                  <p className="mono">{err.detail}</p>
                </details>
              )}
            </>
          )}
        </div>

        {/* ── Invoice history ─────────────────────────────────────────────── */}
        <div className="plan-actions">
          <p className="plan-act__title">
            <CreditCard size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginInlineEnd: '0.3rem' }} />
            Payments on this plan
          </p>
          {loadErr && (
            <>
              <ResultLine ok={false}>{loadErr}</ResultLine>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setLoadErr('');
                  setAttempt((n) => n + 1);
                }}
              >
                <RefreshCw size={13} aria-hidden="true" /> Try again
              </button>
            </>
          )}
          {!invoices && !loadErr && <Skeleton rows={3} height="2.4rem" label="Loading this plan’s payments…" />}
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
    </Modal>
  );
}

/** One renewal. A failed one has to be unmissable — it's the only sign an admin gets that a donor's
 *  card has stopped working (Stripe emails them, we get no webhook). */
function InvoiceRow({ inv }: { inv: PlanInvoice }) {
  const clock = useClock();
  const tone = invoiceTone(inv);
  return (
    <li className={`inv-row inv-row--${tone}`}>
      <span className="inv-dot" aria-hidden="true" />
      <div className="inv-main">
        <div className="inv-top">
          <span className="inv-date">{figures(formatDate(inv.date, clock))}</span>
          <span className="inv-amt">{formatMoney(inv.amountMinor, inv.currency)}</span>
        </div>
        <span className="inv-sub">
          {invoiceLabel(inv)}
          {inv.attempts > 1 && <> · <span className="num">{inv.attempts}</span> attempts</>}
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
