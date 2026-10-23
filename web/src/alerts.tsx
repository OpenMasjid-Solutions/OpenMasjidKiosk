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
 *  hiding elsewhere on the screen.
 *
 *  BUSY NEVER TAKES FOCUS AWAY. Every control that starts a save stays focusable while it runs —
 *  `aria-disabled` plus a guard in `run()`, not `disabled`. Disabling the checkbox a keyboard user
 *  has just ticked with Space drops their focus to the top of the document (the HTML focus-fixup
 *  rule), so every tick in a wide table would have sent them back to the start of the page. */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  BellRing,
  Check,
  Clock3,
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
  errorText,
  getAlerts,
  getMasjid,
  refreshWhatsApp,
  removeAlertRecipient,
  sendTestAlert,
  setAlertRelay,
  setWhatsAppPacing,
  updateAlertRecipient,
  type AlertDelivery,
  type AlertRecipient,
  type AlertSetting,
  type AlertTestResult,
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
import { formatDateTime, formatTime, sameDay } from './dates';
import { figures, ResultLine, Skeleton, useClock } from './ui';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A sentence we are about to add our own punctuation to — so "…approved." never becomes "…approved.." */
const bare = (s: string) => s.trim().replace(/[.\s]+$/, '');

/** "a", "a and b", "a, b, and c" — US English, so the serial comma. */
function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * What a test alert actually did, one channel at a time.
 *
 * The three channels mean three different things, and one word for all of them was the bug. The
 * OpenMasjidOS relay answers straight away, and an email is handed to a real provider that says
 * yes or no — so "sent" is a claim we can make for those. A WhatsApp is only ACCEPTED INTO A QUEUE:
 * the platform delivers it later, possibly much later if the masjid's link is down, and nothing on
 * this screen watched it arrive. So it is always "queued to send", never "sent" (spec §9 — this
 * project has been bitten by exactly that wording).
 *
 * `tone` follows the same line: `ok` only when something was verifiably handed over (the relay took
 * it, or an email went), `info` when the only thing that went is a queued WhatsApp, `bad` when
 * nothing went at all.
 *
 * Deliberately NOT built on the server's `delivered` flag, which counts a queued WhatsApp as
 * delivered — that meaning is what the "Nothing was sent" branch relies on, so it stays, and the
 * honesty lives in the wording here instead.
 *
 * Settings → Email receipts has a test button too, and it deliberately does NOT come through here: it
 * sends a real sample receipt (POST /api/admin/email-receipt/test), not an alert, so its result is
 * worded in email.tsx.
 */
function describeTestAlert(r: AlertTestResult): { tone: 'ok' | 'info' | 'bad'; text: string } {
  const went: string[] = [];
  if (r.os) went.push('OpenMasjidOS took it.');
  if (r.email > 0) went.push(`${plural(r.email, 'email', 'emails')} sent.`);
  if (r.whatsapp > 0) {
    went.push(`${plural(r.whatsapp, 'WhatsApp message', 'WhatsApp messages')} queued to send — it can take a few minutes.`);
  }
  // The server words each of these itself, naming the channel and the recipient ("email Treasurer:
  // …"), and the platform's own refusal sentences pass through it unchanged.
  const missed = (r.reasons ?? []).map(bare).filter(Boolean).join('; ');
  if (!went.length) {
    return {
      tone: 'bad',
      text: missed
        ? `Nothing was sent — ${missed}.`
        : 'Nothing was sent, because nobody is ticked for “Test message” in Settings → Notifications. Tick at least one, then try again.',
    };
  }
  return {
    tone: r.os || r.email > 0 ? 'ok' : 'info',
    text: `${went.join(' ')}${missed ? ` Didn’t go: ${missed}.` : ''}`,
  };
}

/** What to tell the admin about WhatsApp not being available — each reason needs a different fix,
 *  so a single "unavailable" would leave them guessing which. Each one ends on the thing to do, and
 *  the "Check again" it points at sits right beside the sentence. */
