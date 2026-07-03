// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The in-app Stripe setup screen, shown as the first card in the Settings tab. It lets a
 *  volunteer: pick a Stripe account from the OpenMasjidOS Fabric (or enter keys manually
 *  when running standalone), choose a currency, record the masjid's details, and register
 *  the card reader's Terminal Location — then test the whole thing. No secret key is ever
 *  shown or sent here; the server keeps it in memory only. Every call fails soft to a
 *  friendly inline message, never a crash. Matches the admin design language (glass cards,
 *  design tokens, RTL-safe logical spacing, reduced-motion respected). */
import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Landmark,
  Loader2,
  MapPin,
  PlugZap,
  Wallet,
} from 'lucide-react';
import {
  chooseLocation,
  createLocation,
  getPayments,
  listLocations,
  saveMasjid,
  setCurrency,
  setLocalKeys,
  setStripeAccount,
  testPayments,
  type CreateLocationAddress,
  type MasjidAddress,
  type PaymentsStatus,
  type TerminalLocation,
  type TestPaymentsResult,
  type VerifyResult,
} from './api';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');
/** "test mode" / "live mode" / "" — empty when the mode is unknown, so callers can drop it. */
const modeLabel = (m?: string) => (m === 'test' ? 'test mode' : m === 'live' ? 'live mode' : '');
/** A currency clause like " (test mode)" only when the mode is known. */
const modeSuffix = (m?: string) => (modeLabel(m) ? ` (${modeLabel(m)})` : '');

// A friendly common set; the masjid's current currency is always kept in the list.
const CURRENCIES = ['usd', 'gbp', 'eur', 'cad', 'aud', 'myr', 'pkr', 'inr', 'aed', 'sar'];

/** Header: title, TEST MODE badge, and a ready / not-set-up status pill. */
function Header({ status }: { status: PaymentsStatus }) {
  const ready = !!status.resolved?.configured;
  return (
    <div className="card-head">
      <CreditCard size={18} className="panel-ico" aria-hidden="true" />
      <div className="card-head__main">
        <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 className="section-title-inline">Payments</h2>
          {status.testMode && <span className="badge badge--test">Test mode</span>}
          {ready ? (
            <span className="status-pill status-pill--ok">
              <span className="status-dot" /> Ready to take payments
            </span>
          ) : (
            <span className="status-pill">Not set up yet</span>
          )}
        </div>
        <p className="muted" style={{ marginBlockStart: '0.35rem' }}>
          Connect Stripe so your kiosks can take card donations.
        </p>
      </div>
    </div>
  );
}

/** Manual key entry — the standalone fallback (primary when not embedded, an advanced
 *  disclosure when embedded). Never renders an existing secret; the server only tells us
 *  whether one is set. */
