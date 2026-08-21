// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Donations screen: what your kiosks have taken. Totals for today / this week / this month /
 *  all time (successful donations only), the full log (amount, kiosk, time, one-time vs monthly,
 *  donor if given, status), a per-kiosk breakdown, and a CSV export. Renewals of monthly
 *  subscriptions are charged by Stripe and shown in the Stripe dashboard, not here (LAN-only, no
 *  webhooks) — these totals are what the kiosks collected directly. Polls ~20s; fails soft. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, CheckCircle2, Coins, Download, Loader2, MonitorSmartphone, ReceiptText, TrendingUp, Undo2, X } from 'lucide-react';
import { fetchDonationsCsv, getDonations, refundDonation, type Donation, type DonationsData, type RefundResult } from './api';
import { decimals as decimalsFor, formatMoney, toMinor } from './money';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

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

/** Full local date + time for the detail window, e.g. "8 Jul 2026, 3:14 PM". */
function fullDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function StatTile({ icon, label, value, sub, accent }: { icon: ReactNode; label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`stat-tile${accent ? ' stat-tile--accent' : ''}`}>
      <span className="stat-tile__icon" aria-hidden="true">{icon}</span>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__sub">{sub ?? ' '}</span>
    </div>
  );
}

export function DonationsSection() {
  const [data, setData] = useState<DonationsData | null>(null);
  const [err, setErr] = useState('');
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Donation | null>(null);

  const exportCsv = async () => {
    setErr('');
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
      setErr(errMsg(e));
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(async () => {
    try {
      setData(await getDonations());
      setErr('');
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => clearInterval(iv);
  }, [load]);

  if (!data) {
    return (
      <section className="glass panel">
        {err ? <p className="hint">We couldn't load donations just now — trying again shortly.</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const { totals, currency, donations } = data;
  const money = (m: number) => formatMoney(m, currency);

  return (
    <section className="metrics">
      <div className="stat-grid">
        <StatTile icon={<Coins size={17} />} label="All time" value={money(totals.allTime)} sub={`${totals.count} donation${totals.count === 1 ? '' : 's'}`} accent />
        <StatTile icon={<CalendarDays size={17} />} label="This month" value={money(totals.thisMonth)} />
        <StatTile icon={<TrendingUp size={17} />} label="This week" value={money(totals.thisWeek)} />
        <StatTile icon={<ReceiptText size={17} />} label="Today" value={money(totals.today)} sub={totals.count ? `avg ${money(totals.average)}` : ' '} />
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
                <span className="kv-k">{d.deviceName || 'Kiosk'} <span className="faint">· {d.count}</span></span>
                <span className="kv-v">{money(d.amountMinor)}</span>
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
            <button className="btn btn--ghost btn--sm" onClick={() => void exportCsv()} disabled={exporting} style={{ marginInlineStart: 'auto' }}>
              <Download size={14} aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          )}
        </div>

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
              <DonationRow key={d.id} d={d} money={money} onOpen={() => setSelected(d)} />
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <DonationModal
          d={selected}
          money={money}
          currency={currency}
          onClose={() => setSelected(null)}
          // Refetch so the row, the badges and above all the TOTALS reflect the refund at once —
          // otherwise the tiles keep showing money the masjid has just given back until the next poll.
          onRefunded={() => { void load(); }}
        />
      )}
    </section>
  );
}

function DonationRow({ d, money, onOpen }: { d: Donation; money: (m: number) => string; onOpen: () => void }) {
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
          {refunded && !fully && <span className="badge badge--refunded">{money(d.refundedMinor)} refunded</span>}
          {!succeeded && <span className="status-pill">{d.status || 'unknown'}</span>}
        </div>
        <div className="donation-row__meta muted">
          {who ? `${who} · ` : ''}{d.campaignTitle ? `${d.campaignTitle} · ` : ''}{d.deviceName || 'Kiosk'} · {relativeTime(d.createdAt)}
        </div>
      </button>
    </li>
  );
}

/** A macOS-window-style detail popup for one donation (time, donor name/email, amount, campaign…),
 *  and the one place a donation can be given back. */
