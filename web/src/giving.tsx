// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Giving-screen designer: what a donor sees on the tablet — the masjid name + headline, the
 *  six preset amounts, custom-amount on/off + min/max, monthly on/off, the name/email prompt
 *  policy, and the thank-you message. A live preview mirrors the kiosk as you type. Saving pushes
 *  the change to every paired kiosk on its next check-in (the server bumps the config version).
 *  Amounts are edited in whole/decimal currency units but stored as integer MINOR units. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LayoutTemplate, Plus, X } from 'lucide-react';
import { getGiving, saveGiving, type GivingSettings, type PromptPolicy } from './api';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

// ── Currency helpers (mirror the server/tablet: integer minor units, zero-decimal aware) ──────
const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'XAF', 'XOF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV', 'XPF',
]);
const decimals = (ccy: string) => (ZERO_DECIMAL.has(ccy.toUpperCase()) ? 0 : 2);
const factor = (ccy: string) => 10 ** decimals(ccy);

function symbolFor(ccy: string): string {
  switch (ccy.toUpperCase()) {
    case 'USD': case 'CAD': case 'AUD': case 'NZD': return '$';
    case 'GBP': return '£';
    case 'EUR': return '€';
    case 'PKR': return '₨';
    case 'INR': return '₹';
    case 'MYR': return 'RM';
    case 'AED': return 'AED ';
    case 'SAR': return 'SAR ';
    default: return '';
  }
}

/** Minor units → a display string, e.g. 2500 USD → "$25", 2550 → "$25.50". */
function formatMoney(minor: number, ccy: string): string {
  const sym = symbolFor(ccy);
  const d = decimals(ccy);
  let body: string;
  if (d === 0) body = String(Math.round(minor));
  else if (minor % 100 === 0) body = String(Math.round(minor / 100));
  else body = (minor / 100).toFixed(2);
  return sym ? `${sym}${body}` : `${body} ${ccy.toUpperCase()}`;
}

/** A "major unit" text field (e.g. "5", "10.50") → integer minor units, or 0 if not a valid amount. */
function toMinor(major: string, ccy: string): number {
  const n = Number(String(major).trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * factor(ccy));
}

