// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

// Emailed donation receipt — Setup (enable + provider status + "Email me a sample receipt") and
// Design (masjid logo + contact + the thank-you template) with a live Stripe-style preview. Mirrors
// the OpenMasjidDonations EmailSetupCard/EmailDesignCard split, adapted to the Kiosk's Settings layout.
//
// The RECEIPT goes to the DONOR via the OS email provider (/api/fabric/email), and so does the SAMPLE
// (/api/admin/email-receipt/test), to whatever address the admin types beside the button. That button
// used to be "Send me a test", which fired the ALERT channel (/api/admin/test-alert) instead — so it
// proved the Notifications routing, not email: with only the OpenMasjidOS relay ticked it reported
// success, email stayed unproven, and the status lines telling the admin to "send yourself a test"
// sent them to a button that could never switch branded receipts on. A real sample receipt is the one
// thing that shows both the provider working and the design as a donor will see it, and its
// successful send is what switches branded receipts on.
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Info, Mail, Palette, Send, TriangleAlert, Upload } from 'lucide-react';
import {
  ApiError,
  errorText,
  getEmailReceipt,
  getGiving,
  getMasjid,
  saveEmailReceipt,
  saveMasjid,
  sendSampleReceipt,
  uploadImage,
  type EmailReceipt,
  type EmailStatus,
  type Masjid,
} from './api';
import { withBase } from './base';
import { readableOn } from './contrast';
import { formatDateTime } from './dates';
import { factor, formatMoney } from './money';
import { ResultLine, Skeleton, Toggle, useClock } from './ui';

// Must equal ACCENT_DEFAULT in server/src/email.ts — the preview is only worth looking at if it is
// the email.
const ACCENT_DEFAULT = '#1FA37A';
const isHex = (s: string) => /^#[0-9a-fA-F]{3,8}$/.test(s.trim());
/** Plausible enough to send to. Catches the slip (a missing "@", a space) here, in words, rather than
 *  as a refusal from somewhere further down. */
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

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

/** The outcome of something the admin did, plus — only when there is some — the technical text
 *  behind it, tucked into "Technical details" rather than put in the sentence (spec §9). */
type Outcome = { ok: boolean; text: string; detail: string } | null;
const failed = (e: unknown, fallback?: string): Outcome => ({
  ok: false,
  text: errorText(e, fallback),
  detail: e instanceof ApiError ? e.detail : '',
});

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  return (
    <>
      <ResultLine ok={outcome.ok}>{outcome.text}</ResultLine>
      {outcome.detail && (
        <details className="tech-details">
          <summary>Technical details</summary>
          <code className="mono" dir="ltr">{outcome.detail}</code>
        </details>
      )}
    </>
  );
}

/** Why a sample didn't go, in words. The server sends the RAW reason — one of the Fabric's short
 *  codes (fabric.ts fabricEmail), or whatever the platform's email provider said — and this is the one
 *  place it becomes a sentence; the raw text goes under "Technical details". Anything unrecognised,
 *  a provider's own message included, gets the general sentence rather than being shown as it came. */
function sampleFailure(reason: string): string {
  const r = reason.trim();
  if (r === 'no-fabric') return 'This app isn’t connected to OpenMasjidOS, so it can’t send email.';
  if (r === 'bad_recipient') return 'The email provider refused that address. Check it for a typo, then try again.';
  if (r === 'not_configured') return 'No email provider is set up in OpenMasjidOS yet. Add one in OpenMasjidOS → Settings → Email, then try again.';
  if (r === 'rate_limited') return 'Too many emails went out at once. Wait a few minutes, then try again.';
  if (r === 'unreachable' || r === 'threw' || /^http_5/.test(r)) return 'OpenMasjidOS didn’t answer. Check it’s running, then try again.';
  if (/^http_4/.test(r)) return 'OpenMasjidOS turned the email down. Check OpenMasjidOS → Settings → Email, then try again.';
  return 'The sample didn’t go out. Check your email settings in OpenMasjidOS → Settings → Email, then try again.';
}

