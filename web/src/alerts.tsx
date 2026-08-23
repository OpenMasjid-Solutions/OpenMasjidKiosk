// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Settings → Notifications: who gets told what.
 *
 *  ONE TABLE, and that is the whole design. A row is a destination, a column is an alert, and the
 *  checkbox at the intersection is the entire setting. It is the shape OpenMasjidStudents uses for
 *  the same job, and it replaces a per-alert form that could hold exactly one email address and one
 *  phone number — so a masjid with a treasurer AND a caretaker had to pick one, and the same address
 *  had to be retyped into every alert it wanted.
 *
 *  The OpenMasjidOS relay is the pinned first row rather than a control of its own, because it is a
 *  destination like any other — it just happens to be one whose address the platform owns. Putting
 *  it in the table means "who hears about a refund?" is one column to read down, with nothing
 *  hiding elsewhere on the screen. */
import { useEffect, useMemo, useState } from 'react';
import {
  BellRing,
  Check,
  Gauge,
  Loader2,
  Mail,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import {
  addAlertRecipient,
  dismissSuspectWindow,
  getAlerts,
  refreshWhatsApp,
  removeAlertRecipient,
  sendTestAlert,
  setAlertRelay,
  setWhatsAppPacing,
  updateAlertRecipient,
  type AlertRecipient,
  type AlertsView,
  type RecipientKind,
  type SuspectWindow,
  type WhatsAppAvailability,
  type WhatsAppSendRecord,
} from './api';
import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  e164LooksValid,
  formatE164ForDisplay,
  formatNational,
  placeholderFor,
  toE164Digits,
  type Country,
} from './phone';

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

/**
 * What became of the last WhatsApp to this recipient, in one line.
 *
 * This exists because a refused message and a lost one used to look identical. The platform answers
 * a bad send with a plain sentence — "That group has not been approved", "That phone number needs a
 * country code", "That is the number WhatsApp is linked to" — and every one of those went to a debug
 * log nobody reads. Shown quietly, on the row that caused it.
 */
function LastWhatsApp({ rec }: { rec: WhatsAppSendRecord | null }) {
  if (!rec) return null;
  const bad = rec.state === 'failed' || rec.state === 'expired' || rec.state === 'refused';
  const label =
    rec.state === 'sent'
      ? 'sent'
      : rec.state === 'queued'
        ? 'queued'
        : rec.state === 'refused'
          ? 'refused'
          : rec.state === 'expired'
            ? 'expired without sending'
            : 'failed';
  // "sent" is not believable for a message that went while the link was down. Say so on the row
  // rather than leaving a reassuring tick that is known to be wrong.
  const doubted = rec.suspect === true && (rec.state === 'sent' || rec.state === 'queued');
  return (
    <span className={`mx-last${bad || doubted ? ' text-warn' : ''}`} title={new Date(rec.at).toLocaleString()}>
      {bad || doubted ? <TriangleAlert size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}{' '}
      {doubted ? 'Last message may not have arrived — the WhatsApp link was down' : `Last message ${label}`}
      {!doubted && rec.reason ? `: ${rec.reason}` : ''}
      {rec.suppressed > 0 ? ` (${rec.suppressed} held back before it)` : ''}
    </span>
  );
}

/**
 * "The masjid's WhatsApp link was dead during this period."
 *
 * OpenMasjidOS reports a window in which it was still telling apps their messages were sent while
 * the gateway had quietly signed itself out. It cannot resend them — it deletes message contents
 * the moment it hands them over — and neither can this app, which stores no message bodies either.
 *
 * SO THIS IS DELIBERATELY NOT A "RESEND" BUTTON. Every WhatsApp the kiosk sends is an alert about a
 * moment: a reader went offline, a payment was refused. Re-sending "the card reader is offline" a
 * day late is worse than silence — the reader is probably fine now, and it would send someone to
 * check working hardware. What an admin can actually use is the period, so they can look at the
 * Donations and Devices pages for anything they missed.
 */
