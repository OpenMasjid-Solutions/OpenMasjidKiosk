// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Donations screen: what your kiosks have taken. Totals for today / this week / this month /
 *  all time (successful donations only), the full log (amount, kiosk, time, one-time vs monthly,
 *  donor if given, status), a per-kiosk breakdown, and a CSV export. Renewals of monthly
 *  subscriptions are charged by Stripe and shown in the Stripe dashboard, not here (LAN-only, no
 *  webhooks) — these totals are what the kiosks collected directly. Polls ~20s; fails soft. */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { CalendarDays, CheckCircle2, Coins, Download, Info, Loader2, MonitorSmartphone, ReceiptText, TrendingUp, TriangleAlert, Undo2, X } from 'lucide-react';
import { ApiError, errorText, fetchDonationsCsv, getDonations, refundDonation, type Donation, type DonationsData, type RefundResult } from './api';
import { formatDateTime, relativeTime } from './dates';
import { Modal } from './modal';
import { decimals as decimalsFor, formatMoney, toMinor } from './money';
import { figures, ResultLine, Skeleton, Toggle, useClock } from './ui';

/** A donation's status in words a volunteer can act on. The server records Stripe's own
 *  PaymentIntent status verbatim, so without this a row read "requires_payment_method" — which looks
 *  like the app breaking, when all that happened is a card that didn't go through. Every wording for
 *  a gift that didn't complete says whether money moved, because that is the question an admin
 *  opening the row is asking (and the one a worried donor will ask them). */
function donationStatusWords(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'Paid';
    case 'requires_payment_method':
      return 'Card didn’t go through — no money taken';
    case 'canceled':
      return 'Canceled — no money taken';
    case 'requires_capture':
    case 'processing':
      return 'Still being confirmed with Stripe';
    case 'requires_action':
      return 'Waiting on the donor’s bank';
    default:
      return 'Not completed';
  }
}

/**
 * A polite, screen-reader-only announcement of something that changed ON ITS OWN — a new donation
 * arriving on a poll (spec §7: live regions for anything that changes by itself). Never the clock,
 * never a donor's name: only the transition.
 *
 * The text is cleared a few seconds after it is set, because a live region only speaks when its text
 * CHANGES. A one-kiosk masjid taking two $10 preset gifts on consecutive polls would otherwise produce
 * the identical sentence twice, and the second gift would arrive in silence.
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

/** "New donation: $25 at Foyer." — amount and kiosk only. A donor's name must never be read out: the
 *  admin may be screen-sharing, or reading this aloud in a room. */
function newDonationsSentence(fresh: Donation[], pageCurrency: string): string {
  const latest = fresh[0]; // the list is newest first
  const what = `${formatMoney(latest.amountMinor, latest.currency || pageCurrency)} at ${latest.deviceName || 'a kiosk'}`;
  return fresh.length === 1 ? `New donation: ${what}.` : `${fresh.length} new donations — the latest ${what}.`;
}