function whatsappNote(w: WhatsAppAvailability): string {
  switch (w.reason) {
    case 'ready':
      return '';
    case 'not-linked':
      return 'WhatsApp is set up on this server but no phone is linked to it yet. Link one in OpenMasjidOS → Settings → WhatsApp, then press Check again.';
    case 'unreachable':
      return 'WhatsApp isn’t answering at the moment. Wait a minute, then press Check again.';
    default:
      return 'WhatsApp isn’t set up on this server yet — an admin can add it in OpenMasjidOS → Settings → WhatsApp.';
  }
}

const RELINK = 'check WhatsApp is still linked in OpenMasjidOS → Settings → WhatsApp';

/**
 * What became of the last WhatsApp to this recipient, in one line.
 *
 * This exists because a refused message and a lost one used to look identical. The platform answers
 * a bad send with a plain sentence — "That group has not been approved", "That phone number needs a
 * country code", "That is the number WhatsApp is linked to" — and every one of those went to a debug
 * log nobody reads. Shown quietly, on the row that caused it.
 *
 * FOUR STATES, FOUR WORDINGS, and only one of them gets a tick. `queued` is the platform saying it
 * accepted the message for later — a clock, not a tick, because nobody has watched it go. `sent` is
 * the platform's report that it went, and is labelled as its report. A refusal shows the platform's
 * own sentence as-is (the server turns our internal fallback codes into words before storing them,
 * and must never flatten the platform's sentences). A failure or an expiry says what to check.
 *
 * A FAILURE'S OWN REASON GOES BEHIND "Technical details". The platform says `failed` carries the
 * gateway's own message, which is written for whoever runs the gateway, not for a volunteer — so the
 * row leads with the thing they can do, and the raw text is one click away for whoever helps them.
 */