function SuspectBanner({ w, busy, onDismiss }: { w: SuspectWindow; busy: boolean; onDismiss: () => void }) {
  const from = new Date(w.from);
  const to = new Date(w.to);
  const sameDay = from.toDateString() === to.toDateString();
  return (
    <div className="glass panel suspect">
      <div className="card-head">
        <ShieldAlert size={18} className="panel-ico text-warn" aria-hidden="true" />
        <div className="card-head__main">
          <h3 className="section-title-inline">Some WhatsApp alerts may not have arrived</h3>
          <p className="muted">
            Your masjid’s WhatsApp connection had dropped between <b>{from.toLocaleString()}</b> and{' '}
            <b>{sameDay ? to.toLocaleTimeString() : to.toLocaleString()}</b>, and OpenMasjidOS didn’t
            notice straight away. <b>{w.count}</b> message{w.count === 1 ? '' : 's'} sent in that time
            {w.count === 1 ? ' was' : ' were'} recorded as sent but may never have been delivered.
          </p>
        </div>
      </div>
      <p className="muted note">
        Nothing was resent automatically, on purpose — these alerts describe a moment that has passed,
        and a card-reader warning arriving a day late would send someone to check hardware that is
        working. If you want to check what you missed, the <b>Donations</b> and <b>Devices</b> pages
        cover that period. Email alerts were unaffected.
      </p>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss} disabled={busy}>
        I’ve checked — dismiss
      </button>
    </div>
  );
}

function kindIcon(kind: RecipientKind) {
  if (kind === 'email') return <Mail size={13} aria-hidden="true" />;
  if (kind === 'group') return <Users size={13} aria-hidden="true" />;
  return <MessageCircle size={13} aria-hidden="true" />;
}

/** How a recipient's address reads on screen. A group shows the admin's own nickname. */
function addressLabel(r: AlertRecipient, groupLabels: Map<string, string>): string {
  if (r.kind === 'phone') return formatE164ForDisplay(r.address);
  if (r.kind === 'group') return groupLabels.get(r.address) ?? 'A WhatsApp group';
  return r.address;
}

// ── One recipient row ────────────────────────────────────────────────────────
function RecipientRow({
  r,
  alertIds,
  groupLabels,
  busy,
  onPatch,
  onRemove,
}: {
  r: AlertRecipient;
  alertIds: string[];
  groupLabels: Map<string, string>;
  busy: boolean;
  onPatch: (patch: { label?: string; alerts?: string[]; includeNames?: boolean }) => void;
  onRemove: () => void;
}) {
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...r.alerts, id] : r.alerts.filter((a) => a !== id);
    onPatch({ alerts: next });
  };
  const address = addressLabel(r, groupLabels);
  return (
    <tr>
      <th scope="row" className="mx-who">
        <span className="mx-who__name">
          {kindIcon(r.kind)} {r.label || address}
        </span>
        {r.label && <span className="mx-who__sub">{address}</span>}
        {r.kind === 'group' && (
          /* PER GROUP, and it defaults to off. Everyone in a WhatsApp group can see every other
             member's number, and the platform's own rule is that a group post must never carry one
             person's own business. A small trustees group is a different thing from a parents'
             broadcast, so this is the admin's call rather than ours. */
          <label className="mx-names">
            <input
              type="checkbox"
              checked={r.includeNames}
              disabled={busy}
              onChange={(e) => onPatch({ includeNames: e.target.checked })}
            />
            <span>
              Include donor names
              <small className="muted"> — off means amounts, kiosks and funds only</small>
            </span>
          </label>
        )}
        <LastWhatsApp rec={r.lastWhatsApp} />
      </th>
      {alertIds.map((id) => (
        <td key={id} className="mx-cell">
          <input
            type="checkbox"
            aria-label={`${r.label || address} — ${id}`}
            checked={r.alerts.includes(id)}
            disabled={busy}
            onChange={(e) => toggle(id, e.target.checked)}
          />
        </td>
      ))}
      <td className="mx-cell">
        <button type="button" className="btn btn--ghost btn--sm" title="Remove" onClick={onRemove} disabled={busy}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}