/** A tidy status line describing whether the OS email provider is set up (no probe — the server
 *  reports the last real send outcome). Every "what to do" points at the sample-receipt button,
 *  because that is the one thing on this panel that actually proves email works. */
function statusLine(embedded: boolean, status: EmailStatus, enabled: boolean): { tone: 'ok' | 'warn' | 'info'; text: string } {
  if (!embedded) return { tone: 'warn', text: 'This app isn’t connected to OpenMasjidOS, so it can’t send email. Donors get Stripe’s own receipt instead.' };
  switch (status) {
    case 'ok':
      return {
        tone: 'ok',
        text: enabled
          ? 'OpenMasjidOS email is set up and working — branded receipts will be sent to donors who give an email.'
          : 'OpenMasjidOS email is set up and working. Switch on branded receipts above to start sending them to donors.',
      };
    case 'not_configured':
      return { tone: 'warn', text: 'No email provider is set up in OpenMasjidOS yet. Add one in OpenMasjidOS → Settings → Email, then press Email me a sample receipt below. Until then, donors get Stripe’s own receipt.' };
    case 'no-fabric':
      return { tone: 'warn', text: 'OpenMasjidOS couldn’t be reached, so donors get Stripe’s own receipt for now. Branded receipts switch back on once a sample receipt goes through — press Email me a sample receipt below.' };
    case 'rate_limited':
      return { tone: 'warn', text: 'Too many emails went out at once last time. Wait a few minutes, then press Email me a sample receipt below.' };
    case 'error':
      return { tone: 'warn', text: 'The last email didn’t go through. Press Email me a sample receipt below to check your OpenMasjidOS email settings.' };
    default:
      return { tone: 'info', text: 'Receipts are sent through your OpenMasjidOS email provider. Press Email me a sample receipt below to check it reaches you — branded donor receipts switch on once one goes through.' };
  }
}

/** The provider's standing state, in the same colour-and-icon language as a result, so a problem can
 *  never pass for grey help text. Deliberately NOT a live region: it describes how things are when the
 *  panel opens, not something that just happened, and announcing it on every visit to Settings would
 *  be noise. The sample button announces its own outcome. */