function ManualKeys({ status, onStatus }: { status: PaymentsStatus; onStatus: (s: PaymentsStatus) => void }) {
  const local = status.local;
  const [pk, setPk] = useState(local.publishableKey);
  const [sk, setSk] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [verify, setVerify] = useState<VerifyResult | null>(null);

  const save = async () => {
    setErr('');
    setVerify(null);
    setBusy(true);
    try {
      const body: { publishableKey?: string; secretKey?: string } = {};
      if (pk.trim()) body.publishableKey = pk.trim();
      if (sk.trim()) body.secretKey = sk.trim();
      const res = await setLocalKeys(body);
      onStatus(res);
      setSk('');
      setVerify(res.verify ?? null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-manual glass-inset">
      <div className="field">
        <label className="label" htmlFor="pay-pk">Publishable key</label>
        <input
          id="pay-pk"
          className="input"
          value={pk}
          onChange={(e) => setPk(e.target.value)}
          placeholder="pk_live_… or pk_test_…"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="pay-sk">Secret key</label>
        <input
          id="pay-sk"
          className="input"
          type="password"
          value={sk}
          onChange={(e) => setSk(e.target.value)}
          placeholder={local.hasSecretKey ? '•••• set — leave blank to keep' : 'sk_live_… or sk_test_…'}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="hint">Kept in the server's memory only — never shown again and never sent to a tablet.</p>
      </div>
      {local.keysMismatch && <p className="form-error">These keys look like they're from different Stripe accounts.</p>}
      {err && <p className="form-error">{err}</p>}
      {verify && (
        <p
          className={verify.ok ? 'status-pill status-pill--ok' : 'hint'}
          style={{ marginBlockEnd: '0.6rem', display: verify.ok ? 'inline-flex' : 'block' }}
        >
          {verify.ok
            ? `Stripe accepted the key${modeSuffix(verify.mode)}.`
            : verify.message || "Stripe couldn't verify that key."}
        </p>
      )}
      <button className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>
        {busy ? (
          <>
            <Loader2 size={15} className="spin" /> Saving…
          </>
        ) : (
          'Save keys'
        )}
      </button>
    </div>
  );
}

/** Stripe account: the Fabric picker when embedded, plus the manual-key fallback. */
function StripeAccount({ status, onStatus }: { status: PaymentsStatus; onStatus: (s: PaymentsStatus) => void }) {
  const fabric = status.fabric;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showManual, setShowManual] = useState(!fabric.available);

  const choose = async (id: string) => {
    if (id === fabric.chosenId) return;
    setErr('');
    setBusy(true);
    try {
      onStatus(await setStripeAccount(id));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <Landmark size={16} /> Stripe account
      </div>

      {fabric.available ? (
        <>
          <div className="field">
            <label className="label" htmlFor="pay-acct">Choose a Stripe account</label>
            <select
              id="pay-acct"
              className="input"
              value={fabric.chosenId}
              disabled={busy}
              onChange={(e) => void choose(e.target.value)}
            >
              <option value="">Select an account…</option>
              {fabric.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>
          {fabric.status && (
            <p
              className={fabric.status.configured ? 'status-pill status-pill--ok' : 'hint'}
              style={{ marginBlockEnd: '0.6rem', display: fabric.status.configured ? 'inline-flex' : 'block' }}
            >
              {fabric.status.configured
                ? `Connected${modeLabel(fabric.status.mode) ? ` in ${modeLabel(fabric.status.mode)}` : ''}.`
                : 'This account has no keys yet — add them in OpenMasjidOS.'}
            </p>
          )}
          <p className="hint">Add or manage Stripe accounts in OpenMasjidOS → Settings → Payments.</p>
        </>
      ) : (
        <p className="hint" style={{ marginBlockEnd: '0.6rem' }}>
          Running standalone — enter your Stripe keys below to take payments.
        </p>
      )}

      {err && <p className="form-error">{err}</p>}

      {fabric.available && (
        <button
          className="btn btn--ghost btn--sm pay-disclose"
          onClick={() => setShowManual((v) => !v)}
          aria-expanded={showManual}
        >
          <ChevronDown size={15} className={showManual ? 'pay-chev pay-chev--open' : 'pay-chev'} /> Enter keys manually
        </button>
      )}
      {showManual && <ManualKeys status={status} onStatus={onStatus} />}
    </div>
  );
}

/** Currency for donations (Stripe-style lowercase codes, shown uppercase). */
function Currency({ status, onStatus }: { status: PaymentsStatus; onStatus: (s: PaymentsStatus) => void }) {
  const cur = (status.currency || 'usd').toLowerCase();
  const opts = Array.from(new Set([...CURRENCIES, cur]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const change = async (c: string) => {
    setErr('');
    setBusy(true);
    try {
      onStatus(await setCurrency(c));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <Wallet size={16} /> Currency
      </div>
      <div className="field">
        <label className="label" htmlFor="pay-cur">Donation currency</label>
        <select id="pay-cur" className="input" value={cur} disabled={busy} onChange={(e) => void change(e.target.value)}>
          {opts.map((c) => (
            <option key={c} value={c}>{c.toUpperCase()}</option>
          ))}
        </select>
      </div>
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}

/** Masjid name + address — used to name/address the reader's Stripe Terminal Location. */
function MasjidDetails({ status, refresh }: { status: PaymentsStatus; refresh: () => Promise<void> }) {
  const [name, setName] = useState(status.masjid.name);
  const [addr, setAddr] = useState<MasjidAddress>(status.masjid.address);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const set = (k: keyof MasjidAddress, v: string) => {
    setAddr((a) => ({ ...a, [k]: v }));
    setDone(false);
  };

  const save = async () => {
    setErr('');
    setDone(false);
    setBusy(true);
    try {
      await saveMasjid({ name: name.trim(), address: addr });
      await refresh();
      setDone(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <Building2 size={16} /> Masjid details
      </div>
      <p className="hint" style={{ marginBlockEnd: '0.7rem' }}>Used to register your card reader's location with Stripe.</p>

      <div className="field">
        <label className="label" htmlFor="mj-name">Masjid name</label>
        <input
          id="mj-name"
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDone(false);
          }}
          autoComplete="organization"
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="mj-l1">Address line 1</label>
        <input id="mj-l1" className="input" value={addr.line1} onChange={(e) => set('line1', e.target.value)} autoComplete="address-line1" />
      </div>
      <div className="field">
        <label className="label" htmlFor="mj-l2">
          Address line 2 <span className="faint">(optional)</span>
        </label>
        <input id="mj-l2" className="input" value={addr.line2} onChange={(e) => set('line2', e.target.value)} autoComplete="address-line2" />
      </div>
      <div className="grid2">
        <div className="field">
          <label className="label" htmlFor="mj-city">City</label>
          <input id="mj-city" className="input" value={addr.city} onChange={(e) => set('city', e.target.value)} autoComplete="address-level2" />
        </div>
        <div className="field">
          <label className="label" htmlFor="mj-state">State / region</label>
          <input id="mj-state" className="input" value={addr.state} onChange={(e) => set('state', e.target.value)} autoComplete="address-level1" />
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <label className="label" htmlFor="mj-pc">Postal code</label>
          <input id="mj-pc" className="input" value={addr.postalCode} onChange={(e) => set('postalCode', e.target.value)} autoComplete="postal-code" />
        </div>
        <div className="field">
          <label className="label" htmlFor="mj-cc">
            Country <span className="faint">(2-letter)</span>
          </label>
          <input
            id="mj-cc"
            className="input"
            value={addr.country}
            maxLength={2}
            placeholder="US"
            autoComplete="country"
            onChange={(e) => set('country', e.target.value.toUpperCase())}
          />
        </div>
      </div>

      {err && <p className="form-error">{err}</p>}
      <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
        {done && (
          <span className="status-pill status-pill--ok">
            <CheckCircle2 size={14} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}

/** The card reader's Stripe Terminal Location — create one from the masjid details, or
 *  choose an existing one. */
function ReaderLocation({ status, refresh }: { status: PaymentsStatus; refresh: () => Promise<void> }) {
  const a = status.masjid.address;
  const canCreate = !!a.line1.trim() && !!a.country.trim();
  const [busy, setBusy] = useState<'create' | 'list' | 'choose' | null>(null);
  const [err, setErr] = useState('');
  const [existing, setExisting] = useState<TerminalLocation[] | null>(null);
  const [pick, setPick] = useState('');

  const create = async () => {
    setErr('');
    setBusy('create');
    try {
      const address: CreateLocationAddress = { line1: a.line1.trim(), country: a.country.trim() };
      if (a.line2.trim()) address.line2 = a.line2.trim();
      if (a.city.trim()) address.city = a.city.trim();
      if (a.state.trim()) address.state = a.state.trim();
      if (a.postalCode.trim()) address.postalCode = a.postalCode.trim();
      await createLocation({ address, displayName: status.masjid.name.trim() || undefined });
      await refresh();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const loadExisting = async () => {
    setErr('');
    setBusy('list');
    try {
      setExisting((await listLocations()).locations);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const choose = async (id: string) => {
    setPick(id);
    if (!id) return;
    setErr('');
    setBusy('choose');
    try {
      await chooseLocation(id);
      await refresh();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <MapPin size={16} /> Card reader location
      </div>
      <p className="hint" style={{ marginBlockEnd: '0.7rem' }}>
        Stripe groups your readers by location. Create one from your masjid details, or pick an existing one.
      </p>

      {status.location ? (
        <p className="status-pill status-pill--ok" style={{ marginBlockEnd: '0.7rem' }}>
          <MapPin size={13} /> Using: {status.location.name}
        </p>
      ) : (
        <p className="status-pill" style={{ marginBlockEnd: '0.7rem' }}>No location set yet</p>
      )}

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
        <button className="btn btn--primary btn--sm" onClick={() => void create()} disabled={!canCreate || busy !== null}>
          {busy === 'create' ? 'Creating…' : 'Create location'}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => void loadExisting()} disabled={busy !== null}>
          {busy === 'list' ? 'Loading…' : 'Use existing'}
        </button>
      </div>
      {!canCreate && (
        <p className="hint" style={{ marginBlockStart: '0.5rem' }}>Add your masjid's address line 1 and country above first.</p>
      )}

      {existing && (
        <div className="field" style={{ marginBlockStart: '0.8rem' }}>
          <label className="label" htmlFor="loc-pick">Existing locations</label>
          {existing.length ? (
            <select
              id="loc-pick"
              className="input"
              value={pick}
              disabled={busy === 'choose'}
              onChange={(e) => void choose(e.target.value)}
            >
              <option value="">Select a location…</option>
              {existing.map((l) => (
                <option key={l.id} value={l.id}>{l.displayName}{l.address ? ` — ${l.address}` : ''}</option>
              ))}
            </select>
          ) : (
            <p className="hint">No locations found in this Stripe account yet.</p>
          )}
        </div>
      )}
      {err && <p className="form-error" style={{ marginBlockStart: '0.5rem' }}>{err}</p>}
    </div>
  );
}

/** A one-tap probe that proves Stripe + Terminal work by minting a connection token. */
function TestConnection() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TestPaymentsResult | null>(null);
  const [err, setErr] = useState('');

  const run = async () => {
    setErr('');
    setRes(null);
    setBusy(true);
    try {
      setRes(await testPayments());
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <PlugZap size={16} /> Test connection
      </div>
      <p className="hint" style={{ marginBlockEnd: '0.7rem' }}>
        Checks that Stripe accepts your keys and can hand out reader tokens.
      </p>
      <button className="btn btn--ghost btn--sm" onClick={() => void run()} disabled={busy}>
        {busy ? (
          <>
            <Loader2 size={15} className="spin" /> Checking…
          </>
        ) : (
          <>
            <PlugZap size={15} /> Test connection
          </>
        )}
      </button>
      {res && (
        <p
          className={res.ok ? 'status-pill status-pill--ok' : 'hint'}
          style={{ marginBlockStart: '0.6rem', display: res.ok ? 'inline-flex' : 'block' }}
        >
          {res.ok
            ? `Connected to Stripe${modeSuffix(res.mode)} — your reader can pair.`
            : res.message || "Couldn't reach Stripe. Check your keys and try again."}
        </p>
      )}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}

/** The Payments card for the Settings tab: loads status once, then renders the setup
 *  groups. Sub-sections that return a fresh status update it directly; those that don't
 *  refetch via `load`. */
export function PaymentsSection() {
  const [status, setStatus] = useState<PaymentsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await getPayments());
      setErr('');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="glass panel" aria-busy="true">
        <div className="card-head">
          <CreditCard size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Payments</h2>
            <p className="muted">Loading your Stripe setup…</p>
          </div>
        </div>
      </section>
    );
  }

  if (!status) {
    return (
      <section className="glass panel">
        <div className="card-head">
          <CreditCard size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Payments</h2>
            <p className="muted">We couldn't load your payment settings.</p>
          </div>
        </div>
        {err && <p className="form-error">{err}</p>}
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className="glass panel">
      <Header status={status} />
      <StripeAccount status={status} onStatus={setStatus} />
      <Currency status={status} onStatus={setStatus} />
      <MasjidDetails status={status} refresh={load} />
      <ReaderLocation status={status} refresh={load} />
      <TestConnection />
    </section>
  );
}