function StatTile({
  i,
  icon,
  label,
  value,
  sub,
  accent,
}: {
  /** Position in the grid, for its one-time staggered entrance (.stagger in app.css). */
  i: number;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat-tile${accent ? ' stat-tile--accent' : ''}`} style={{ '--i': i } as CSSProperties}>
      <span className="stat-tile__icon" aria-hidden="true">{icon}</span>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__sub">{figures(sub ?? ' ')}</span>
    </div>
  );
}

/** A label/value list — the donation window's facts, and the technical ids behind their disclosure. */
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

export function DonationsSection() {
  // Re-render when the masjid's locale, zone or hour cycle load: every amount and date below uses them.
  useClock();
  const [data, setData] = useState<DonationsData | null>(null);
  const [err, setErr] = useState('');
  // The export's failure is its OWN message. It used to share `err` with the poll, so a failed export
  // was reported as "Couldn't refresh just now" — a different failure, with nothing to do about it —
  // and the next poll then wiped even that.
  const [exportErr, setExportErr] = useState('');
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Donation | null>(null);
  const [announcement, announce] = useAnnouncer();
  /** Every donation id the last load returned — null until the first load, which announces nothing
   *  (the list the admin opened the page to is not "new"). */
  const known = useRef<Set<string> | null>(null);

  const exportCsv = async () => {
    // aria-disabled, not disabled, on the button: disabling the control that has focus drops a
    // keyboard user back to the top of the document mid-export.
    if (exporting) return;
    setExportErr('');
    setExporting(true);
    try {
      const blob = await fetchDonationsCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'donations.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportErr(errorText(e, 'Couldn’t export the donations just now. Please try again.'));
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const next = await getDonations();
      const seen = known.current;
      known.current = new Set(next.donations.map((d) => d.id));
      if (seen) {
        // Only gifts that actually went through: a declined card is not news to announce.
        const fresh = next.donations.filter((d) => d.status === 'succeeded' && !seen.has(d.id));
        if (fresh.length) announce(newDonationsSentence(fresh, next.currency));
      }
      setData(next);
      setErr('');
    } catch (e) {
      setErr(errorText(e));
    }
  }, [announce]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => clearInterval(iv);
  }, [load]);

  if (!data) {
    if (err) {
      return (
        <section className="glass panel">
          <p className="hint">We couldn't load donations just now — trying again shortly.</p>
        </section>
      );
    }
    // Shaped like what is coming (spec §5: a skeleton, never a bare "Loading…"). The tiles are the
    // same StatTiles at the same place in the tree as the loaded grid below, so React keeps their
    // nodes when the data lands — their entrance plays once, here, and does not replay on arrival.
    const pending = <span className="skeleton" aria-hidden="true" />;
    return (
      <section className="metrics">
        <div className="stat-grid stagger" aria-busy="true">
          <StatTile i={0} icon={<Coins size={17} />} label="All time" value={pending} accent />
          <StatTile i={1} icon={<CalendarDays size={17} />} label="This month" value={pending} />
          <StatTile i={2} icon={<TrendingUp size={17} />} label="This week" value={pending} />
          <StatTile i={3} icon={<ReceiptText size={17} />} label="Today" value={pending} />
        </div>
        <section className="glass panel">
          <Skeleton rows={5} height="2.6rem" label="Loading donations…" />
        </section>
      </section>
    );
  }

  const { totals, currency, donations } = data;
  // The TOTALS are in the page's currency, because the server only totals donations in it. Rows and
  // the detail window are not — see DonationRow.
  const money = (m: number) => formatMoney(m, currency);

  return (
    <section className="metrics">
      <div className="stat-grid stagger">
        <StatTile i={0} icon={<Coins size={17} />} label="All time" value={money(totals.allTime)} sub={`${totals.count} donation${totals.count === 1 ? '' : 's'}`} accent />
        <StatTile i={1} icon={<CalendarDays size={17} />} label="This month" value={money(totals.thisMonth)} />
        <StatTile i={2} icon={<TrendingUp size={17} />} label="This week" value={money(totals.thisWeek)} />
        <StatTile i={3} icon={<ReceiptText size={17} />} label="Today" value={money(totals.today)} sub={totals.count ? `avg ${money(totals.average)}` : ' '} />
      </div>

      {/* Per-kiosk breakdown (only when more than one kiosk has taken money) */}
      {totals.byDevice.length > 1 && (
        <section className="glass panel">
          <div className="card-head">
            <MonitorSmartphone size={18} className="panel-ico" aria-hidden="true" />
            <div className="card-head__main">
              <h2 className="section-title-inline">By kiosk</h2>
              <p className="muted">Successful donations per tablet.</p>
            </div>
          </div>
          <div className="kv">
            {totals.byDevice.map((d) => (
              <div className="kv-row" key={d.deviceId}>
                <span className="kv-k">{d.deviceName || 'Kiosk'} <span className="faint">· <span className="num">{d.count}</span></span></span>
                <span className="kv-v num">{money(d.amountMinor)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="glass panel">
        <div className="card-head">
          <Coins size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Donations</h2>
            <p className="muted">Every donation your kiosks have taken, newest first.</p>
          </div>
          {donations.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void exportCsv()}
              aria-disabled={exporting}
              style={{ marginInlineStart: 'auto' }}
            >
              <Download size={14} aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          )}
        </div>

        {exportErr && <ResultLine ok={false}>{exportErr}</ResultLine>}
        {err && <p className="hint">Couldn't refresh just now — showing the last known list.</p>}

        {donations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-emblem" aria-hidden="true"><Coins size={26} /></div>
            <p className="empty-title">No donations yet</p>
            <p className="muted">They'll appear here as soon as your kiosks start taking payments.</p>
          </div>
        ) : (
          <ul className="donation-list">
            {donations.map((d) => (
              <DonationRow key={d.id} d={d} currency={d.currency || currency} onOpen={() => setSelected(d)} />
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <DonationModal
          d={selected}
          currency={selected.currency || currency}
          onClose={() => setSelected(null)}
          // Refetch so the row, the badges and above all the TOTALS reflect the refund at once —
          // otherwise the tiles keep showing money the masjid has just given back until the next poll.
          onRefunded={() => { void load(); }}
        />
      )}

      {/* Last in the tree on purpose: anything inserted before the stat grid would shift it to a new
          position and make React rebuild it, replaying the entrance the skeleton already played. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    </section>
  );
}

/** One row of the log. `currency` is THIS DONATION's own, not the page's: the server keeps
 *  other-currency rows in the log on purpose, and after an admin switched USD to KWD a $100 gift
 *  (10000 minor units) was being read out as "KWD 10.000". */
function DonationRow({ d, currency, onOpen }: { d: Donation; currency: string; onOpen: () => void }) {
  useClock();
  const money = (m: number) => formatMoney(m, currency);
  const succeeded = d.status === 'succeeded';
  const who = d.donorName || d.donorEmail;
  const refunded = d.refundedMinor > 0;
  const fully = refunded && d.refundedMinor >= d.amountMinor;
  return (
    <li>
      <button type="button" className="donation-row donation-row--btn" onClick={onOpen}>
        <div className="donation-row__main">
          {/* Struck through once fully given back, so a glance down the list never reads a refunded
              gift as money the masjid still has. A partial keeps its amount and says how much went. */}
          <span className={`donation-amt${fully ? ' donation-amt--refunded' : ''}`}>{money(d.amountMinor)}</span>
          {d.kind === 'monthly' && <span className="badge badge--monthly">Monthly</span>}
          {fully && <span className="badge badge--refunded">Refunded</span>}
          {refunded && !fully && <span className="badge badge--refunded"><span className="num">{money(d.refundedMinor)}</span> refunded</span>}
          {!succeeded && <span className="status-pill">{donationStatusWords(d.status)}</span>}
        </div>
        <div className="donation-row__meta muted">
          {/* Relative, not a date — so no Hijri and no zone (spec §10 is about dates). */}
          {who ? `${who} · ` : ''}{d.campaignTitle ? `${d.campaignTitle} · ` : ''}{d.deviceName || 'Kiosk'} · {figures(relativeTime(d.createdAt))}
        </div>
      </button>
    </li>
  );
}

/** A macOS-window-style detail popup for one donation (time, donor name/email, amount, campaign…),
 *  and the one place a donation can be given back. */
function DonationModal({
  d: initial,
  currency,
  onClose,
  onRefunded,
}: {
  d: Donation;
  /** The ISO code, not just a formatter. See the decimals note below — deriving the scale from
   *  formatted output instead of the code is what made partial refunds give back 1/100th. And it is
   *  THIS DONATION's code, not the page's: typing 5 into the refund box on a dollar gift while the
   *  page was set to KWD sent 5000 minor units — $50 back, while the admin believed it was 5 KWD. */
  currency: string;
  onClose: () => void;
  onRefunded: (d: Donation) => void;
}) {
  const clock = useClock();
  const titleId = useId();
  const money = (m: number) => formatMoney(m, currency);
  const [d, setD] = useState(initial);
  const [stage, setStage] = useState<'view' | 'confirm'>('view');
  const [partial, setPartial] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('requested_by_customer');
  const [busy, setBusy] = useState(false);
  // What went wrong, in words — and separately whatever Stripe itself said, which only goes behind a
  // "Technical details" disclosure (spec §9: never a raw error on the main line).
  const [err, setErr] = useState<{ text: string; detail: string } | null>(null);
  const [done, setDone] = useState<RefundResult | null>(null);
  /** How much THIS action gave back — the running total minus whatever had already been refunded
   *  when the window opened. Reporting the running total would tell an admin refunding the second
   *  half of a gift that they had just refunded the whole thing. */
  const justRefunded = done ? Math.max(0, done.refundedMinor - initial.refundedMinor) : 0;

  // Focus has to go somewhere sensible whenever a stage swap removes the button that held it — or a
  // keyboard user is dropped back at the start of the window with no idea what happened. Set just
  // before the state change; the effect below moves focus once the new stage is on screen.
  const refundBtnRef = useRef<HTMLButtonElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<RefObject<HTMLElement | null> | null>(null);
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    want.current?.focus();
  });

  const succeeded = d.status === 'succeeded';
  const remaining = d.amountMinor - d.refundedMinor;
  const refunded = d.refundedMinor > 0;
  const canRefund = succeeded && remaining > 0;

  // Minor units from what was typed. The scale comes from the CURRENCY CODE, via the same helper
  // the giving designer and the totals use — never from formatted output.
  //
  // It used to sniff it: `money(0).…includes('.') ? 2 : 0`. That looked defensive and was wrong for
  // every currency at once, because `formatMoney` drops the decimals on a whole number — so
  // `money(0)` is "$0", never "$0.00", and the sniff therefore always answered 0. An admin giving
  // back $50 of a $100 donation typed 50 and refunded **$0.50**, while the placeholder below (also
  // computed from this number) told them to type 10000. Three-decimal currencies were out by 1000.
  const decimals = decimalsFor(currency);
  const typedMinor = toMinor(amountText, currency);
  const wanted = partial ? typedMinor : remaining;
  const amountValid = !partial || (Number.isFinite(typedMinor) && typedMinor > 0 && typedMinor <= remaining);

  const rows: { k: string; v: ReactNode }[] = [
    { k: 'Amount', v: <strong className="num">{money(d.amountMinor)}</strong> },
    ...(refunded
      ? [
          { k: 'Refunded', v: <strong className="num text-warn">{money(d.refundedMinor)}</strong> },
          { k: 'Kept', v: <strong className="num">{money(remaining)}</strong> },
          { k: 'Refunded on', v: (d.refundedAt && formatDateTime(d.refundedAt, clock)) || '—' },
        ]
      : []),
    { k: 'Type', v: d.kind === 'monthly' ? 'Monthly' : 'One-time' },
    { k: 'Status', v: donationStatusWords(d.status) },
    // The masjid's zone and hour cycle, with the Hijri date beside it — not this browser's (spec §10).
    { k: 'When', v: formatDateTime(d.createdAt, clock) || '—' },
    { k: 'Campaign', v: d.campaignTitle || '—' },
    { k: 'Name', v: d.donorName || '—' },
    { k: 'Email', v: d.donorEmail || '—' },
    { k: 'Kiosk', v: d.deviceName || 'Kiosk' },
  ];
  // Stripe's own ids: what you'd paste into the Stripe dashboard's search, and nothing a volunteer
  // reading the window needs — so they sit behind a disclosure rather than in the facts above.
  const techRows: { k: string; v: ReactNode }[] = [
    { k: 'Stripe payment ID', v: <code className="mono">{d.paymentIntentId}</code> },
    ...(d.refundId ? [{ k: 'Stripe refund ID', v: <code className="mono">{d.refundId}</code> }] : []),
  ];

  const openConfirm = () => {
    setStage('confirm');
    setErr(null);
  };

  const backToView = () => {
    if (busy) return;
    focusNext.current = refundBtnRef;
    setStage('view');
  };

  const doRefund = async () => {
    // The button stays focusable while this runs (aria-disabled), so the guard lives here.
    if (busy || !amountValid) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await refundDonation(d.id, {
        ...(partial ? { amountMinor: wanted } : {}),
        reason,
      });
      // The Refund button is about to disappear; land on what happened instead.
      focusNext.current = outcomeRef;
      setD(res.donation);
      setDone(res);
      setStage('view');
      onRefunded(res.donation); // refresh the list + totals behind the modal
    } catch (e) {
      setErr({
        text: errorText(e, 'The refund didn’t go through, so no money has moved. Try again, or check the Stripe dashboard.'),
        detail: e instanceof ApiError ? e.detail : '',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal titleId={titleId} onClose={onClose}>
      <div className="tl-bar tl-bar--static">
        <button type="button" className="tl tl--red" aria-label="Close" onClick={onClose}><X size={9} strokeWidth={3} aria-hidden="true" /></button>
        <span className="tl tl--amber" aria-hidden="true" />
        <span className="tl tl--green" aria-hidden="true" />
      </div>
      <div className="modal-head">
        <div className="card-head__main">
          <h3 id={titleId} className="section-title-inline">Donation</h3>
          <p className="muted">{d.kind === 'monthly' ? 'Monthly donation' : 'One-time donation'}{succeeded ? '' : ' · ' + donationStatusWords(d.status)}</p>
        </div>
      </div>
      <div className="modal-body">
        <div className={`detail-amt${refunded && remaining <= 0 ? ' detail-amt--refunded' : ''}`}>{money(d.amountMinor)}</div>
        <Facts rows={rows} />
        <details className="tech-details">
          <summary>Technical details</summary>
          <p className="hint">For looking this donation up in your Stripe dashboard.</p>
          <Facts rows={techRows} />
        </details>

        <div className="plan-actions">
          {/* What actually happened, once. Spells out the two things an admin cannot see from the
              row: whether the donor was actually told, and that a monthly plan keeps running.
              One live region for the whole block, so its first line is drawn with the .result classes
              rather than a <ResultLine> — that carries a live role of its own, and nesting two would
              have the headline read out twice. Focus lands here too (tabIndex -1): the Refund button
              that held it has just gone. */}
          {done && (
            <div className="plan-act" role="status" ref={outcomeRef} tabIndex={-1}>
              {/* Only "succeeded" is a refund Stripe has finished. "pending" is real but not done yet,
                  and anything else is unconfirmed — telling an admin "refunded" then would have them
                  reassure a donor about money that may not be on its way (spec §9). */}
              {done.status === 'succeeded' ? (
                <p className="result result--ok">
                  <CheckCircle2 size={15} aria-hidden="true" />
                  <span>
                    <strong><span className="num">{money(justRefunded)}</span> refunded.</strong> It goes back to the donor’s card automatically — most
                    banks show it within 5–10 business days.
                  </span>
                </p>
              ) : done.status === 'pending' ? (
                <p className="result result--info">
                  <Info size={15} aria-hidden="true" />
                  <span>
                    <strong><span className="num">{money(justRefunded)}</span> refund requested</strong> — Stripe is still processing it. It usually
                    completes within a day; check the Stripe dashboard if it doesn’t.
                  </span>
                </p>
              ) : (
                <p className="result result--bad">
                  <TriangleAlert size={15} aria-hidden="true" />
                  <span>Stripe hasn’t confirmed this refund yet — check the Stripe dashboard before telling the donor.</span>
                </p>
              )}
              {done.donorEmailAddress ? (
                <p className="hint">
                  {done.donorEmailed
                    ? `We emailed ${done.donorEmailAddress}.`
                    : `We could NOT email ${done.donorEmailAddress} — please contact them yourself.`}
                </p>
              ) : (
                <p className="hint">This donor didn’t leave an email address, so they haven’t been told.</p>
              )}
              {done.monthlyStillLive && (
                <p className="note-amber">
                  This donor has a <strong>monthly plan and it is still running</strong> — refunding a payment doesn’t
                  cancel it. End it on the Recurring page if they asked to stop.
                </p>
              )}
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

          {stage === 'view' && canRefund && !done && (
            <div className="plan-act">
              <p className="plan-act__title">Refund</p>
              <p className="hint">
                {refunded
                  ? figures(`${money(d.refundedMinor)} of this donation has already been given back.`)
                  : 'Gives the money back to the donor’s card.'}
              </p>
              <div className="plan-act__row">
                <button ref={refundBtnRef} type="button" className="btn btn--sm device-danger" onClick={openConfirm}>
                  <Undo2 size={14} className="rtl-flip" aria-hidden="true" /> {refunded ? figures(`Refund the remaining ${money(remaining)}`) : 'Refund this donation'}
                </button>
              </div>
            </div>
          )}
          {stage === 'view' && succeeded && remaining <= 0 && !done && (
            <p className="hint">This donation has been refunded in full.</p>
          )}
          {stage === 'view' && !succeeded && <p className="hint">Only a successful donation can be refunded.</p>}

          {stage === 'confirm' && (
            <div className="plan-act">
              <p className="plan-act__title">Give this donation back?</p>
              <p className="note-danger">
                <strong className="num">{money(amountValid ? wanted : remaining)}</strong> returns to the donor’s card. This can’t be undone
                from here.
              </p>
              <Toggle
                label="Refund only part of it"
                hint={figures(`Otherwise the whole ${money(remaining)} goes back.`)}
                checked={partial}
                onChange={(v) => {
                  setPartial(v);
                  setAmountText('');
                }}
              />
              {partial && (
                <div className="field">
                  <label className="label" htmlFor="refund-amt">Amount to refund (up to <span className="num">{money(remaining)}</span>)</label>
                  <input
                    id="refund-amt"
                    className="input"
                    inputMode="decimal"
                    dir="ltr"
                    value={amountText}
                    onChange={(e) => setAmountText(e.target.value)}
                    placeholder={(remaining / 10 ** decimals).toFixed(decimals)}
                    aria-invalid={!amountValid}
                  />
                </div>
              )}
              <div className="field">
                <label className="label" htmlFor="refund-reason">Reason (recorded in Stripe)</label>
                <select id="refund-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="requested_by_customer">The donor asked for it back</option>
                  <option value="duplicate">Duplicate payment</option>
                  <option value="fraudulent">Fraudulent</option>
                </select>
              </div>
              {d.kind === 'monthly' && (
                <p className="note-amber">
                  This is a <strong>monthly</strong> donation. Refunding this payment does <strong>not</strong> end their
                  monthly plan — end it on the Recurring page too, or they’ll be charged again next month.
                </p>
              )}
              <div className="plan-act__row">
                {/* Focus starts on the harmless choice: an Enter pressed twice on the Refund button
                    that opened this step backs out rather than giving money away. */}
                <button type="button" className="btn btn--ghost btn--sm" onClick={backToView} aria-disabled={busy} autoFocus>
                  Cancel
                </button>
                {/* `disabled` only for an amount that can't be refunded — focus is in the amount box
                    when that happens, never on this button. While the refund RUNS it is aria-disabled
                    instead: this is the button that was just pressed, and disabling a focused control
                    throws a keyboard user out to the top of the document. */}
                <button
                  type="button"
                  className="btn btn--sm device-danger"
                  onClick={() => void doRefund()}
                  disabled={!amountValid}
                  aria-disabled={busy}
                >
                  {busy ? (
                    <>
                      <Loader2 size={14} className="spin" aria-hidden="true" /> Refunding…
                    </>
                  ) : (
                    figures(`Refund ${money(amountValid ? wanted : remaining)}`)
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