function StatusLine({ tone, text }: { tone: 'ok' | 'warn' | 'info'; text: string }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? TriangleAlert : Info;
  return (
    <p className={`result result--${tone}`}>
      <Icon size={15} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
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
  // The masjid's currency, for the preview's sample amount. USD until read, because that is the
  // server's own default currency — the one a masjid that never chose is actually on.
  const [currency, setCurrencyCode] = useState('usd');

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<Outcome>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<Outcome>(null);
  const [uploading, setUploading] = useState(false);
  const [logoErr, setLogoErr] = useState<Outcome>(null);
  const [sampleTo, setSampleTo] = useState('');
  const [sending, setSending] = useState(false);
  const [sample, setSample] = useState<Outcome>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Where focus goes when the button just pressed takes itself away (Remove logo, Use the default
  // color) — otherwise it drops to the page and a keyboard user starts again from the top.
  const uploadBtnRef = useRef<HTMLButtonElement>(null);
  const colorRef = useRef<HTMLInputElement>(null);
  // The preview's "Date paid": the moment the panel opened, written the way the real receipt will be
  // (Gregorian · Hijri, in the masjid's zone and hour cycle). Subscribing to the clock re-renders it —
  // and the sample amount — when the masjid's settings arrive or change.
  const [sampleAt] = useState(() => Date.now());
  const clock = useClock();

  useEffect(() => {
    let alive = true;
    Promise.all([getEmailReceipt(), getMasjid().catch(() => null), getGiving().catch(() => null)])
      .then(([r, m, g]) => {
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
          // The masjid's own contact address is the likeliest place an admin wants the sample.
          setSampleTo((cur) => cur || m.email);
        }
        if (g?.currency) setCurrencyCode(g.currency);
      })
      .catch((e) => alive && setLoadErr(failed(e, 'Couldn’t load the receipt settings.')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const onLogo = async (file: File | undefined) => {
    if (!file || uploading) return;
    setLogoErr(null);
    setUploading(true);
    try {
      setLogo(await uploadImage(file));
    } catch (e) {
      setLogoErr(failed(e, 'That image couldn’t be uploaded. Try a PNG, JPEG or WebP image.'));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    // aria-disabled, not disabled, while saving, so the pressed button keeps focus; this stops a repeat.
    if (saving) return;
    setErr(null);
    setSaved(false);
    setSaving(true);
    try {
      const [r, m] = await Promise.all([
        saveEmailReceipt({ enabled, subject, heading, body, accent: isHex(accent) ? accent : '' }),
        // Only when the masjid details actually loaded. If that read failed, these boxes are empty
        // because we never knew their values — not because the admin cleared them — and saving
        // them would wipe the logo and contact line off every receipt.
        masjid ? saveMasjid({ logo, email: cEmail, phone: cPhone, website: cWebsite }) : Promise.resolve(null),
      ]);
      setCfg(r);
      setEnabled(r.enabled);
      if (m) setMasjidState(m);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(failed(e, 'Couldn’t save. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const sendSample = async () => {
    if (sending) return;
    const to = sampleTo.trim();
    if (!looksLikeEmail(to)) {
      setSample({ ok: false, text: 'That email address doesn’t look right — try something like name@example.com.', detail: '' });
      return;
    }
    setSample(null);
    setSending(true);
    try {
      const res = await sendSampleReceipt(to);
      if (res.sent) {
        // "Sent" is a claim we can make here: the platform's email send is awaited, so a `sent: true`
        // means the provider took it (unlike a queued WhatsApp, which is only accepted for later).
        setSample({ ok: true, text: `Sample receipt sent to ${to}. It should arrive within a minute or two — check the spam folder if it doesn’t.`, detail: '' });
      } else {
        const code = (res.reason ?? '').trim();
        setSample({ ok: false, text: sampleFailure(code), detail: code });
      }
      // Either way the provider's state just changed (a success is what switches branded receipts
      // on), so re-read it for the status line — only the status, never over the admin's edits.
      getEmailReceipt()
        .then((r) => setCfg((c) => (c ? { ...c, embedded: r.embedded, emailStatus: r.emailStatus } : c)))
        .catch(() => undefined);
    } catch (e) {
      setSample(failed(e));
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <section className="glass panel" aria-busy="true">
        <div className="card-head">
          <Mail size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Email receipts</h2>
          </div>
        </div>
        <Skeleton rows={3} height="2.2rem" label="Loading the receipt settings…" widths={['100%', '85%', '60%']} />
      </section>
    );
  }

  // A failed read shows a way back rather than an empty form: saving those empty boxes would overwrite
  // the real template with nothing.
  if (!cfg) {
    return (
      <section className="glass panel">
        <div className="card-head">
          <Mail size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Email receipts</h2>
            <p className="muted">We couldn’t load the receipt settings.</p>
          </div>
        </div>
        <OutcomeLine outcome={loadErr} />
        <button
          className="btn btn--ghost btn--sm"
          style={{ marginBlockStart: '0.6rem' }}
          onClick={() => {
            setLoadErr(null);
            setLoading(true);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  const embedded = cfg.embedded;
  const status = statusLine(embedded, cfg.emailStatus ?? 'unknown', enabled);
  const masjidName = masjid?.name || 'Your masjid';
  const previewAccent = isHex(accent) ? accent : ACCENT_DEFAULT;
  // The accent as TEXT (heading, website link) is darkened just enough to read on the white card,
  // exactly as server/src/email.ts inks the real email; the accent itself stays visible, untouched, as
  // the card's top stripe. An admin's brand colour is data — the gold they pick may be 2:1 on white.
  const accentInk = readableOn(previewAccent);
  // The masjid's own currency, scaled by ITS decimals — "£50", "KWD 50" — never a hardcoded "$50.00".
  const sampleAmount = formatMoney(50 * factor(currency), currency);
  const vars = { name: 'Yusuf', amount: sampleAmount, campaign: 'General Fund', masjid: masjidName };
  const logoSrc = logo ? (/^https?:\/\//i.test(logo) ? logo : withBase(logo)) : '';
  // The sample uses the design as SAVED (the server renders it), so say so when the form holds changes
  // the sample would not show.
  const designDirty =
    subject !== cfg.subject ||
    heading !== cfg.heading ||
    body !== cfg.body ||
    (isHex(accent) ? accent : '') !== (cfg.accent || '') ||
    (masjid !== null && (logo !== masjid.logo || cEmail !== masjid.email || cPhone !== masjid.phone || cWebsite !== masjid.website));

  return (
    <>
      {/* ── Setup: enable + provider status + "Email me a sample receipt" ── */}
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

        <StatusLine tone={status.tone} text={status.text} />

        <form
          noValidate
          style={{ marginBlockStart: '0.9rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void sendSample();
          }}
        >
          <div className="field" style={{ marginBlockEnd: 0 }}>
            <label className="label" htmlFor="er-sample-to">Your email address</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
              <input
                id="er-sample-to"
                className="input"
                type="email"
                dir="ltr"
                autoComplete="email"
                maxLength={200}
                placeholder="you@example.com"
                value={sampleTo}
                aria-describedby="er-sample-hint"
                style={{ flex: '1 1 14rem', minWidth: 0 }}
                onChange={(e) => setSampleTo(e.target.value)}
              />
              {/* `disabled` only for the standing reason (not connected — the line above says so);
                  while sending it is aria-disabled so the button pressed keeps focus. */}
              <button type="submit" className="btn btn--ghost btn--sm" disabled={!embedded} aria-disabled={sending || undefined}>
                {sending ? <span className="spinner" aria-hidden="true" /> : <Send size={15} className="rtl-flip" aria-hidden="true" />} Email me a sample receipt
              </button>
            </div>
            <span className="hint" id="er-sample-hint">
              A made-up donation, laid out exactly as donors get it, sent only to this address — never to a donor.{' '}
              {designDirty ? 'It uses your saved design, so press Save receipt below first to include your changes.' : 'It uses your saved design.'}
            </span>
          </div>
        </form>
        <OutcomeLine outcome={sample} />
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
            {/* A group named by its heading: there is no single control for a <label> to point at —
                the thumbnail, the upload button and Remove together are "the logo". */}
            <div className="field" role="group" aria-labelledby="er-logo-label">
              <span className="label" id="er-logo-label">Masjid logo</span>
              <div className="row" style={{ alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {logoSrc ? <img src={logoSrc} alt="Current logo" className="er-logo-thumb" /> : <span className="hint">No logo — the masjid name is shown instead.</span>}
                {/* A real button that clicks a hidden file input. The old <label> wrapping a `hidden`
                    input could not be reached from the keyboard at all: neither element takes focus. */}
                <button
                  ref={uploadBtnRef}
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-disabled={uploading || undefined}
                  aria-describedby="er-logo-hint"
                  onClick={() => {
                    if (!uploading) fileRef.current?.click();
                  }}
                >
                  {uploading ? <span className="spinner" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />} {logo ? 'Replace logo' : 'Upload logo'}
                </button>
                {logo && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setLogo('');
                      uploadBtnRef.current?.focus();
                    }}
                  >
                    Remove logo
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Cleared so picking the SAME file again (after Remove, say) still fires a change.
                    e.target.value = '';
                    void onLogo(file);
                  }}
                />
              </div>
              <span className="hint" id="er-logo-hint">Shown at the top of the receipt. Only loads in email when your kiosk is reachable over the internet (remote access).</span>
              <OutcomeLine outcome={logoErr} />
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
              <textarea id="er-body" className="input" rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} aria-describedby="er-body-hint" />
              <span className="hint" id="er-body-hint">You can use {'{name}'}, {'{amount}'}, {'{campaign}'} and {'{masjid}'}.</span>
            </div>

            <div className="field">
              <span className="label" id="er-accent-label">Accent color</span>
              <div className="row" style={{ alignItems: 'center', gap: '0.6rem' }}>
                <input
                  ref={colorRef}
                  type="color"
                  className="accent-swatch-input"
                  aria-labelledby="er-accent-label"
                  aria-describedby="er-accent-hint"
                  value={isHex(accent) ? accent : ACCENT_DEFAULT}
                  onChange={(e) => setAccent(e.target.value)}
                />
                {accent && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setAccent('');
                      colorRef.current?.focus();
                    }}
                  >
                    Use the default color
                  </button>
                )}
              </div>
              <span className="hint" id="er-accent-hint">
                A stripe across the top of the receipt. The heading and links use it too — made darker where needed so they stay easy to read on white.
              </span>
            </div>

            <div className="field">
              <label className="label" htmlFor="er-cemail">Contact email <span className="faint">(optional)</span></label>
              <input id="er-cemail" className="input" type="email" dir="ltr" value={cEmail} maxLength={200} placeholder="info@yourmasjid.org" onChange={(e) => setCEmail(e.target.value)} />
            </div>
            <div className="row row--top" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
                <label className="label" htmlFor="er-cphone">Contact phone <span className="faint">(optional)</span></label>
                <input id="er-cphone" className="input" type="tel" dir="ltr" value={cPhone} maxLength={60} onChange={(e) => setCPhone(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
                <label className="label" htmlFor="er-cweb">Website <span className="faint">(optional)</span></label>
                <input id="er-cweb" className="input" dir="ltr" inputMode="url" value={cWebsite} maxLength={200} placeholder="https://yourmasjid.org" onChange={(e) => setCWebsite(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Live preview — a light, Stripe-style receipt (React escapes all values). dir="ltr" because
              the email itself is always sent left-to-right; mirroring the preview with an RTL panel
              would show the admin a receipt no donor ever receives. */}
          <div className="er-preview-wrap">
            <span className="label">Preview</span>
            <div className="er-receipt" dir="ltr" style={{ borderBlockStart: `4px solid ${previewAccent}` }}>
              <div className="er-receipt__head">
                {/* The logo stands in for the masjid's name, so it carries that name — as the email's does. */}
                {logoSrc ? <img src={logoSrc} alt={masjidName} className="er-receipt__logo" /> : <div className="er-receipt__masjid">{masjidName}</div>}
                <div className="er-receipt__ref">Receipt · A1B2C3D4</div>
              </div>
              <h3 className="er-receipt__heading" style={{ color: accentInk }}>{fill(heading || 'JazākAllāhu khayran!', vars)}</h3>
              <p className="er-receipt__body">{fill(body || 'Your donation was received.', vars)}</p>
              <table className="er-receipt__table">
                <tbody>
                  <tr><td>Amount paid</td><td className="er-strong">{sampleAmount}</td></tr>
                  <tr><td>Date paid</td><td>{formatDateTime(sampleAt, clock)}</td></tr>
                  <tr><td>Payment method</td><td>Visa •••• 4242</td></tr>
                  <tr><td>Fund</td><td>General Fund</td></tr>
                </tbody>
              </table>
              <div className="er-receipt__foot">
                Questions about this donation? Contact {masjidName}
                {(cEmail || cPhone) && <> — {[cEmail, cPhone].filter(Boolean).join(' · ')}</>}.
                {cWebsite && <div style={{ marginBlockStart: 4 }}><span style={{ color: accentInk }}>{cWebsite.replace(/^https?:\/\//, '')}</span></div>}
              </div>
            </div>
            <span className="hint" style={{ marginBlockStart: '0.4rem' }}>Sample values shown. The real receipt uses the donation’s amount, date, card and fund.</span>
          </div>
        </div>

        <OutcomeLine outcome={err} />
        <div className="row" style={{ marginBlockStart: '0.9rem', alignItems: 'center', gap: '0.6rem' }}>
          <button className="btn btn--primary" onClick={() => void save()} aria-disabled={saving || undefined}>
            {saving ? <span className="spinner" aria-hidden="true" /> : null} Save receipt
          </button>
          {/* Always in the page, only its words change: some screen readers miss a live region that
              arrives already holding its text, and this one also clears itself after a moment. */}
          <span role="status" className={saved ? 'status-pill status-pill--ok' : 'sr-only'}>
            {saved && (
              <>
                <CheckCircle2 size={14} aria-hidden="true" /> Saved
              </>
            )}
          </span>
        </div>
      </section>
    </>
  );
}