function LastWhatsApp({ rec }: { rec: WhatsAppSendRecord | null }) {
  const clock = useClock();
  if (!rec) return null;
  const why = bare(rec.reason ?? '');
  // "sent" is not believable for a message that went while the link was down. Say so on the row
  // rather than leaving a reassuring tick that is known to be wrong.
  const doubted = rec.suspect === true && (rec.state === 'sent' || rec.state === 'queued');
  let tone: 'ok' | 'wait' | 'bad';
  let text: string;
  let technical = '';
  if (doubted) {
    tone = 'bad';
    text = 'Last message may not have arrived — the WhatsApp link was down (see the note above)';
  } else if (rec.state === 'sent') {
    tone = 'ok';
    text = 'Last message went out (reported by OpenMasjidOS)';
  } else if (rec.state === 'queued') {
    tone = 'wait';
    text = 'Last message queued to send';
  } else if (rec.state === 'refused') {
    tone = 'bad';
    text = why ? `Last message was refused: ${why}` : 'Last message was refused — check this address is right';
  } else if (rec.state === 'expired') {
    tone = 'bad';
    text = `Last message expired without sending — ${RELINK}`;
    technical = why;
  } else {
    tone = 'bad';
    text = `Last message failed to send — ${RELINK}`;
    technical = why;
  }
  const Icon = tone === 'ok' ? Check : tone === 'wait' ? Clock3 : TriangleAlert;
  return (
    <>
      <span className={`mx-last${tone === 'bad' ? ' text-warn' : ''}`} title={formatDateTime(rec.at, clock)}>
        <Icon size={12} aria-hidden="true" /> {text}
        {rec.suppressed > 0
          ? ` (${plural(rec.suppressed, 'earlier one', 'earlier ones')} held back by your WhatsApp limits)`
          : ''}
      </span>
      {/* The compact disclosure the activity log uses, because this sits inside a table cell. */}
      {technical && (
        <details className="log-tech">
          <summary>Technical details</summary>
          <span className="log-detail">{technical}</span>
        </details>
      )}
    </>
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
 *
 * The period is written in the MASJID'S zone and hour cycle, Gregorian with Hijri beside it, and
 * "the same day" is decided in that zone too — an admin checking from another time zone must be
 * pointed at the hours the masjid actually lived through, or the Donations page they go to next
 * will not line up with what this says.
 */
function SuspectBanner({ w, busy, onDismiss }: { w: SuspectWindow; busy: boolean; onDismiss: () => void }) {
  const clock = useClock();
  const oneDay = sameDay(w.from, w.to, clock);
  // Worded from the platform's `cause` rather than guessed, because each one needs a different
  // thing done about it — and two of them need the admin to go and DO something, not just read.
  const because =
    w.cause === 'session-expired'
      ? 'Your masjid’s WhatsApp signed itself out, the way WhatsApp Desktop does after a while.'
      : w.cause === 'needs-relink'
        ? 'Your masjid’s WhatsApp needs linking again — scan the code in OpenMasjidOS → Settings → WhatsApp.'
        : w.cause === 'key-rejected'
          ? 'Your masjid’s WhatsApp connection was refused — whoever set up WhatsApp in OpenMasjidOS will need to look at it.'
          : 'Your masjid’s WhatsApp connection had dropped.';
  return (
    <div className="glass panel suspect">
      <div className="card-head">
        <ShieldAlert size={18} className="panel-ico text-warn" aria-hidden="true" />
        <div className="card-head__main">
          <h3 className="section-title-inline">Some WhatsApp alerts may not have arrived</h3>
          <p className="muted">
            {/* dir="ltr" on the two times: a date is a run of Latin letters, digits and commas, and
                under an Arabic or Urdu page the bidi algorithm would otherwise put the time before
                the date and the comma at the wrong end. */}
            {because} It was down between <b dir="ltr">{formatDateTime(w.from, clock)}</b> and{' '}
            <b dir="ltr">{oneDay ? formatTime(w.to, clock) : formatDateTime(w.to, clock)}</b>, and OpenMasjidOS
            didn’t notice straight away. <b>{w.count}</b> message{w.count === 1 ? '' : 's'} sent in that time
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
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => !busy && onDismiss()}
        aria-disabled={busy || undefined}
      >
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

/**
 * The address, isolated from the text around it. A phone number or an email address is always
 * read left to right — in an Arabic or Urdu page `+44 7700 900123` would otherwise come out as
 * `900123 7700 44+`, and the admin would check the wrong number. A group's nickname is the admin's
 * own words and may itself be Arabic, so it is isolated but keeps its own direction.
 */
function AddressText({ r, text }: { r: AlertRecipient; text: string }) {
  return r.kind === 'group' ? <bdi>{text}</bdi> : <bdi dir="ltr">{text}</bdi>;
}

/**
 * "Where each one ends up", in words.
 *
 * It used to be glyphs — `OS · 2✉ · 1☎` — which a volunteer has to decode and a screen reader reads
 * as "envelope" and "black telephone", or skips. Now it is short words to look at, one per line so
 * the column stays narrow, and one full sentence to hear. (The sentence is sr-only text rather than
 * an aria-label, because an aria-label on a plain span is not something every screen reader reads.)
 */
function Tally({ d }: { d: AlertDelivery }) {
  const seen = [
    d.os && 'OpenMasjidOS',
    d.emails > 0 && plural(d.emails, 'email', 'emails'),
    d.phones > 0 && plural(d.phones, 'number', 'numbers'),
    d.groups > 0 && plural(d.groups, 'group', 'groups'),
  ].filter((x): x is string => Boolean(x));
  const heard = [
    d.os && 'OpenMasjidOS',
    d.emails > 0 && plural(d.emails, 'email address', 'email addresses'),
    d.phones > 0 && plural(d.phones, 'WhatsApp number', 'WhatsApp numbers'),
    d.groups > 0 && plural(d.groups, 'WhatsApp group', 'WhatsApp groups'),
  ].filter((x): x is string => Boolean(x));
  return (
    <span className="muted mx-tally">
      <span aria-hidden="true">
        {seen.map((s, i) => (
          <Fragment key={s}>
            {i > 0 && <br />}
            {figures(s)}
          </Fragment>
        ))}
      </span>
      <span className="sr-only">Goes to {listWords(heard)}</span>
    </span>
  );
}

// ── One recipient row ────────────────────────────────────────────────────────
function RecipientRow({
  r,
  alerts,
  groupLabels,
  busy,
  onPatch,
  onRemove,
}: {
  r: AlertRecipient;
  alerts: AlertSetting[];
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
  // What a screen reader calls this row in every control's name — the admin's own name for it when
  // they gave one, otherwise the address.
  const who = r.label || address;
  return (
    <tr>
      <th scope="row" className="mx-who">
        <span className="mx-who__name">
          {kindIcon(r.kind)} {r.label ? <bdi>{r.label}</bdi> : <AddressText r={r} text={address} />}
        </span>
        {r.label && (
          <span className="mx-who__sub">
            <AddressText r={r} text={address} />
          </span>
        )}
        {r.kind === 'group' && (
          /* PER GROUP, and it defaults to off. Everyone in a WhatsApp group can see every other
             member's number, and the platform's own rule is that a group post must never carry one
             person's own business. A small trustees group is a different thing from a parents'
             broadcast, so this is the admin's call rather than ours. */
          <label className="mx-names">
            <input
              type="checkbox"
              checked={r.includeNames}
              aria-disabled={busy || undefined}
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
      {alerts.map((a) => (
        <td key={a.id} className="mx-cell">
          {/* The alert's LABEL, never its id — "Treasurer — payment-failed" is a database key read
              aloud. The relay row below has always done it this way. */}
          <input
            type="checkbox"
            aria-label={`${who} — ${a.label}`}
            checked={r.alerts.includes(a.id)}
            aria-disabled={busy || undefined}
            onChange={(e) => toggle(a.id, e.target.checked)}
          />
        </td>
      ))}
      <td className="mx-cell">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          title="Remove"
          aria-label={`Remove ${who}`}
          data-remove={r.id}
          onClick={onRemove}
          aria-disabled={busy || undefined}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}

/**
 * The phone row a masjid's own address points at, if we offer one. Canada shares +1 with the US —
 * the list's "US / CA" row — so it maps there rather than falling through to "Somewhere else".
 */
function countryForAddress(iso: string): Country | undefined {
  const code = iso.trim().toUpperCase();
  const key = code === 'CA' ? 'US' : code;
  if (!key || key === 'OTHER') return undefined;
  return COUNTRIES.find((c) => c.code === key);
}

// ── Adding one ───────────────────────────────────────────────────────────────
function AddRecipient({
  view,
  busy,
  refreshing,
  onAdd,
  onRecheck,
}: {
  view: AlertsView;
  busy: boolean;
  refreshing: boolean;
  /** Resolves true when the recipient was saved — only then is the form cleared. */
  onAdd: (kind: RecipientKind, address: string, label: string) => Promise<boolean>;
  onRecheck: () => void;
}) {
  const [kind, setKind] = useState<RecipientKind>('email');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [national, setNational] = useState('');
  const [group, setGroup] = useState('');
  const [label, setLabel] = useState('');
  const addressRef = useRef<HTMLInputElement & HTMLSelectElement>(null);

  // START ON THE MASJID'S OWN COUNTRY. The list opens on +1 because it has to open somewhere, and
  // a UK or Pakistani masjid then started every caretaker's number on the wrong code. The masjid's
  // address is already in its own settings (spec §10/§12 — take it from there, never the device),
  // so use it — but only while the number is still empty and nobody has picked a country by hand,
  // because an answer arriving late must never change a choice the admin already made.
  const nationalRef = useRef('');
  const pickedRef = useRef(false);
  useEffect(() => {
    nationalRef.current = national;
  }, [national]);
  useEffect(() => {
    let alive = true;
    getMasjid()
      .then((m) => {
        if (!alive || pickedRef.current || nationalRef.current !== '') return;
        const c = countryForAddress(m.address?.country ?? '');
        if (c) setCountry(c);
      })
      .catch(() => {
        /* the dropdown still works; it just starts on +1 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const waOff = !view.whatsapp.available;
  const stored = toE164Digits(country, national);
  const canAdd =
    kind === 'email'
      ? /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email.trim())
      : kind === 'phone'
        ? e164LooksValid(stored)
        : group !== '';

  const submit = async () => {
    if (busy || !canAdd) return;
    const address = kind === 'email' ? email.trim() : kind === 'phone' ? stored : group;
    // Cleared only once it SAVED. A refusal ("That number needs its country code…") is telling the
    // admin to correct what they typed, and a box that empties itself would make them retype it.
    if (!(await onAdd(kind, address, label.trim()))) return;
    // Back to the address box, ready for the next one — and before the now-empty form disables
    // the Add button this focus is sitting on.
    addressRef.current?.focus();
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
            aria-pressed={kind === k}
            onClick={() => !busy && setKind(k)}
            aria-disabled={busy || undefined}
            disabled={k !== 'email' && waOff}
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
                ref={addressRef}
                id="rcp-email"
                className="input"
                type="email"
                dir="ltr"
                placeholder="office@example.org"
                value={email}
                readOnly={busy}
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
                  aria-disabled={busy || undefined}
                  onChange={(e) => {
                    if (busy) return;
                    pickedRef.current = true;
                    setCountry(COUNTRIES.find((c) => c.code === e.target.value) ?? DEFAULT_COUNTRY);
                  }}
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
                  ref={addressRef}
                  id="rcp-phone"
                  className="input"
                  type="tel"
                  inputMode="tel"
                  /* A phone number reads left to right in every language, and the mask's spaces
                     and brackets would be reordered and mirrored under an RTL page. */
                  dir="ltr"
                  placeholder={placeholderFor(country)}
                  value={formatNational(country, national)}
                  readOnly={busy}
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
                <select
                  ref={addressRef}
                  id="rcp-group"
                  className="input"
                  value={group}
                  aria-disabled={busy || undefined}
                  onChange={(e) => !busy && setGroup(e.target.value)}
                >
                  <option value="">Choose a group…</option>
                  {view.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              ) : view.groupsProblem && view.groupsProblem !== 'not-available' ? (
                /* "We couldn't ask" and "none are approved" need different words: one is a problem to
                   chase, the other is a thing to go and do. The retry sits right here, because the
                   screen's other "Check again" only appears while WhatsApp itself is unavailable —
                   and here it is available, it is only the group list that didn't come back. */
                <p className="muted">
                  Couldn’t read your approved groups just now.{' '}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={onRecheck}
                    aria-disabled={refreshing || undefined}
                  >
                    <RefreshCw size={13} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Check again
                  </button>
                </p>
              ) : (
                <p className="muted">
                  No groups are approved yet. In OpenMasjidOS → Settings → WhatsApp → Groups, find your groups and
                  approve the ones apps may post into.
                </p>
              )}
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="rcp-label">
              Name (optional)
            </label>
            {/* 80 is the server's own cap. Stated here so the box stops at it while they type,
                rather than the server quietly trimming a name they never saw cut. */}
            <input
              id="rcp-label"
              className="input"
              placeholder="e.g. Treasurer"
              maxLength={80}
              value={label}
              readOnly={busy}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            aria-disabled={busy || undefined}
            disabled={!canAdd}
          >
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

  // readOnly rather than disabled while a save runs: these save on blur, so tabbing out of one
  // starts a save while focus lands on the next — and a disabled field would drop it.
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
            dir="ltr"
            min={lim.maxPerHour.min}
            max={lim.maxPerHour.max}
            value={hour}
            readOnly={busy}
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
            dir="ltr"
            min={lim.maxPerDay.min}
            max={lim.maxPerDay.max}
            value={day}
            readOnly={busy}
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
            dir="ltr"
            min={lim.minGapMinutes.min}
            max={lim.minGapMinutes.max}
            value={gap}
            readOnly={busy}
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
  // Every date on this screen is written in the masjid's zone; re-render when those settings land.
  useClock();
  const [view, setView] = useState<AlertsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: 'ok' | 'info' | 'bad'; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const alive = useRef(true);
  const busyRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  /** Where focus goes once a removal has re-rendered: a recipient id (its Remove button), '' for the
   *  heading, null for nowhere. See the effect below. */
  const pendingFocus = useRef<string | null>(null);

  /** Load the screen. On a retry the error and its Try again button stay up while it runs — the
   *  button has focus, and taking it away mid-press would drop that — and once the settings arrive
   *  focus goes to the heading they appeared under. */
  const load = (retry = false) => {
    if (retry) {
      if (loading) return;
      pendingFocus.current = '';
    }
    setLoading(true);
    getAlerts()
      .then((v) => {
        if (!alive.current) return;
        setLoadErr('');
        setView(v);
      })
      .catch((e) => {
        if (!alive.current) return;
        pendingFocus.current = null;
        setLoadErr(errorText(e, 'Couldn’t load your notification settings. Please try again.'));
      })
      .finally(() => alive.current && setLoading(false));
  };

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, []);

  // A removed row takes its focused Remove button with it, and a dismissed banner its button — and
  // focus that falls off the page lands a keyboard user back at the top of the document. So once the
  // new view has rendered, put it on the neighbouring row's Remove button (which sits where the old
  // one was), or on the section heading when there is none. Only when focus really was lost: a
  // removal that failed leaves the button, still focused, and nothing should move.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    const next = target ? tableRef.current?.querySelector<HTMLElement>(`[data-remove="${CSS.escape(target)}"]`) : null;
    if (next) next.focus({ preventScroll: true });
    else headingRef.current?.focus();
  }, [view]);

  const groupLabels = useMemo(() => new Map((view?.groups ?? []).map((g) => [g.id, g.label])), [view?.groups]);

  /** Every mutation returns the whole view, so the screen can never drift from the server.
   *  Resolves true when the save went through. One at a time: the controls stay focusable while
   *  one runs (see the file comment), so this is where a second press is turned away. */
  const run = async (fn: () => Promise<AlertsView>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setErr('');
    try {
      setView(await fn());
      return true;
    } catch (e) {
      setErr(errorText(e, 'Couldn’t save that. Please try again.'));
      // Put the screen back to what the server actually holds, so it never shows a refused value.
      await getAlerts()
        .then(setView)
        .catch(() => {});
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const list = view?.recipients ?? [];
    const i = list.findIndex((x) => x.id === id);
    const neighbour = list[i + 1] ?? list[i - 1];
    pendingFocus.current = neighbour ? neighbour.id : '';
    if (!(await run(() => removeAlertRecipient(id)))) pendingFocus.current = null;
  };

  const dismiss = async (from: number) => {
    pendingFocus.current = '';
    if (!(await run(() => dismissSuspectWindow(from)))) pendingFocus.current = null;
  };

  const recheck = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      setView(await refreshWhatsApp());
    } catch {
      /* the note beside the button already says what to do */
    } finally {
      setRefreshing(false);
    }
  };

  const test = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Name the channels that actually took it. "Sent" alone would be a worse answer than none:
      // the whole reason to press this is to find out WHICH of your settings works.
      setTestResult(describeTestAlert(await sendTestAlert()));
      // The test writes each WhatsApp row's "last message" record — a refusal lands on the row
      // that caused it — so re-read, or the rows would still be describing the message before.
      getAlerts()
        .then((v) => alive.current && setView(v))
        .catch(() => {});
    } catch (e) {
      setTestResult({ tone: 'bad', text: errorText(e, 'Couldn’t send the test. Please try again.') });
    } finally {
      setTesting(false);
    }
  };

  const waNote = view ? whatsappNote(view.whatsapp) : '';

  return (
    <section className="glass panel" aria-busy={loading}>
      <div className="card-head">
        <BellRing size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline" ref={headingRef} tabIndex={-1}>
            Notifications
          </h2>
          <p className="muted">
            Who to tell when something happens. Add an address, a WhatsApp number, or a WhatsApp group — then tick what
            each one hears about. Adding someone grants no access to the app.
          </p>
        </div>
      </div>

      {/* Shaped like the table it stands in for: a row per destination. */}
      {loading && !view && !loadErr && <Skeleton rows={4} height="2.4rem" label="Loading your notification settings…" />}
      {loadErr && !view && (
        <>
          <ResultLine ok={false}>{loadErr}</ResultLine>
          <button type="button" className="btn btn--sm" onClick={() => load(true)} aria-disabled={loading || undefined}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} aria-hidden="true" /> Try again
          </button>
        </>
      )}
      {err && <ResultLine ok={false}>{err}</ResultLine>}

      {view && (
        <>
          {!view.embedded && (
            <p className="muted note">
              This kiosk isn’t connected to OpenMasjidOS, so it can’t send anything at all yet — alerts, emails and
              WhatsApp all go through the platform.
            </p>
          )}

          {view.suspectWindows.map((w) => (
            <SuspectBanner key={w.from} w={w} busy={busy} onDismiss={() => void dismiss(w.from)} />
          ))}

          {waNote && (
            <p className="muted note">
              <MessageCircle size={14} aria-hidden="true" /> {waNote}{' '}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void recheck()}
                aria-disabled={refreshing || undefined}
              >
                <RefreshCw size={13} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Check again
              </button>
            </p>
          )}

          {/* Wide on purpose, and it scrolls sideways rather than squeezing: an alert column that has
              been crushed to two characters is worse than one you have to scroll to. */}
          <div className="mx-wrap">
            <table className="mx" ref={tableRef}>
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
                  <th className="mx-head">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* The platform relay is a DESTINATION, so it belongs in the table — it just happens
                    to be the one whose address OpenMasjidOS owns. */}
                <tr className="mx-relay">
                  <th scope="row" className="mx-who">
                    <span className="mx-who__name">OpenMasjidOS</span>
                    <span className="mx-who__sub">Passes it on however you set that up in OpenMasjidOS</span>
                  </th>
                  {view.alerts.map((a) => (
                    <td key={a.id} className="mx-cell">
                      <input
                        type="checkbox"
                        aria-label={`OpenMasjidOS — ${a.label}`}
                        checked={a.os}
                        aria-disabled={busy || undefined}
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
                    alerts={view.alerts}
                    groupLabels={groupLabels}
                    busy={busy}
                    onPatch={(patch) => void run(() => updateAlertRecipient(r.id, patch))}
                    onRemove={() => void remove(r.id)}
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
                        <Tally d={a.delivery} />
                      )}
                    </td>
                  ))}
                  <td className="mx-cell" />
                </tr>
              </tbody>
            </table>
          </div>

          <AddRecipient
            view={view}
            busy={busy}
            refreshing={refreshing}
            onAdd={(k, a, l) => run(() => addAlertRecipient(k, a, l))}
            onRecheck={() => void recheck()}
          />

          <PacingPanel view={view} busy={busy} onSave={(patch) => void run(() => setWhatsAppPacing(patch))} />

          <p className="muted note">
            <strong>Donors are never messaged.</strong> WhatsApp reaches only the numbers and groups you add here — there
            is no phone field anywhere in the giving flow. A message is handed to OpenMasjidOS rather than delivered by
            it, so treat WhatsApp as a nudge and email as the channel to rely on. Note that everyone in a WhatsApp group
            can see every other member’s number.
          </p>

          <div className="row" style={{ alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => void test()} aria-disabled={testing || undefined}>
              {testing ? (
                <Loader2 size={15} className="spin" aria-hidden="true" />
              ) : (
                <Send size={15} className="rtl-flip" aria-hidden="true" />
              )}
              Send test message
            </button>
          </div>
          {/* The tick only for something verifiably handed over; a queued-only WhatsApp is "info",
              and nothing-went is an alert — never a success mark beside a failure. */}
          {testResult && (
            <ResultLine ok={testResult.tone === 'ok'} tone={testResult.tone === 'info' ? 'info' : undefined}>
              {testResult.text}
            </ResultLine>
          )}
        </>
      )}
    </section>
  );
}

/** Kept so a stale import doesn't break the build during a partial refactor. */
export type { AlertRecipient };
