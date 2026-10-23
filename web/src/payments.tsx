// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The in-app Stripe setup screen, shown as the first card in the Settings tab. It lets a
 *  volunteer: pick a Stripe account from the OpenMasjidOS Fabric (or enter keys manually
 *  when running standalone), choose a currency, record the masjid's details — including the
 *  masjid's clock, which every date on the panel is shown in — and register the card reader's
 *  Terminal Location, then test the whole thing. No secret key is ever shown or sent here: a
 *  Fabric key lives in the server's memory only, and a key typed in below is saved on the server
 *  and nowhere else. Every call fails soft to a friendly inline message, never a crash. Matches
 *  the admin design language (panels, design tokens, RTL-safe logical spacing, reduced-motion
 *  respected). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  CalendarClock,
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
  ApiError,
  chooseLocation,
  createLocation,
  errorText,
  getPayments,
  listLocations,
  saveMasjid,
  setCurrency,
  setLocalKeys,
  setStripeAccount,
  testPayments,
  type CreateLocationAddress,
  type MasjidAddress,
  type MasjidPatch,
  type PaymentsStatus,
  type TerminalLocation,
  type TestPaymentsResult,
  type VerifyResult,
} from './api';
import { deviceTimeZone, isValidTimeZone, localeForCountry, setClock, type ClockSettings } from './locale';
import { formatDateTime, formatTime, hijriDate } from './dates';
import { ResultLine, Skeleton, useClock } from './ui';

/** "test mode" / "live mode" / "" — empty when the mode is unknown, so callers can drop it. */
const modeLabel = (m?: string) => (m === 'test' ? 'test mode' : m === 'live' ? 'live mode' : '');
/** A currency clause like " (test mode)" only when the mode is known. */
const modeSuffix = (m?: string) => (modeLabel(m) ? ` (${modeLabel(m)})` : '');

// A friendly common set; the masjid's current currency is always kept in the list. No zero- or
// three-decimal currency is offered yet (KWD, JPY…): every formatter handles them correctly, but
// they go in only once Stripe Terminal's card-present support for that currency is confirmed.
const CURRENCIES = ['usd', 'gbp', 'eur', 'cad', 'aud', 'myr', 'pkr', 'inr', 'aed', 'sar'];

/**
 * A failed call, kept whole: the sentence a volunteer reads and, apart from it, any technical text
 * the server chose to attach (a Stripe message, say). That second part only ever goes behind
 * "Technical details" — never in the line itself (spec §9: no raw errors, an expander for whoever
 * needs it).
 */
type Failure = { text: string; detail: string } | null;
const failureOf = (e: unknown): Failure => ({ text: errorText(e), detail: e instanceof ApiError ? e.detail : '' });

function FailureLine({ failure }: { failure: Failure }) {
  if (!failure) return null;
  return (
    <>
      <ResultLine ok={false}>{failure.text}</ResultLine>
      {failure.detail && (
        <details className="tech-details">
          <summary>Technical details</summary>
          <code className="mono" dir="ltr">{failure.detail}</code>
        </details>
      )}
    </>
  );
}

/** "Saved", as a status that is ALWAYS in the page and only changes its words. A live region that
 *  mounts already holding its text is missed by some screen readers, so the element stays put and
 *  stays empty until there is something to say (WCAG 4.1.3). */
