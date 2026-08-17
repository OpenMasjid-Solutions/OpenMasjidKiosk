// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Settings → Notifications: where each alert goes.
 *
 *  OpenMasjidOS has its own alerts matrix and it stays underneath this — that is the "OpenMasjidOS"
 *  switch, on by default, so an existing install behaves exactly as it did before this screen
 *  existed. What the platform cannot do is per-person: it routes to the admin's one address and has
 *  no WhatsApp column for apps at all. A masjid needs "the foyer reader is offline" to reach the
 *  caretaker and "a donation was refunded" to reach the treasurer. */
import { useEffect, useState } from 'react';
import { BellRing, Check, Loader2, MessageCircle, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import { getAlerts, refreshWhatsApp, sendTestAlert, setAlertRoute, type AlertSetting, type AlertsView, type WhatsAppAvailability } from './api';

/** What to tell the admin about WhatsApp not being available — each reason needs a different fix,
 *  so a single "unavailable" would leave them guessing which. */
function whatsappNote(w: WhatsAppAvailability): string {
  switch (w.reason) {
    case 'ready':
      return '';
    case 'not-linked':
      return 'WhatsApp is set up on this server but no phone is linked to it yet.';
    case 'unreachable':
      return 'The WhatsApp gateway isn’t responding at the moment.';
    default:
      return 'WhatsApp isn’t set up on this server yet — an admin can add it in OpenMasjidOS → Settings → WhatsApp.';
  }
}

function AlertRow({
  a,
  waAvailable,
  onSaved,
  onError,
}: {
  a: AlertSetting;
  waAvailable: boolean;
  onSaved: (v: AlertsView) => void;
  onError: (m: string) => void;
}) {
  // Local copies so typing an address doesn't fire a save per keystroke; committed on blur.
  const [email, setEmail] = useState(a.route.email);
  const [phone, setPhone] = useState(a.route.phone);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEmail(a.route.email);
    setPhone(a.route.phone);
  }, [a.route.email, a.route.phone]);

  const save = async (patch: Parameters<typeof setAlertRoute>[1]) => {
    setBusy(true);
    onError('');
    try {
      onSaved(await setAlertRoute(a.id, patch));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Couldn’t save that.');
      // Put the boxes back to what the server actually holds, so the screen never shows a value
      // that was refused.
      setEmail(a.route.email);
      setPhone(a.route.phone);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="alert-row">
      <div className="alert-row__head">
        <div>
          <b>{a.label}</b>
          <p className="muted alert-row__desc">{a.description}</p>
        </div>
        {a.summary.silent && (
          <span className="status-pill status-pill--warn" title="Nothing is switched on, so this alert goes nowhere.">
            <TriangleAlert size={13} aria-hidden="true" /> goes nowhere
          </span>
        )}
      </div>

      <div className="alert-row__channels">
        <label className="alert-ch">
          <input type="checkbox" checked={a.route.os} disabled={busy} onChange={(e) => void save({ os: e.target.checked })} />
          <span>
            OpenMasjidOS
            <small className="muted"> — email/webhook, as you set it there</small>
          </span>
        </label>

        <label className="alert-ch alert-ch--wide">
          <span className="alert-ch__label">Also email</span>
          <input
            type="email"
            className="input"
            placeholder="nobody@example.org"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => email.trim() !== a.route.email && void save({ email: email.trim() })}
            aria-label={`Email address for “${a.label}”`}
          />
        </label>

        <label className="alert-ch">
          <input
            type="checkbox"
            checked={a.route.whatsapp}
            disabled={busy || !waAvailable}
            onChange={(e) => void save({ whatsapp: e.target.checked })}
          />
          <span>
            <MessageCircle size={14} aria-hidden="true" /> WhatsApp
          </span>
        </label>

        <label className="alert-ch alert-ch--wide">
          <span className="alert-ch__label">Number</span>
          <input
            type="tel"
            className="input"
            placeholder="+44 7700 900123"
            value={phone}
            disabled={busy || !waAvailable}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => phone.trim() !== a.route.phone && void save({ phone: phone.trim() })}
            aria-label={`WhatsApp number for “${a.label}”`}
          />
        </label>
      </div>

      {a.route.whatsapp && !a.summary.whatsapp && (
        <p className="muted alert-row__hint">
          <TriangleAlert size={13} aria-hidden="true" /> WhatsApp is on for this alert but there’s no number, so nothing will be sent.
        </p>
      )}
    </div>
  );
}

export function NotificationsSection() {
  const [view, setView] = useState<AlertsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    getAlerts()
      .then((v) => alive && setView(v))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Couldn’t load your notification settings.'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const recheck = async () => {
    setRefreshing(true);
    try {
      const { whatsapp } = await refreshWhatsApp();
      setView((v) => (v ? { ...v, whatsapp } : v));
    } catch {
      /* the note below already says what to do */
    } finally {
      setRefreshing(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestMsg('');
    try {
      const r = await sendTestAlert();
      // Name the channels that actually took it. "Sent" alone would be a worse answer than none:
      // the whole reason to press this is to find out WHICH of your settings works.
      const went = [r.os && 'OpenMasjidOS', r.email && 'email', r.whatsapp && 'WhatsApp'].filter(Boolean).join(', ');
      setTestMsg(
        r.delivered
          ? `Sent via ${went}.${r.whatsapp ? ' WhatsApp is queued and paced, so it can take a few minutes.' : ''}${r.reasons.length ? ` Didn’t go by: ${r.reasons.join('; ')}.` : ''}`
          : r.reasons.length
            ? `Nothing was sent — ${r.reasons.join('; ')}.`
            : 'Nothing was sent, because nothing is switched on for the test message.',
      );
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : 'Couldn’t send the test.');
    } finally {
      setTesting(false);
    }
  };

  const waNote = view ? whatsappNote(view.whatsapp) : '';

  return (
    <section className="glass panel">
      <div className="card-head">
        <BellRing size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Notifications</h2>
          <p className="muted">
            Who gets told when something happens. Each one can go to OpenMasjidOS (which sends it on by email or webhook,
            as you’ve set it up there), straight to an email address, and to a WhatsApp number — or any combination.
          </p>
        </div>
      </div>

      {loading && (
        <p className="muted">
          <Loader2 size={14} className="spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {err && <p className="form-error">{err}</p>}

      {view && (
        <>
          {!view.embedded && (
            <p className="muted note">
              This kiosk isn’t connected to OpenMasjidOS, so it can’t send anything at all yet — alerts, emails and
              WhatsApp all go through the platform.
            </p>
          )}

          {waNote && (
            <p className="muted note">
              <MessageCircle size={14} aria-hidden="true" /> {waNote}{' '}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void recheck()} disabled={refreshing}>
                <RefreshCw size={13} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Check again
              </button>
            </p>
          )}

          <div className="alert-list">
            {view.alerts.map((a) => (
              <AlertRow key={a.id} a={a} waAvailable={view.whatsapp.available} onSaved={setView} onError={setErr} />
            ))}
          </div>

          <p className="muted note">
            WhatsApp goes through the masjid’s own number and is deliberately paced by OpenMasjidOS, so a message can take
            anywhere from seconds to a few minutes. Keep it for the things worth interrupting someone about — and note that
            donors are never messaged, only the numbers you enter here.
          </p>

          <div className="row" style={{ alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => void test()} disabled={testing}>
              {testing ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
              Send test message
            </button>
            {testMsg && (
              <span className="muted">
                <Check size={14} aria-hidden="true" /> {testMsg}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