// ── Adding one ───────────────────────────────────────────────────────────────
function AddRecipient({
  view,
  busy,
  onAdd,
}: {
  view: AlertsView;
  busy: boolean;
  onAdd: (kind: RecipientKind, address: string, label: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<RecipientKind>('email');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [national, setNational] = useState('');
  const [group, setGroup] = useState('');
  const [label, setLabel] = useState('');

  const waOff = !view.whatsapp.available;
  const stored = toE164Digits(country, national);
  const canAdd =
    kind === 'email'
      ? /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email.trim())
      : kind === 'phone'
        ? e164LooksValid(stored)
        : group !== '';

  const submit = async () => {
    const address = kind === 'email' ? email.trim() : kind === 'phone' ? stored : group;
    await onAdd(kind, address, label.trim());
    setEmail('');
    setNational('');
    setGroup('');
    setLabel('');
  };

  const full = view.recipients.length >= view.maxRecipients;

  return (
    <div className="mx-add">
      <div className="mx-add__kinds" role="group" aria-label="What kind of recipient">
        {(['email', 'phone', 'group'] as RecipientKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`btn btn--sm${kind === k ? ' btn--primary' : ' btn--ghost'}`}
            onClick={() => setKind(k)}
            disabled={busy || (k !== 'email' && waOff)}
            title={k !== 'email' && waOff ? 'WhatsApp isn’t available on this server yet' : undefined}
          >
            {kindIcon(k)} {k === 'email' ? 'Email' : k === 'phone' ? 'WhatsApp number' : 'WhatsApp group'}
          </button>
        ))}
      </div>

      {full ? (
        <p className="muted note">
          That’s the most recipients we can hold ({view.maxRecipients}). To reach more people over WhatsApp, use a
          group — one message reaches everyone in it.
        </p>
      ) : (
        <div className="mx-add__row">
          {kind === 'email' && (
            <div className="field mx-add__grow">
              <label className="label" htmlFor="rcp-email">
                Email address
              </label>
              <input
                id="rcp-email"
                className="input"
                type="email"
                placeholder="office@example.org"
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}

          {kind === 'phone' && (
            <>
              <div className="field">
                <label className="label" htmlFor="rcp-country">
                  Country
                </label>
                <select
                  id="rcp-country"
                  className="input"
                  value={country.code}
                  disabled={busy}
                  onChange={(e) => setCountry(COUNTRIES.find((c) => c.code === e.target.value) ?? DEFAULT_COUNTRY)}
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field mx-add__grow">
                <label className="label" htmlFor="rcp-phone">
                  WhatsApp number
                </label>
                <input
                  id="rcp-phone"
                  className="input"
                  type="tel"
                  inputMode="tel"
                  placeholder={placeholderFor(country)}
                  value={formatNational(country, national)}
                  disabled={busy}
                  /* Re-formats on every keystroke, which is why the formatter accepts half-finished
                     states — `(555) 12` is a legitimate thing to be looking at. */
                  onChange={(e) => setNational(e.target.value)}
                />
              </div>
            </>
          )}

          {kind === 'group' && (
            <div className="field mx-add__grow">
              <label className="label" htmlFor="rcp-group">
                WhatsApp group
              </label>
              {view.groups.length > 0 ? (
                <select id="rcp-group" className="input" value={group} disabled={busy} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">Choose a group…</option>
                  {view.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              ) : (
                /* "We couldn't ask" and "none are approved" need different words: one is a problem to
                   chase, the other is a thing to go and do. */
                <p className="muted">
                  {view.groupsProblem && view.groupsProblem !== 'not-available'
                    ? 'Couldn’t read your approved groups just now — try Check again below.'
                    : 'No groups are approved yet. In OpenMasjidOS → Settings → WhatsApp → Groups, find your groups and approve the ones apps may post into.'}
                </p>
              )}
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="rcp-label">
              Name (optional)
            </label>
            <input
              id="rcp-label"
              className="input"
              placeholder="e.g. Treasurer"
              value={label}
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy || !canAdd}>
            Add
          </button>
        </div>
      )}

      <p className="muted mx-add__hint">
        New recipients start on the alerts that cost money or hide a problem. Tick the rest yourself. Adding someone
        grants them no access to the app — they only receive the alerts you tick.
      </p>
    </div>
  );
}

// ── How hard we may lean on the masjid's number ──────────────────────────────
function PacingPanel({
  view,
  busy,
  onSave,
}: {
  view: AlertsView;
  busy: boolean;
  onSave: (patch: { minGapMinutes?: number; maxPerHour?: number; maxPerDay?: number }) => void;
}) {
  const [gap, setGap] = useState(String(view.pacing.minGapMinutes));
  const [hour, setHour] = useState(String(view.pacing.maxPerHour));
  const [day, setDay] = useState(String(view.pacing.maxPerDay));

  useEffect(() => {
    setGap(String(view.pacing.minGapMinutes));
    setHour(String(view.pacing.maxPerHour));
    setDay(String(view.pacing.maxPerDay));
  }, [view.pacing.minGapMinutes, view.pacing.maxPerHour, view.pacing.maxPerDay]);

  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const commit = () => onSave({ minGapMinutes: num(gap), maxPerHour: num(hour), maxPerDay: num(day) });
  const lim = view.pacingLimits;

  return (
    <div className="mx-pacing">
      <div className="card-head">
        <Gauge size={16} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h3 className="section-title-inline">WhatsApp limits</h3>
          <p className="muted">
            How many WhatsApp messages this kiosk may send. It uses the masjid’s own number, a ban attaches to that
            number and can’t be undone — so there is a ceiling, and it’s yours to set. Email and OpenMasjidOS alerts are
            never limited.
          </p>
        </div>
      </div>
      <div className="mx-pacing__row">
        <div className="field">
          <label className="label" htmlFor="pace-hour">
            Most per hour
          </label>
          <input
            id="pace-hour"
            className="input"
            type="number"
            inputMode="numeric"
            min={lim.maxPerHour.min}
            max={lim.maxPerHour.max}
            value={hour}
            disabled={busy}
            onChange={(e) => setHour(e.target.value)}
            onBlur={commit}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pace-day">
            Most per day
          </label>
          <input
            id="pace-day"
            className="input"
            type="number"
            inputMode="numeric"
            min={lim.maxPerDay.min}
            max={lim.maxPerDay.max}
            value={day}
            disabled={busy}
            onChange={(e) => setDay(e.target.value)}
            onBlur={commit}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pace-gap">
            Wait between repeats (minutes)
          </label>
          <input
            id="pace-gap"
            className="input"
            type="number"
            inputMode="numeric"
            min={lim.minGapMinutes.min}
            max={lim.minGapMinutes.max}
            value={gap}
            disabled={busy}
            onChange={(e) => setGap(e.target.value)}
            onBlur={commit}
          />
        </div>
      </div>
      <p className="muted mx-add__hint">
        Used so far: <strong>{view.usage.lastHour}</strong> this hour, <strong>{view.usage.lastDay}</strong> today. The
        wait applies per kind of alert, so one repeating problem can’t use up the whole hour on its own — anything held
        back is counted and reported on the next message that goes. A test message is never held back.
      </p>
    </div>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────
export function NotificationsSection() {
  const [view, setView] = useState<AlertsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
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

  const groupLabels = useMemo(() => new Map((view?.groups ?? []).map((g) => [g.id, g.label])), [view?.groups]);
  const alertIds = useMemo(() => (view?.alerts ?? []).map((a) => a.id), [view?.alerts]);

  /** Every mutation returns the whole view, so the screen can never drift from the server. */
  const run = async (fn: () => Promise<AlertsView>) => {
    setBusy(true);
    setErr('');
    try {
      setView(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t save that.');
      // Put the screen back to what the server actually holds, so it never shows a refused value.
      await getAlerts()
        .then(setView)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setRefreshing(true);
    try {
      setView(await refreshWhatsApp());
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
      const went = [
        r.os && 'OpenMasjidOS',
        r.email > 0 && `${r.email} email${r.email === 1 ? '' : 's'}`,
        r.whatsapp > 0 && `${r.whatsapp} WhatsApp message${r.whatsapp === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join(', ');
      setTestMsg(
        r.delivered
          ? `Sent via ${went}.${r.whatsapp > 0 ? ' WhatsApp is queued, so it can take a moment.' : ''}${r.reasons.length ? ` Didn’t go by: ${r.reasons.join('; ')}.` : ''}`
          : r.reasons.length
            ? `Nothing was sent — ${r.reasons.join('; ')}.`
            : 'Nothing was sent, because nothing is ticked for the test message.',
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
            Who to tell when something happens. Add an address, a WhatsApp number, or a WhatsApp group — then tick what
            each one hears about. Adding someone grants no access to the app.
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

          {view.suspectWindows.map((w) => (
            <SuspectBanner
              key={w.from}
              w={w}
              busy={busy}
              onDismiss={() => void run(() => dismissSuspectWindow(w.from))}
            />
          ))}

          {waNote && (
            <p className="muted note">
              <MessageCircle size={14} aria-hidden="true" /> {waNote}{' '}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void recheck()} disabled={refreshing}>
                <RefreshCw size={13} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Check again
              </button>
            </p>
          )}

          {/* Wide on purpose, and it scrolls sideways rather than squeezing: an alert column that has
              been crushed to two characters is worse than one you have to scroll to. */}
          <div className="mx-wrap">
            <table className="mx">
              <thead>
                <tr>
                  <th className="mx-who">Who to tell</th>
                  {view.alerts.map((a) => (
                    <th key={a.id} className="mx-head" title={a.description}>
                      {a.label}
                      {a.carriesDonorIdentity && (
                        <span className="mx-head__flag" title="This alert names the donor. A group can be set not to carry names.">
                          names a donor
                        </span>
                      )}
                    </th>
                  ))}
                  <th className="mx-head" />
                </tr>
              </thead>
              <tbody>
                {/* The platform relay is a DESTINATION, so it belongs in the table — it just happens
                    to be the one whose address OpenMasjidOS owns. */}
                <tr className="mx-relay">
                  <th scope="row" className="mx-who">
                    <span className="mx-who__name">OpenMasjidOS</span>
                    <span className="mx-who__sub">Forwards by email or webhook, as you set it up there</span>
                  </th>
                  {view.alerts.map((a) => (
                    <td key={a.id} className="mx-cell">
                      <input
                        type="checkbox"
                        aria-label={`OpenMasjidOS — ${a.label}`}
                        checked={a.os}
                        disabled={busy}
                        onChange={(e) => void run(() => setAlertRelay(a.id, e.target.checked))}
                      />
                    </td>
                  ))}
                  <td className="mx-cell" />
                </tr>

                {view.recipients.map((r) => (
                  <RecipientRow
                    key={r.id}
                    r={r}
                    alertIds={alertIds}
                    groupLabels={groupLabels}
                    busy={busy}
                    onPatch={(patch) => void run(() => updateAlertRecipient(r.id, patch))}
                    onRemove={() => void run(() => removeAlertRecipient(r.id))}
                  />
                ))}

                {/* An alert nothing is ticked for goes nowhere, and that must be visible rather than
                    inferred by reading down a column. */}
                <tr className="mx-foot">
                  <th scope="row" className="mx-who">
                    <span className="muted">Where each one ends up</span>
                  </th>
                  {view.alerts.map((a) => (
                    <td key={a.id} className="mx-cell">
                      {a.delivery.silent ? (
                        <span className="status-pill status-pill--warn" title="Nothing is ticked, so this alert goes nowhere.">
                          <TriangleAlert size={12} aria-hidden="true" /> nowhere
                        </span>
                      ) : (
                        <span className="muted mx-tally">
                          {[
                            a.delivery.os && 'OS',
                            a.delivery.emails > 0 && `${a.delivery.emails}✉`,
                            a.delivery.phones > 0 && `${a.delivery.phones}☎`,
                            a.delivery.groups > 0 && `${a.delivery.groups}⌾`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </td>
                  ))}
                  <td className="mx-cell" />
                </tr>
              </tbody>
            </table>
          </div>

          <AddRecipient view={view} busy={busy} onAdd={(k, a, l) => run(() => addAlertRecipient(k, a, l))} />

          <PacingPanel view={view} busy={busy} onSave={(patch) => void run(() => setWhatsAppPacing(patch))} />

          <p className="muted note">
            <strong>Donors are never messaged.</strong> WhatsApp reaches only the numbers and groups you add here — there
            is no phone field anywhere in the giving flow. A message is handed to OpenMasjidOS rather than delivered by
            it, so treat WhatsApp as a nudge and email as the channel to rely on. Note that everyone in a WhatsApp group
            can see every other member’s number.
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

/** Kept so a stale import doesn't break the build during a partial refactor. */
export type { AlertRecipient };
