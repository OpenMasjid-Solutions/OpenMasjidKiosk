// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Donations screen: what your kiosks have taken. Totals for today / this week / this month /
 *  all time (successful donations only), the full log (amount, kiosk, time, one-time vs monthly,
 *  donor if given, status), a per-kiosk breakdown, and a CSV export. Renewals of monthly
 *  subscriptions are charged by Stripe and shown in the Stripe dashboard, not here (LAN-only, no
 *  webhooks) — these totals are what the kiosks collected directly. Polls ~20s; fails soft. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Coins, Download, MonitorSmartphone, ReceiptText, TrendingUp, X } from 'lucide-react';
import { fetchDonationsCsv, getDonations, type Donation, type DonationsData } from './api';
import { formatMoney } from './money';

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

      {selected && <DonationModal d={selected} money={money} onClose={() => setSelected(null)} />}
    </section>
  );
}

function DonationRow({ d, money, onOpen }: { d: Donation; money: (m: number) => string; onOpen: () => void }) {
  const succeeded = d.status === 'succeeded';
  const who = d.donorName || d.donorEmail;
  return (
    <li>
      <button type="button" className="donation-row donation-row--btn" onClick={onOpen}>
        <div className="donation-row__main">
          <span className="donation-amt">{money(d.amountMinor)}</span>
          {d.kind === 'monthly' && <span className="badge badge--monthly">Monthly</span>}
          {!succeeded && <span className="status-pill">{d.status || 'unknown'}</span>}
        </div>
        <div className="donation-row__meta muted">
          {who ? `${who} · ` : ''}{d.campaignTitle ? `${d.campaignTitle} · ` : ''}{d.deviceName || 'Kiosk'} · {relativeTime(d.createdAt)}
        </div>
      </button>
    </li>
  );
}

/** A macOS-window-style detail popup for one donation (time, donor name/email, amount, campaign…). */
function DonationModal({ d, money, onClose }: { d: Donation; money: (m: number) => string; onClose: () => void }) {
  const succeeded = d.status === 'succeeded';
  const rows: { k: string; v: ReactNode }[] = [
    { k: 'Amount', v: <strong>{money(d.amountMinor)}</strong> },
    { k: 'Type', v: d.kind === 'monthly' ? 'Monthly' : 'One-time' },
    { k: 'Status', v: succeeded ? 'Succeeded' : (d.status || 'unknown') },
    { k: 'When', v: fullDateTime(d.createdAt) },
    { k: 'Campaign', v: d.campaignTitle || '—' },
    { k: 'Name', v: d.donorName || '—' },
    { k: 'Email', v: d.donorEmail || '—' },
    { k: 'Kiosk', v: d.deviceName || 'Kiosk' },
    { k: 'Payment ID', v: <code className="mono">{d.paymentIntentId}</code> },
  ];
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
          <div className="detail-amt">{money(d.amountMinor)}</div>
          <div className="kv">
            {rows.map((r) => (
              <div className="kv-row" key={r.k}>
                <span className="kv-k">{r.k}</span>
                <span className="kv-v">{r.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