function SavedNote({ show }: { show: boolean }) {
  return (
    <span role="status" className={show ? 'status-pill status-pill--ok' : 'sr-only'}>
      {show && (
        <>
          <CheckCircle2 size={14} aria-hidden="true" /> Saved
        </>
      )}
    </span>
  );
}

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
              <span className="status-dot" aria-hidden="true" /> Ready to take payments
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
  const [err, setErr] = useState<Failure>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  // Whether the mismatch warning below is news. It is standing state, shown on every visit to
  // Settings, so it is announced only when a save in this visit is what revealed it.
  const [justSaved, setJustSaved] = useState(false);

  const save = async () => {
    // aria-disabled rather than disabled while saving, so the button the admin just pressed keeps
    // focus (a disabled element drops it to the page); this return is what actually stops a repeat.
    if (busy) return;
    setErr(null);
    setVerify(null);
    setJustSaved(false);
    setBusy(true);
    try {
      const body: { publishableKey?: string; secretKey?: string } = {};
      if (pk.trim()) body.publishableKey = pk.trim();
      if (sk.trim()) body.secretKey = sk.trim();
      const res = await setLocalKeys(body);
      onStatus(res);
      setSk('');
      setVerify(res.verify ?? null);
      setJustSaved(true);
    } catch (e) {
      setErr(failureOf(e));
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
          dir="ltr"
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
          dir="ltr"
          value={sk}
          onChange={(e) => setSk(e.target.value)}
          placeholder={local.hasSecretKey ? '•••• set — leave blank to keep' : 'sk_live_… or sk_test_…'}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="pay-sk-hint"
        />
        {/* Honest about where it goes: a key typed here IS written to this server's database (it has
            to be, or a standalone kiosk would stop taking payments at every restart). Only a key
            fetched from OpenMasjidOS is memory-only. */}
        <p className="hint" id="pay-sk-hint">Saved on this server only — never shown again and never sent to a tablet.</p>
      </div>
      {local.keysMismatch && (
        // Keyed on justSaved so the line is inserted afresh when it becomes news: a live role added
        // to an element that is already on screen is not reliably announced.
        <ResultLine key={justSaved ? 'saved' : 'standing'} ok={false} live={justSaved}>
          These keys look like they’re from different Stripe accounts. Copy both from the same account, then save again.
        </ResultLine>
      )}
      <FailureLine failure={err} />
      {verify && (
        <ResultLine ok={verify.ok}>
          {verify.ok
            ? `Stripe accepted the key${modeSuffix(verify.mode)}.`
            : verify.message || 'Stripe couldn’t verify that key. Check you copied all of it, then save again.'}
        </ResultLine>
      )}
      <button
        className="btn btn--primary btn--sm"
        style={{ marginBlockStart: '0.6rem' }}
        onClick={() => void save()}
        aria-disabled={busy || undefined}
      >
        {busy ? (
          <>
            <Loader2 size={15} className="spin" aria-hidden="true" /> Saving…
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
  const [err, setErr] = useState<Failure>(null);
  const [showManual, setShowManual] = useState(!fabric.available);
  // Whether the account's status line is news (see ManualKeys): announced after a pick, silent when
  // it is just how things stand on opening Settings.
  const [justChose, setJustChose] = useState(false);

  const choose = async (id: string) => {
    // The select stays focusable while a change is saving (aria-disabled); a second change made
    // meanwhile is ignored here and the controlled value snaps back to the saved account.
    if (busy || id === fabric.chosenId) return;
    setErr(null);
    setJustChose(false);
    setBusy(true);
    try {
      onStatus(await setStripeAccount(id));
      setJustChose(true);
    } catch (e) {
      setErr(failureOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <Landmark size={16} aria-hidden="true" /> Stripe account
      </div>

      {fabric.available ? (
        <>
          <div className="field">
            <label className="label" htmlFor="pay-acct">Choose a Stripe account</label>
            <select
              id="pay-acct"
              className="input"
              value={fabric.chosenId}
              aria-disabled={busy || undefined}
              onChange={(e) => void choose(e.target.value)}
            >
              <option value="">Select an account…</option>
              {fabric.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>
          {fabric.status && (
            <ResultLine key={justChose ? 'chosen' : 'standing'} ok={fabric.status.configured} live={justChose}>
              {fabric.status.configured
                ? `Connected${modeLabel(fabric.status.mode) ? ` in ${modeLabel(fabric.status.mode)}` : ''}.`
                : 'This account has no keys yet — add them in OpenMasjidOS → Settings → Payments.'}
            </ResultLine>
          )}
          <p className="hint" style={{ marginBlockStart: '0.6rem' }}>Add or manage Stripe accounts in OpenMasjidOS → Settings → Payments.</p>
        </>
      ) : (
        <p className="hint" style={{ marginBlockEnd: '0.6rem' }}>
          Not connected to OpenMasjidOS — enter your Stripe keys below to take payments.
        </p>
      )}

      <FailureLine failure={err} />

      {fabric.available && (
        <button
          className="btn btn--ghost btn--sm pay-disclose"
          onClick={() => setShowManual((v) => !v)}
          aria-expanded={showManual}
        >
          <ChevronDown size={15} aria-hidden="true" className={showManual ? 'pay-chev pay-chev--open' : 'pay-chev'} /> Enter keys manually
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
  const [err, setErr] = useState<Failure>(null);
  // Set when the server had to rescale the suggested amounts (USD → KWD moves to three decimals,
  // USD → JPY to none), so a $10 tile becomes 10 KWD rather than the 1.000 KWD its 1000 minor units
  // would otherwise read as. Said out loud because the admin's own amounts were edited for them, and
  // they should hear it here — not from a donor at the kiosk.
  const [rescaledTo, setRescaledTo] = useState('');

  const change = async (c: string) => {
    if (busy || c === cur) return;
    setErr(null);
    setRescaledTo('');
    setBusy(true);
    try {
      const res = await setCurrency(c);
      onStatus(res);
      if (res.rescaled === true) setRescaledTo(c.toUpperCase());
    } catch (e) {
      setErr(failureOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <Wallet size={16} aria-hidden="true" /> Currency
      </div>
      <div className="field">
        <label className="label" htmlFor="pay-cur">Donation currency</label>
        <select id="pay-cur" className="input" value={cur} aria-disabled={busy || undefined} onChange={(e) => void change(e.target.value)}>
          {opts.map((c) => (
            <option key={c} value={c}>{c.toUpperCase()}</option>
          ))}
        </select>
      </div>
      {rescaledTo && <ResultLine ok>Your suggested amounts were converted to {rescaledTo} so they still mean the same.</ResultLine>}
      <FailureLine failure={err} />
    </div>
  );
}

/**
 * Every IANA zone this browser knows, for the time-zone picker. `Intl.supportedValuesOf` is newer
 * than some browsers a masjid office still runs (Safari before 15.4), so the list is guarded: however
 * short it comes back, it always holds the saved zone and this computer's own — the two an admin
 * could actually want — plus UTC. This computer's zone is added separately even when the list exists,
 * because a browser can report an older alias ("Asia/Calcutta") that the canonical list spells
 * differently, and a picker that cannot show the zone it was just told to use looks broken.
 */
function timeZoneChoices(saved: string, here: string): string[] {
  let all: string[] = [];
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone');
    if (Array.isArray(list)) all = list;
  } catch {
    // An older browser: the short list below is what it gets.
  }
  const set = new Set(all);
  for (const z of [saved, here, 'UTC']) if (z && isValidTimeZone(z)) set.add(z);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** "America/New_York" → "America/New York". The value stays the IANA id; only the words change. */
const zoneLabel = (z: string) => z.replace(/_/g, ' ');

/** The Hijri adjustment's range, the same as OpenMasjidDisplay's, so the masjid's screens and its
 *  kiosk can be set to agree. */
const HIJRI_OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
const offsetLabel = (n: number) => (n === 0 ? 'None' : `${n > 0 ? '+' : '−'}${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`);

/** Masjid name + address — used to name/address the reader's Stripe Terminal Location — and the
 *  masjid's clock: the time zone, 12/24-hour and Hijri adjustment every date on the panel, on a
 *  receipt and in the CSV is written with. */
function MasjidDetails({ status, refresh }: { status: PaymentsStatus; refresh: () => Promise<void> }) {
  const [name, setName] = useState(status.masjid.name);
  const [addr, setAddr] = useState<MasjidAddress>(status.masjid.address);
  // `||`/`=== true`/`?? 0` rather than trusting the type: a server a release behind sends none of
  // these, and the form should still open on sensible values rather than `undefined`.
  const [tz, setTz] = useState(status.masjid.timeZone || '');
  const [clock24h, setClock24h] = useState(status.masjid.clock24h === true);
  const [hijriOffset, setHijriOffset] = useState(status.masjid.hijriOffset ?? 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Failure>(null);
  const [done, setDone] = useState(false);

  const clock = useClock();
  // App.tsx saves this computer's zone as the masjid's on the very first sign-in, and that can land a
  // moment AFTER this form read the details. Adopt it, so the picker shows what is really in use —
  // and see save(), which never sends an empty zone back over it.
  useEffect(() => {
    if (!tz && clock.timeZone) setTz(clock.timeZone);
  }, [clock.timeZone, tz]);

  // This computer's zone — only ever OFFERED (the button below), never used to format anything.
  const [here] = useState(deviceTimeZone);
  const tzRef = useRef<HTMLSelectElement>(null);
  const zones = useMemo(() => timeZoneChoices(tz, here), [tz, here]);
  // One moment, fixed when the form opened, for the samples below. They are examples of how a time is
  // WRITTEN, not a clock, so they have no reason to tick (and a ticking line would be noise).
  const [now] = useState(() => Date.now());
  // The settings as they WILL be once saved, so every sample on this form shows the effect of the
  // choice being made rather than of the one already saved. The locale follows the country field.
  const draft: ClockSettings = { timeZone: tz, clock24h, hijriOffset, locale: localeForCountry(addr.country) };
  const hijriToday = hijriDate(now, draft);

  const set = (k: keyof MasjidAddress, v: string) => {
    setAddr((a) => ({ ...a, [k]: v }));
    setDone(false);
  };

  const save = async () => {
    if (busy) return;
    setErr(null);
    setDone(false);
    setBusy(true);
    try {
      const patch: MasjidPatch = { name: name.trim(), address: addr, clock24h, hijriOffset };
      // Only a real zone is sent: '' can only mean "this form never had one", and sending it would
      // wipe a zone saved meanwhile (see the effect above).
      if (tz) patch.timeZone = tz;
      const saved = await saveMasjid(patch);
      // What the SERVER kept, not what was typed — it refuses a zone it can't format in — pushed to
      // the whole panel at once, so every date on every tab re-renders in the new settings. The
      // country decides the locale ("30 Sept 2026" for GB, "Sep 30, 2026" for US).
      setClock({
        timeZone: saved.timeZone,
        clock24h: saved.clock24h,
        hijriOffset: saved.hijriOffset,
        locale: localeForCountry(saved.address?.country ?? addr.country),
      });
      if (saved.timeZone) setTz(saved.timeZone);
      await refresh();
      setDone(true);
    } catch (e) {
      setErr(failureOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <Building2 size={16} aria-hidden="true" /> Masjid details
      </div>
      <p className="hint" style={{ marginBlockEnd: '0.7rem' }}>
        Your masjid’s name and address register your card reader’s location with Stripe. The clock settings below decide how every date is shown.
      </p>

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
            aria-describedby="mj-cc-hint"
            onChange={(e) => set('country', e.target.value.toUpperCase())}
          />
          <span className="hint" id="mj-cc-hint">Also sets how dates and amounts are written.</span>
        </div>
      </div>

      <div className="pay-group-title" style={{ marginBlockStart: '0.4rem' }}>
        <CalendarClock size={16} aria-hidden="true" /> Dates and times
      </div>

      <div className="field">
        <label className="label" htmlFor="mj-tz">Time zone</label>
        <select
          id="mj-tz"
          ref={tzRef}
          className="input"
          value={tz}
          aria-describedby="mj-tz-hint"
          onChange={(e) => {
            setTz(e.target.value);
            setDone(false);
          }}
        >
          {/* Only while nothing is set yet, and not choosable: an empty zone is never saved. */}
          {!tz && (
            <option value="" disabled>
              Choose a time zone…
            </option>
          )}
          {zones.map((z) => (
            <option key={z} value={z}>{zoneLabel(z)}</option>
          ))}
        </select>
        {here && here !== tz && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              setTz(here);
              setDone(false);
              // This button disappears once its zone is chosen, which would drop focus to the page;
              // the picker now showing that zone is where a keyboard user expects to be.
              tzRef.current?.focus();
            }}
          >
            Use this computer’s time zone ({zoneLabel(here)})
          </button>
        )}
        <p className="hint" id="mj-tz-hint">
          Every date on this panel, on donors’ receipts and in the donations CSV is shown in this time zone — the masjid’s own, not the time zone of whichever computer you’re using.
        </p>
      </div>

      <div className="field">
        <span className="label" id="mj-clock-label">Clock</span>
        {/* Two pressed/not-pressed buttons in a group rather than a tablist: there is no panel to
            switch between, so the tab keyboard model would promise something that isn't there. */}
        <div className="seg" role="group" aria-labelledby="mj-clock-label" style={{ marginBlockEnd: 0, alignSelf: 'flex-start' }}>
          {[false, true].map((h24) => (
            <button
              key={h24 ? '24' : '12'}
              type="button"
              className={`seg__opt${clock24h === h24 ? ' seg__opt--on' : ''}`}
              aria-pressed={clock24h === h24}
              onClick={() => {
                setClock24h(h24);
                setDone(false);
              }}
            >
              {/* One flex item: loose text beside the span would swap round under dir=rtl. */}
              <span>
                {h24 ? '24-hour' : '12-hour'} <span dir="ltr">{formatTime(now, { ...draft, clock24h: h24 })}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="mj-hijri">Hijri date adjustment</label>
        <select
          id="mj-hijri"
          className="input"
          value={hijriOffset}
          aria-describedby="mj-hijri-hint"
          onChange={(e) => {
            setHijriOffset(Number(e.target.value));
            setDone(false);
          }}
        >
          {HIJRI_OFFSETS.map((n) => (
            <option key={n} value={n}>{offsetLabel(n)}</option>
          ))}
        </select>
        <p className="hint" id="mj-hijri-hint">
          {hijriToday ? `Today is ${hijriToday}. ` : ''}Move it a day or two if your masjid follows a local moon sighting.
        </p>
      </div>

      <p className="hint" style={{ marginBlockEnd: '0.8rem' }}>
        Dates will look like this: <span className="muted">{formatDateTime(now, draft)}</span>
      </p>

      <FailureLine failure={err} />
      <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
        <button className="btn btn--primary btn--sm" onClick={() => void save()} aria-disabled={busy || undefined}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
        <SavedNote show={done} />
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
  const [err, setErr] = useState<Failure>(null);
  const [existing, setExisting] = useState<TerminalLocation[] | null>(null);
  const [pick, setPick] = useState('');

  const create = async () => {
    if (busy !== null || !canCreate) return;
    setErr(null);
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
      setErr(failureOf(e));
    } finally {
      setBusy(null);
    }
  };

  const loadExisting = async () => {
    if (busy !== null) return;
    setErr(null);
    setBusy('list');
    try {
      setExisting((await listLocations()).locations);
    } catch (e) {
      setErr(failureOf(e));
    } finally {
      setBusy(null);
    }
  };

  const choose = async (id: string) => {
    if (busy !== null) return;
    setPick(id);
    if (!id) return;
    setErr(null);
    setBusy('choose');
    try {
      await chooseLocation(id);
      await refresh();
    } catch (e) {
      setErr(failureOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <MapPin size={16} aria-hidden="true" /> Card reader location
      </div>
      <p className="hint" style={{ marginBlockEnd: '0.7rem' }}>
        Stripe groups your readers by location. Create one from your masjid details, or pick an existing one.
      </p>

      {status.location ? (
        <p className="status-pill status-pill--ok" style={{ marginBlockEnd: '0.7rem' }}>
          <MapPin size={13} aria-hidden="true" /> Using: {status.location.name}
        </p>
      ) : (
        <p className="status-pill" style={{ marginBlockEnd: '0.7rem' }}>No location set yet</p>
      )}

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
        {/* `disabled` only for the standing reason (no address yet), which the hint below explains;
            while a request runs it is aria-disabled so the button pressed keeps focus. */}
        <button
          className="btn btn--primary btn--sm"
          onClick={() => void create()}
          disabled={!canCreate}
          aria-disabled={busy !== null || undefined}
        >
          {busy === 'create' ? 'Creating…' : 'Create location'}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => void loadExisting()} aria-disabled={busy !== null || undefined}>
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
              aria-disabled={busy === 'choose' || undefined}
              onChange={(e) => void choose(e.target.value)}
            >
              <option value="">Select a location…</option>
              {existing.map((l) => (
                <option key={l.id} value={l.id}>{l.displayName}{l.address ? ` — ${l.address}` : ''}</option>
              ))}
            </select>
          ) : (
            <p className="hint">No locations found in this Stripe account yet. Press Create location instead.</p>
          )}
        </div>
      )}
      <FailureLine failure={err} />
    </div>
  );
}

/** A one-tap probe that proves Stripe + Terminal work by minting a connection token. */
function TestConnection() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TestPaymentsResult | null>(null);
  const [err, setErr] = useState<Failure>(null);

  const run = async () => {
    if (busy) return;
    setErr(null);
    setRes(null);
    setBusy(true);
    try {
      setRes(await testPayments());
    } catch (e) {
      setErr(failureOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-group">
      <div className="pay-group-title">
        <PlugZap size={16} aria-hidden="true" /> Test connection
      </div>
      <p className="hint" style={{ marginBlockEnd: '0.7rem' }}>
        Checks that Stripe accepts your account and that your card reader will be able to connect.
      </p>
      <button className="btn btn--ghost btn--sm" onClick={() => void run()} aria-disabled={busy || undefined}>
        {busy ? (
          <>
            <Loader2 size={15} className="spin" aria-hidden="true" /> Checking…
          </>
        ) : (
          <>
            <PlugZap size={15} aria-hidden="true" /> Test connection
          </>
        )}
      </button>
      {res && (
        <ResultLine ok={res.ok}>
          {res.ok
            ? `Connected to Stripe${modeSuffix(res.mode)} — your reader can pair.`
            : res.message || 'Couldn’t reach Stripe. Check your keys and try again.'}
        </ResultLine>
      )}
      <FailureLine failure={err} />
    </div>
  );
}

/** The Payments card for the Settings tab: loads status once, then renders the setup
 *  groups. Sub-sections that return a fresh status update it directly; those that don't
 *  refetch via `load`. */
export function PaymentsSection() {
  const [status, setStatus] = useState<PaymentsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<Failure>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getPayments());
      setErr(null);
    } catch (e) {
      setErr(failureOf(e));
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
          </div>
        </div>
        {/* Shaped like the account picker, the currency and the first address fields. */}
        <Skeleton rows={4} height="2.3rem" label="Loading your Stripe setup…" widths={['100%', '60%', '100%', '100%']} />
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
        <FailureLine failure={err} />
        <button
          className="btn btn--ghost btn--sm"
          style={{ marginBlockStart: '0.6rem' }}
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