/** Integer minor units → an editable major-unit string (no trailing ".00"). */
function toMajorStr(minor: number, ccy: string): string {
  const d = decimals(ccy);
  if (d === 0) return String(minor);
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

const MAX_PRESETS = 6;

export function GivingSection() {
  const [loaded, setLoaded] = useState<GivingSettings | null>(null);
  const [loadErr, setLoadErr] = useState('');

  // Editable form state (amounts held as major-unit strings for friendly editing).
  const [masjidName, setMasjidName] = useState('');
  const [attractTitle, setAttractTitle] = useState('');
  const [presets, setPresets] = useState<string[]>([]);
  const [allowCustom, setAllowCustom] = useState(true);
  const [customMin, setCustomMin] = useState('');
  const [customMax, setCustomMax] = useState('');
  const [monthlyEnabled, setMonthlyEnabled] = useState(true);
  const [manualEntryEnabled, setManualEntryEnabled] = useState(false);
  const [namePolicy, setNamePolicy] = useState<PromptPolicy>('optional');
  const [emailPolicy, setEmailPolicy] = useState<PromptPolicy>('optional');
  const [thankYou, setThankYou] = useState('');
  const [currency, setCurrency] = useState('USD');

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const hydrate = useCallback((s: GivingSettings) => {
    setLoaded(s);
    setCurrency(s.currency);
    setMasjidName(s.masjidName);
    setAttractTitle(s.attractTitle);
    setPresets(s.giving.presetsMinor.map((m) => toMajorStr(m, s.currency)));
    setAllowCustom(s.giving.allowCustom);
    setCustomMin(toMajorStr(s.giving.customMinMinor, s.currency));
    setCustomMax(toMajorStr(s.giving.customMaxMinor, s.currency));
    setMonthlyEnabled(s.giving.monthlyEnabled);
    setManualEntryEnabled(s.giving.manualEntryEnabled);
    setNamePolicy(s.giving.namePolicy);
    setEmailPolicy(s.giving.emailPolicy);
    setThankYou(s.giving.thankYouMessage);
  }, []);

  useEffect(() => {
    let alive = true;
    getGiving()
      .then((s) => alive && hydrate(s))
      .catch((e) => alive && setLoadErr(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [hydrate]);

  // Live preview amounts (drop blanks/invalid, cap at 6) — recomputed as you type.
  const previewPresets = useMemo(
    () => presets.map((p) => toMinor(p, currency)).filter((n) => n > 0).slice(0, MAX_PRESETS),
    [presets, currency],
  );

  const setPreset = (i: number, v: string) =>
    setPresets((ps) => ps.map((p, j) => (j === i ? v.replace(/[^\d.]/g, '') : p)));
  const removePreset = (i: number) => setPresets((ps) => ps.filter((_, j) => j !== i));
  const addPreset = () => setPresets((ps) => (ps.length < MAX_PRESETS ? [...ps, ''] : ps));

  const save = async () => {
    setErr('');
    setSaved(false);
    const presetsMinor = presets.map((p) => toMinor(p, currency)).filter((n) => n > 0);
    if (presetsMinor.length === 0) {
      setErr('Add at least one preset amount.');
      return;
    }
    const min = toMinor(customMin, currency) || 100;
    const max = toMinor(customMax, currency) || 1_000_000;
    if (allowCustom && max < min) {
      setErr('The maximum custom amount must be at least the minimum.');
      return;
    }
    setBusy(true);
    try {
      const fresh = await saveGiving({
        presetsMinor,
        allowCustom,
        customMinMinor: min,
        customMaxMinor: max,
        monthlyEnabled,
        manualEntryEnabled,
        namePolicy,
        emailPolicy,
        thankYouMessage: thankYou,
        attractTitle,
        masjidName,
      });
      hydrate(fresh); // reflect the server's sanitised values (e.g. ≤6 presets, clamped bounds)
      setSaved(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <section className="glass panel">
        {loadErr ? <p className="hint">Couldn't load the giving screen just now — try again shortly.</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  return (
    <div className="giving-layout">
      {/* ── The editor ─────────────────────────────────────────────── */}
      <section className="glass panel">
        <div className="card-head">
          <LayoutTemplate size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Giving screen</h2>
            <p className="muted">Design what donors see. Changes reach your kiosks within a few seconds.</p>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="g-masjid">Masjid name</label>
          <input id="g-masjid" className="input" value={masjidName} maxLength={160} placeholder="Al-Noor Masjid" onChange={(e) => setMasjidName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="g-attract">Attract headline <span className="faint">(optional)</span></label>
          <input id="g-attract" className="input" value={attractTitle} maxLength={120} placeholder="Tap to donate" onChange={(e) => setAttractTitle(e.target.value)} />
        </div>

        <div className="field">
          <span className="label">Preset amounts <span className="faint">({currency})</span></span>
          <div className="preset-grid">
            {presets.map((p, i) => (
              <div className="preset-input" key={i}>
                <span className="preset-sym" aria-hidden="true">{symbolFor(currency) || currency}</span>
                <input
                  className="input"
                  value={p}
                  inputMode="decimal"
                  aria-label={`Preset amount ${i + 1}`}
                  onChange={(e) => setPreset(i, e.target.value)}
                />
                <button className="preset-rm" onClick={() => removePreset(i)} aria-label="Remove amount" title="Remove">
                  <X size={13} strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
          {presets.length < MAX_PRESETS && (
            <button className="btn btn--ghost btn--sm" onClick={addPreset} style={{ marginBlockStart: '0.5rem' }}>
              <Plus size={14} /> Add amount
            </button>
          )}
        </div>

        <Toggle label="Allow a custom amount" hint="Show an “Other amount” number pad." checked={allowCustom} onChange={setAllowCustom} />
        {allowCustom && (
          <div className="row" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: 1, minWidth: '8rem' }}>
              <label className="label" htmlFor="g-min">Minimum</label>
              <input id="g-min" className="input" value={customMin} inputMode="decimal" onChange={(e) => setCustomMin(e.target.value.replace(/[^\d.]/g, ''))} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: '8rem' }}>
              <label className="label" htmlFor="g-max">Maximum</label>
              <input id="g-max" className="input" value={customMax} inputMode="decimal" onChange={(e) => setCustomMax(e.target.value.replace(/[^\d.]/g, ''))} />
            </div>
          </div>
        )}

        <Toggle label="Offer monthly giving" hint="Adds a One-time / Monthly choice (monthly needs a name + email)." checked={monthlyEnabled} onChange={setMonthlyEnabled} />

        <Toggle
          label="Allow manual card entry"
          hint="Let donors type their card (Stripe's secure form) instead of the reader — and it's the way to take cards with no reader. Note: keyed cards cost more and carry more fraud risk on an unattended kiosk."
          checked={manualEntryEnabled}
          onChange={setManualEntryEnabled}
        />

        <div className="row" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
          <PolicyField id="g-name" label="Ask for a name" value={namePolicy} onChange={setNamePolicy} />
          <PolicyField id="g-email" label="Ask for an email" value={emailPolicy} onChange={setEmailPolicy} hint="An email lets Stripe send a receipt." />
        </div>

        <div className="field">
          <label className="label" htmlFor="g-thanks">Thank-you message</label>
          <textarea
            id="g-thanks"
            className="input"
            rows={3}
            maxLength={500}
            value={thankYou}
            placeholder="JazākAllāhu khayran — thank you for your generous donation."
            onChange={(e) => setThankYou(e.target.value)}
          />
        </div>

        {err && <p className="form-error">{err}</p>}
        <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap', marginBlockStart: '0.4rem' }}>
          <button className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save & push to kiosks'}
          </button>
          {saved && (
            <span className="status-pill status-pill--ok">
              <CheckCircle2 size={14} /> Saved — kiosks update shortly
            </span>
          )}
        </div>
      </section>

      {/* ── Live preview ───────────────────────────────────────────── */}
      <section className="glass panel giving-preview-panel">
        <div className="card-head">
          <div className="card-head__main">
            <h2 className="section-title-inline">Live preview</h2>
            <p className="muted">Roughly how the tablet looks.</p>
          </div>
        </div>
        <KioskPreview
          masjidName={masjidName}
          presetsMinor={previewPresets}
          allowCustom={allowCustom}
          monthlyEnabled={monthlyEnabled}
          thankYou={thankYou}
          currency={currency}
        />
      </section>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch${checked ? ' switch--on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </label>
  );
}

function PolicyField({ id, label, value, onChange, hint }: { id: string; label: string; value: PromptPolicy; onChange: (v: PromptPolicy) => void; hint?: string }) {
  return (
    <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as PromptPolicy)}>
        <option value="off">Don't ask</option>
        <option value="optional">Optional</option>
        <option value="required">Required</option>
      </select>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

// A small, dark mock of the tablet's giving screen — enough to judge amounts + wording at a glance.
function KioskPreview({
  masjidName,
  presetsMinor,
  allowCustom,
  monthlyEnabled,
  thankYou,
  currency,
}: {
  masjidName: string;
  presetsMinor: number[];
  allowCustom: boolean;
  monthlyEnabled: boolean;
  thankYou: string;
  currency: string;
}) {
  return (
    <div className="kiosk-preview" aria-hidden="true">
      <div className="kp-screen">
        <div className="kp-title">{masjidName.trim() || 'Support your masjid'}</div>
        <div className="kp-sub">Choose an amount to give</div>
        {monthlyEnabled && (
          <div className="kp-freq">
            <span className="kp-freq__seg kp-freq__seg--on">One-time</span>
            <span className="kp-freq__seg">Monthly</span>
          </div>
        )}
        <div className="kp-grid">
          {presetsMinor.length === 0 ? (
            <div className="kp-empty">Add a preset amount to see it here.</div>
          ) : (
            presetsMinor.map((m, i) => (
              <div className="kp-tile" key={i}>{formatMoney(m, currency)}</div>
            ))
          )}
        </div>
        {allowCustom && <div className="kp-other">Other amount</div>}
      </div>
      <div className="kp-thanks">
        <span className="kp-check">✓</span> {thankYou.trim() || 'JazākAllāhu khayran — thank you for your generous donation.'}
      </div>
    </div>
  );
}
