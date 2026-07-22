// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

// Emailed donation receipt — Setup (enable + provider status + "Send me a test") and Design
// (masjid logo + contact + the thank-you template) with a live Stripe-style preview. Mirrors the
// OpenMasjidDonations EmailSetupCard/EmailDesignCard split, adapted to the Kiosk's Settings layout.
//
// The RECEIPT goes to the DONOR via the OS email provider (/api/fabric/email). The "Send me a test"
// button reaches the ADMIN via the alert channel (/api/admin/test-alert) — the platform never exposes
// the admin's address to this app, so that alert is the only way the app can reach the admin.
import { useEffect, useState } from 'react';
import { Mail, Send, Upload, Palette, Info } from 'lucide-react';
import { getEmailReceipt, saveEmailReceipt, getMasjid, saveMasjid, sendTestAlert, uploadImage, type EmailReceipt, type EmailStatus, type Masjid } from './api';
import { withBase } from './base';

const ACCENT_DEFAULT = '#1FA37A';
const isHex = (s: string) => /^#[0-9a-fA-F]{3,8}$/.test(s.trim());

/** Fill {name}/{amount}/{campaign}/{masjid} for the PREVIEW only (the server renders the real one). */
function fill(tpl: string, v: { name: string; amount: string; campaign: string; masjid: string }): string {
  let out = tpl;
  if (!v.name.trim()) out = out.replace(/,?[ \t]*\{name\}[ \t]*,?/g, ' ');
  return out
    .replace(/\{name\}/g, v.name)
    .replace(/\{amount\}/g, v.amount)
    .replace(/\{campaign\}/g, v.campaign)
    .replace(/\{masjid\}/g, v.masjid)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? ' switch--on' : ''}`} onClick={() => !disabled && onChange(!checked)}>
        <span className="switch-knob" />
      </button>
    </label>
  );
}

/** A tidy status line describing whether the OS email provider is set up (no probe — the server
 *  reports the last real send outcome). */
function statusLine(embedded: boolean, status: EmailStatus): { tone: 'ok' | 'warn' | 'info'; text: string } {
  if (!embedded) return { tone: 'warn', text: 'This app isn’t embedded under OpenMasjidOS, so there’s no email provider to send receipts through. Stripe’s own receipt is used instead.' };
  switch (status) {
    case 'ok':
      return { tone: 'ok', text: 'OpenMasjidOS email is set up and working — branded receipts will be sent to donors who give an email.' };
    case 'not_configured':
      return { tone: 'warn', text: 'No email provider is set up in OpenMasjidOS yet. Add one in OpenMasjidOS → Settings → Email, then send yourself a test. Until then, Stripe’s own receipt is used.' };
    case 'no-fabric':
      return { tone: 'warn', text: 'The platform couldn’t be reached, so receipts fall back to Stripe’s own. They’ll switch to your branded receipt once email is confirmed.' };
    case 'rate_limited':
      return { tone: 'warn', text: 'Email was rate-limited on the last attempt — try again shortly.' };
    case 'error':
      return { tone: 'warn', text: 'The last email attempt hit a problem. Send yourself a test to check your OpenMasjidOS email settings.' };
    default:
      return { tone: 'info', text: 'Receipts send through your OpenMasjidOS email provider. Send yourself a test to confirm it’s reaching you — branded donor receipts switch on once a send succeeds.' };
  }
}

export function EmailReceiptSection() {
  const [cfg, setCfg] = useState<EmailReceipt | null>(null);
  const [masjid, setMasjidState] = useState<Masjid | null>(null);
  // Editable copies
  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState('');
  const [heading, setHeading] = useState('');
  const [body, setBody] = useState('');
  const [accent, setAccent] = useState('');
  const [logo, setLogo] = useState('');
  const [cEmail, setCEmail] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cWebsite, setCWebsite] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [uploading, setUploading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([getEmailReceipt(), getMasjid().catch(() => null)])
      .then(([r, m]) => {
        if (!alive) return;
        setCfg(r);
        setEnabled(r.enabled);
        setSubject(r.subject);
        setHeading(r.heading);
        setBody(r.body);
        setAccent(r.accent);
        if (m) {
          setMasjidState(m);
          setLogo(m.logo);
          setCEmail(m.email);
          setCPhone(m.phone);
          setCWebsite(m.website);
        }
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Couldn’t load the receipt settings.'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const onLogo = async (file: File | undefined) => {
    if (!file) return;
    setErr('');
    setUploading(true);
    try {
      setLogo(await uploadImage(file));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That image couldn’t be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setErr('');
    setSaved(false);
    setSaving(true);
    try {
      const [r] = await Promise.all([
        saveEmailReceipt({ enabled, subject, heading, body, accent: isHex(accent) ? accent : '' }),
        saveMasjid({ logo, email: cEmail, phone: cPhone, website: cWebsite }),
      ]);
      setCfg(r);
      setEnabled(r.enabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTestMsg('');
    setTesting(true);
    try {
      const res = await sendTestAlert();
      setTestMsg(
        res.delivered
          ? 'Sent — check your own inbox/webhook (this goes to you, the admin, not a donor).'
          : res.reason === 'disabled_by_admin'
            ? 'The “test” alert is muted in OpenMasjidOS → Settings → Alerts. Turn it on to receive it.'
            : res.reason === 'no-fabric'
              ? 'Not embedded under OpenMasjidOS, so there’s nowhere to send it (that’s fine).'
              : 'Couldn’t deliver — check your OpenMasjidOS alert settings.',
      );
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <section className="glass panel">
        <div className="card-head">
          <Mail size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Email receipts</h2>
            <p className="muted">Loading…</p>
          </div>
        </div>
      </section>
    );
  }

  const embedded = !!cfg?.embedded;
  const status = statusLine(embedded, cfg?.emailStatus ?? 'unknown');
  const masjidName = masjid?.name || 'Your masjid';
  const previewAccent = isHex(accent) ? accent : ACCENT_DEFAULT;
  const vars = { name: 'Yusuf', amount: '$50.00', campaign: 'General Fund', masjid: masjidName };
  const logoSrc = logo ? (/^https?:\/\//i.test(logo) ? logo : withBase(logo)) : '';

  return (
    <>
      {/* ── Setup: enable + provider status + "Send me a test" ── */}
      <section className="glass panel">
        <div className="card-head">
          <Mail size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Email receipts</h2>
            <p className="muted">Send donors a branded receipt when they give their email — through your OpenMasjidOS email provider.</p>
          </div>
        </div>

        <Toggle
          label="Send branded receipts to donors"
          hint="When off (or before email is set up), Stripe’s own receipt is used instead — a donor is never left without one."
          checked={enabled}
          onChange={setEnabled}
        />

        <p className={status.tone === 'ok' ? 'status-pill status-pill--ok' : 'hint'} style={{ marginBlockStart: '0.7rem' }}>
          {status.text}
        </p>

        <div className="row" style={{ marginBlockStart: '0.8rem', flexWrap: 'wrap', alignItems: 'center', gap: '0.6rem' }}>
          <button className="btn btn--ghost btn--sm" onClick={test} disabled={testing || !embedded}>
            {testing ? <span className="spinner" /> : <Send size={15} />} Send me a test
          </button>
          <span className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            <Info size={13} /> Goes to <b>you</b> (the admin), not a donor.
          </span>
        </div>
        {testMsg && <p className="hint" style={{ marginBlockStart: '0.5rem' }}>{testMsg}</p>}
      </section>

      {/* ── Design: masjid branding/contact + template + live preview ── */}
      <section className="glass panel">
        <div className="card-head">
          <Palette size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Receipt design</h2>
            <p className="muted">Your logo, a short thank-you, and how donors can reach you. The amount, date, card and fund are filled in automatically.</p>
          </div>
        </div>

        <div className="er-grid">
          <div className="er-form">
            <div className="field">
              <label className="label">Masjid logo</label>
              <div className="row" style={{ alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {logoSrc ? <img src={logoSrc} alt="" className="er-logo-thumb" /> : <span className="hint">No logo — the masjid name is shown instead.</span>}
                <label className="btn btn--ghost btn--sm" style={{ cursor: 'pointer' }}>
                  {uploading ? <span className="spinner" /> : <Upload size={15} />} {logo ? 'Replace' : 'Upload'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void onLogo(e.target.files?.[0])} />
                </label>
                {logo && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLogo('')}>Remove</button>}
              </div>
              <span className="hint">Shown at the top of the receipt. Only loads in email when your kiosk is reachable over the internet (remote access).</span>
            </div>

            <div className="field">
              <label className="label" htmlFor="er-subject">Subject</label>
              <input id="er-subject" className="input" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="er-heading">Heading</label>
              <input id="er-heading" className="input" value={heading} maxLength={200} onChange={(e) => setHeading(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="er-body">Thank-you note</label>
              <textarea id="er-body" className="input" rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
              <span className="hint">You can use {'{name}'}, {'{amount}'}, {'{campaign}'} and {'{masjid}'}.</span>
            </div>

            <div className="field">
              <label className="label">Accent colour</label>
              <div className="row" style={{ alignItems: 'center', gap: '0.6rem' }}>
                <input type="color" className="accent-swatch-input" aria-label="Accent colour" value={isHex(accent) ? accent : ACCENT_DEFAULT} onChange={(e) => setAccent(e.target.value)} />
                {accent && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAccent('')}>Default</button>}
              </div>
            </div>

            <div className="field">
              <label className="label" htmlFor="er-cemail">Contact email <span className="faint">(optional)</span></label>
              <input id="er-cemail" className="input" value={cEmail} maxLength={200} placeholder="info@yourmasjid.org" onChange={(e) => setCEmail(e.target.value)} />
            </div>
            <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
                <label className="label" htmlFor="er-cphone">Contact phone <span className="faint">(optional)</span></label>
                <input id="er-cphone" className="input" value={cPhone} maxLength={60} onChange={(e) => setCPhone(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
                <label className="label" htmlFor="er-cweb">Website <span className="faint">(optional)</span></label>
                <input id="er-cweb" className="input" value={cWebsite} maxLength={200} placeholder="https://yourmasjid.org" onChange={(e) => setCWebsite(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Live preview — a light, Stripe-style receipt (React escapes all values). */}
          <div className="er-preview-wrap">
            <span className="label">Preview</span>
            <div className="er-receipt">
              <div className="er-receipt__head">
                {logoSrc ? <img src={logoSrc} alt="" className="er-receipt__logo" /> : <div className="er-receipt__masjid">{masjidName}</div>}
                <div className="er-receipt__ref">Receipt · A1B2C3D4</div>
              </div>
              <h3 className="er-receipt__heading" style={{ color: previewAccent }}>{fill(heading || 'JazākAllāhu khayran!', vars)}</h3>
              <p className="er-receipt__body">{fill(body || 'Your donation was received.', vars)}</p>
              <table className="er-receipt__table">
                <tbody>
                  <tr><td>Amount paid</td><td className="er-strong">$50.00</td></tr>
                  <tr><td>Date paid</td><td>Jul 15, 2026, 6:03 PM</td></tr>
                  <tr><td>Payment method</td><td>Visa •••• 4242</td></tr>
                  <tr><td>Fund</td><td>General Fund</td></tr>
                </tbody>
              </table>
              <div className="er-receipt__foot">
                Questions about this donation? Contact {masjidName}
                {(cEmail || cPhone) && <> — {[cEmail, cPhone].filter(Boolean).join(' · ')}</>}.
                {cWebsite && <div style={{ marginTop: 4 }}><span style={{ color: previewAccent }}>{cWebsite.replace(/^https?:\/\//, '')}</span></div>}
              </div>
            </div>
            <span className="hint" style={{ marginBlockStart: '0.4rem' }}>Sample values shown. The real receipt uses the donation’s amount, date, card and fund.</span>
          </div>
        </div>

        {err && <p className="form-error" style={{ marginBlockStart: '0.7rem' }}>{err}</p>}
        <div className="row" style={{ marginBlockStart: '0.9rem', alignItems: 'center', gap: '0.6rem' }}>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" /> : null} Save receipt
          </button>
          {saved && <span className="status-pill status-pill--ok">Saved</span>}
        </div>
      </section>
    </>
  );
}