function DonationModal({
  d: initial,
  money,
  currency,
  onClose,
  onRefunded,
}: {
  d: Donation;
  money: (m: number) => string;
  /** The ISO code, not just a formatter. See the decimals note below — deriving the scale from
   *  formatted output instead of the code is what made partial refunds give back 1/100th. */
  currency: string;
  onClose: () => void;
  onRefunded: (d: Donation) => void;
}) {
  const [d, setD] = useState(initial);
  const [stage, setStage] = useState<'view' | 'confirm'>('view');
  const [partial, setPartial] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('requested_by_customer');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<RefundResult | null>(null);
  /** How much THIS action gave back — the running total minus whatever had already been refunded
   *  when the window opened. Reporting the running total would tell an admin refunding the second
   *  half of a gift that they had just refunded the whole thing. */
  const justRefunded = done ? Math.max(0, done.refundedMinor - initial.refundedMinor) : 0;

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
  const typedMinor = toMinor(amountText.replace(/[^0-9.]/g, ''), currency);
  const wanted = partial ? typedMinor : remaining;
  const amountValid = !partial || (Number.isFinite(typedMinor) && typedMinor > 0 && typedMinor <= remaining);

  const rows: { k: string; v: ReactNode }[] = [
    { k: 'Amount', v: <strong>{money(d.amountMinor)}</strong> },
    ...(refunded
      ? [
          { k: 'Refunded', v: <strong className="text-warn">{money(d.refundedMinor)}</strong> },
          { k: 'Kept', v: <strong>{money(remaining)}</strong> },
          { k: 'Refunded on', v: d.refundedAt ? fullDateTime(d.refundedAt) : '—' },
        ]
      : []),
    { k: 'Type', v: d.kind === 'monthly' ? 'Monthly' : 'One-time' },
    { k: 'Status', v: succeeded ? 'Succeeded' : (d.status || 'unknown') },
    { k: 'When', v: fullDateTime(d.createdAt) },
    { k: 'Campaign', v: d.campaignTitle || '—' },
    { k: 'Name', v: d.donorName || '—' },
    { k: 'Email', v: d.donorEmail || '—' },
    { k: 'Kiosk', v: d.deviceName || 'Kiosk' },
    { k: 'Payment ID', v: <code className="mono">{d.paymentIntentId}</code> },
    ...(d.refundId ? [{ k: 'Refund ID', v: <code className="mono">{d.refundId}</code> }] : []),
  ];

  const doRefund = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await refundDonation(d.id, {
        ...(partial ? { amountMinor: wanted } : {}),
        reason,
      });
      setD(res.donation);
      setDone(res);
      setStage('view');
      onRefunded(res.donation); // refresh the list + totals behind the modal
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="modal glass-raised" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Donation details">
        <div className="tl-bar">
          <button type="button" className="tl tl--red" aria-label="Close" onClick={onClose}><X size={9} strokeWidth={3} /></button>
          <span className="tl tl--amber" aria-hidden="true" />
          <span className="tl tl--green" aria-hidden="true" />
        </div>
        <div className="modal-head">
          <div className="card-head__main">
            <h3 className="section-title-inline">Donation</h3>
            <p className="muted">{d.kind === 'monthly' ? 'Monthly donation' : 'One-time donation'}{succeeded ? '' : ' · ' + (d.status || 'unknown')}</p>
          </div>
        </div>
        <div className="modal-body">
          <div className={`detail-amt${refunded && remaining <= 0 ? ' detail-amt--refunded' : ''}`}>{money(d.amountMinor)}</div>
          <div className="kv">
            {rows.map((r) => (
              <div className="kv-row" key={r.k}>
                <span className="kv-k">{r.k}</span>
                <span className="kv-v">{r.v}</span>
              </div>
            ))}
          </div>

          <div className="plan-actions">
            {/* What actually happened, once. Spells out the two things an admin cannot see from the
                row: whether the donor was actually told, and that a monthly plan keeps running. */}
            {done && (
              <div className="plan-act" role="status">
                <p className="plan-note">
                  <CheckCircle2 size={15} aria-hidden="true" />
                  <span>
                    <strong>{money(justRefunded)} refunded.</strong> It goes back to the donor’s card automatically — most
                    banks show it within 5–10 working days.
                  </span>
                </p>
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

            {err && <p className="form-error" role="alert">{err}</p>}

            {stage === 'view' && canRefund && !done && (
              <div className="plan-act">
                <p className="plan-act__title">Refund</p>
                <p className="hint">
                  {refunded
                    ? `${money(d.refundedMinor)} of this donation has already been given back.`
                    : 'Gives the money back to the donor’s card.'}
                </p>
                <div className="plan-act__row">
                  <button type="button" className="btn btn--sm device-danger" onClick={() => { setStage('confirm'); setErr(''); }}>
                    <Undo2 size={14} aria-hidden="true" /> {refunded ? `Refund the remaining ${money(remaining)}` : 'Refund this donation'}
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
                  <strong>{money(amountValid ? wanted : remaining)}</strong> returns to the donor’s card. This can’t be undone
                  from here.
                </p>
                <label className="toggle-row">
                  <span className="toggle-text">
                    <span className="toggle-label">Refund only part of it</span>
                    <span className="hint">Otherwise the whole {money(remaining)} goes back.</span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={partial}
                    aria-label="Refund only part of it"
                    className={`switch${partial ? ' switch--on' : ''}`}
                    onClick={() => { setPartial((p) => !p); setAmountText(''); }}
                  >
                    <span className="switch-knob" />
                  </button>
                </label>
                {partial && (
                  <div className="field">
                    <label className="label" htmlFor="refund-amt">Amount to refund (up to {money(remaining)})</label>
                    <input
                      id="refund-amt"
                      className="input"
                      inputMode="decimal"
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
                    This is a <strong>monthly</strong> donation. Refunding this payment does <strong>not</strong> cancel the
                    standing order — end it on the Recurring page too, or they’ll be charged again next month.
                  </p>
                )}
                <div className="plan-act__row">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setStage('view')} disabled={busy}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn--sm device-danger" onClick={doRefund} disabled={busy || !amountValid}>
                    {busy ? (
                      <>
                        <Loader2 size={14} className="spin" aria-hidden="true" /> Refunding…
                      </>
                    ) : (
                      `Refund ${money(amountValid ? wanted : remaining)}`
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
