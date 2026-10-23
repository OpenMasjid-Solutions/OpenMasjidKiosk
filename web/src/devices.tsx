// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Devices (fleet) screen for the admin panel. A volunteer pairs a tablet by generating
 *  a short code, then sees each kiosk's live status (online, reader, app version),
 *  renames or removes them, flashes one to spot it, reads its recent activity, and sets the
 *  PIN staff use to leave the giving screen. Polls every ~10s. Every call fails soft to a
 *  friendly inline message — the page never crashes. Matches the admin design language
 *  (glass cards, tokens, RTL-safe logical spacing, reduced-motion respected).
 *
 *  The server address box lives in serverAddress.tsx, because the public /new page shows it too
 *  and must not load this whole screen to do so. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Globe,
  Loader2,
  Lock,
  MonitorSmartphone,
  OctagonAlert,
  Pencil,
  Plus,
  ScrollText,
  Smartphone,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import {
  createPairCode,
  errorText,
  getAppInfo,
  getCampaigns,
  getDeviceLogs,
  getDevices,
  getRemoteInfo,
  identifyDevice,
  renameDevice,
  revokeDevice,
  setDeviceOrientation,
  setDeviceNfcSide,
  setRemoteAdoption,
  type DeviceOrientation,
  type DeviceNfcSide,
  setKioskPin,
  type Campaign,
  type Device,
  type DeviceLog,
  type PairCode,
  type RemoteInfo,
} from './api';
import { BASE, withBase } from './base';
import { DEFAULT_CAMPAIGN_ACCENT } from './contrast';
import { formatDate, formatDateTime, relativeTime } from './dates';
import { Modal } from './modal';
import { CopyableAddress, ServerAddress } from './serverAddress';
import { figures, ResultLine, Skeleton, Toggle, useClock } from './ui';

/** Which campaigns a given kiosk is currently showing — mirrors the server's getKioskConfig filter: the
 *  main campaign always shows; others show when live AND targeted at all kiosks ([]) or this device. */
function campaignsForDevice(campaigns: Campaign[], deviceId: string): Campaign[] {
  return campaigns.filter(
    (c) => (c.live || c.isMain) && (c.isMain || c.deviceIds.length === 0 || c.deviceIds.includes(deviceId)),
  );
}

/** Client-side hop to the public /new setup page (same pattern as App.tsx's navigate). */
function goNew(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  history.pushState(null, '', withBase('/new'));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Turn a raw reader status into plain words, but keep anything we don't recognize — with its
 *  underscores taken out, so a status a newer tablet adds still reads as words, not as an id.
 *
 *  The keys are every value the tablet actually sends (ReaderManager.statusForHeartbeat: connected,
 *  connecting, discovering, updating, error, not_connected), plus the older spellings a kiosk still on
 *  a previous version may report. This map used to know only the older ones, so the commonest idle
 *  state of all read "Reader: not_connected". server/src/commands.ts readerWords answers the same
 *  question for WhatsApp in its own shorter form; a status added here belongs there too. */
function readerLabel(s: string): string {
  const map: Record<string, string> = {
    connected: 'connected',
    ready: 'ready',
    connecting: 'connecting…',
    discovering: 'looking for it…',
    updating: 'updating — keep it charged',
    error: 'has a problem — check it at the tablet',
    not_connected: 'not connected',
    disconnected: 'not connected',
    offline: 'not connected',
    none: 'not set up',
    '': 'not set up',
  };
  const key = (s || '').toLowerCase();
  return own(map, key) ? map[key] : s.replace(/_/g, ' ');
}

/** A key of THIS table, not of every object: the status and event strings come from the tablet, and
 *  a plain `map[s]` hands back Object.prototype for "__proto__" — an object React refuses to render,
 *  which would take the whole Devices page down with it. */
const own = (map: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(map, key);

/**
 * What a kiosk's activity-log events mean, in words (spec §9). The events are ids — the tablet's
 * `repo.log(level, event, detail)` calls, plus the few the server writes itself (index.ts addLogs) —
 * and `donation_collect_failed` is written for a developer, not for a trustee trying to work out why
 * the foyer kiosk had a bad Friday. The id is not thrown away: it sits under "Technical details" with
 * the raw detail, which is exactly where someone helping over the phone will ask them to look.
 *
 * An event not listed here (a newer tablet, say) falls back to its id with the underscores taken
 * out, rather than to nothing.
 */
const EVENT_WORDS: Record<string, string> = {
  // Pairing and the kiosk itself
  paired: 'Paired with this server',
  pair_rejected: 'Pairing code wasn’t accepted',
  pair_cert: 'Couldn’t pair — the secure connection didn’t check out',
  revoked: 'Removed from this server',
  kiosk_unlocked: 'Staff unlocked the kiosk',
  pin_failed: 'Wrong exit PIN entered',
  app_update_requested: 'App update started at the tablet',
  app_update_download_failed: 'App update didn’t download',
  // The card reader
  reader_scan: 'Looking for a card reader',
  reader_scan_start: 'Looking for a card reader',
  reader_scan_failed: 'Couldn’t look for a card reader',
  reader_found: 'Found a card reader',
  reader_connect: 'Connecting to a card reader',
  reader_connect_start: 'Connecting to the card reader',
  reader_auto_connect: 'Reconnecting to the card reader',
  reader_connect_retry: 'Trying the card reader again',
  reader_connected: 'Card reader connected',
  reader_connect_failed: 'Card reader wouldn’t connect',
  reader_disconnect: 'Staff disconnected the card reader',
  reader_disconnected: 'Card reader disconnected',
  reader_health_stale: 'Card reader stopped answering — reconnecting',
  reader_no_permission: 'Card reader needs a permission on the tablet',
  reader_low_battery: 'Card reader battery is low',
  reader_token_ok: 'Card reader ready to take payments',
  reader_token_failed: 'Card reader couldn’t get ready to take payments',
  reader_reregister: 'Moving the card reader to another Stripe account',
  reader_reregister_failed: 'Couldn’t move the card reader to another Stripe account',
  reader_account_switch_failed: 'Card reader couldn’t switch Stripe account — the card was typed instead',
  reader_update_available: 'Card reader update available',
  reader_update_install: 'Card reader update started',
  reader_update_installing: 'Card reader updating — keep it charged',
  reader_update_finished: 'Card reader update finished',
  // Donations
  donation_started: 'Donation started',
  donation_succeeded: 'Donation received',
  donation_create_failed: 'Couldn’t start a donation',
  donation_collect_failed: 'Card wasn’t read',
  donation_manual_failed: 'Typed card didn’t go through',
  donation_not_succeeded: 'Donation didn’t go through',
  payment_create_failed: 'Stripe wouldn’t start a payment',
  complete_failed: 'Couldn’t confirm a payment with Stripe',
  // Monthly plans (written by the server)
  monthly_customer_failed: 'Couldn’t save the donor’s details for a monthly plan',
  monthly_intent_rejected: 'Stripe refused a monthly plan — the gift was taken once instead',
  monthly_setup_failed: 'Monthly plan wasn’t set up',
  plan_record_failed: 'Monthly plan started at Stripe but wasn’t saved here',
  // Tuition
  tuition_started: 'Tuition payment started',
  tuition_succeeded: 'Tuition payment received',
  tuition_fee_quoted: 'Card fee shown for a tuition payment',
  tuition_fee_declined: 'Tuition payment stopped at the card fee',
  tuition_create_failed: 'Couldn’t start a tuition payment',
  tuition_collect_failed: 'Tuition payment: card wasn’t read',
  tuition_not_succeeded: 'Tuition payment didn’t go through',
  tuition_pi_failed: 'Stripe wouldn’t start a tuition payment',
};

function eventWords(event: string, level: DeviceLog['level']): string {
  // The one event whose meaning turns on its level: the tablet logs the end of a reader update either
  // way, as an error when it failed — and "Error: … update finished" contradicts itself.
  if (event === 'reader_update_finished' && level === 'error') return 'Card reader update didn’t finish';
  if (own(EVENT_WORDS, event)) return EVENT_WORDS[event];
  const words = event.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unnamed event';
}

// ── Add a kiosk ────────────────────────────────────────────────────────────────
function AddKiosk() {
  const [mode, setMode] = useState<'local' | 'remote'>('local');
  return (
    <section className="glass panel">
      <div className="card-head">
        <Smartphone size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Add a kiosk</h2>
          <p className="muted">Link a tablet on this network, or a tablet at another site over the internet.</p>
        </div>
      </div>

      {/* Two pressed-or-not buttons, not tabs: this used to claim role="tablist", which promises
          arrow keys, a roving tab stop and a tabpanel — none of which it had (spec §7). */}
      <div className="seg" role="group" aria-label="Where is the tablet?">
        <button
          type="button"
          aria-pressed={mode === 'local'}
          className={`seg__opt${mode === 'local' ? ' seg__opt--on' : ''}`}
          onClick={() => setMode('local')}
        >
          <Wifi size={15} aria-hidden="true" /> On this network
        </button>
        <button
          type="button"
          aria-pressed={mode === 'remote'}
          className={`seg__opt${mode === 'remote' ? ' seg__opt--on' : ''}`}
          onClick={() => setMode('remote')}
        >
          <Globe size={15} aria-hidden="true" /> Remote (another site)
        </button>
      </div>

      {mode === 'local' ? <LocalAdopt /> : <RemoteAdopt />}
    </section>
  );
}

/** Pair a tablet on the SAME network: type the LAN server address + a 6-digit code. */
function LocalAdopt() {
  const [pair, setPair] = useState<PairCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const generate = async () => {
    // aria-disabled rather than disabled while busy: disabling the button a keyboard user just
    // pressed throws their focus back to the top of the page (spec §7).
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      setPair(await createPairCode());
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="muted" style={{ lineHeight: 1.55, marginBlockEnd: '0.9rem' }}>
        First install the app from the{' '}
        <a href={withBase('/new')} onClick={goNew}>
          setup page
        </a>
        . Then, on the tablet, enter your <strong>server address</strong> and a <strong>pairing code</strong>:
      </p>
      {BASE ? (
        // Opened from outside the masjid (only the tunnel serves us under a base path): this page's own
        // origin is the OpenMasjidOS dashboard's public hostname, and a tablet that typed it would pair
        // with nothing. The masjid's own address is one this browser cannot see from here.
        <div className="field" style={{ marginBlockEnd: '0.9rem' }}>
          <span className="label">Server address <span className="faint">(type this on the tablet)</span></span>
          <p className="note-amber">
            You’re managing Kiosk from outside the masjid, so this page can’t show its address on the masjid’s
            network. On the tablet, type the <code dir="ltr">https://</code> address you open Kiosk at when you’re at
            the masjid — or choose <strong>Remote (another site)</strong> to pair it over the internet instead.
          </p>
        </div>
      ) : (
        <ServerAddress />
      )}
      {pair ? (
        <PairCodeDisplay pair={pair} onNew={() => void generate()} busy={busy} />
      ) : (
        <button className="btn btn--primary" onClick={() => void generate()} aria-disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={16} className="spin" aria-hidden="true" /> Preparing…
            </>
          ) : (
            <>
              <Plus size={16} aria-hidden="true" /> Add kiosk
            </>
          )}
        </button>
      )}
      {err && <ResultLine ok={false}>{err}</ResultLine>}
    </>
  );
}

/** Pair a tablet at ANOTHER site over the OpenMasjidOS Cloudflare tunnel. Needs remote access on
 *  (OpenMasjidOS → Settings) AND the admin's opt-in "Allow remote adoption" here. The admin-facing
 *  words say "over the internet" instead: "tunnel" and "adoption" are ours, not a volunteer's. */
function RemoteAdopt() {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(0);
  const [saving, setSaving] = useState(false);
  const [pair, setPair] = useState<PairCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await getRemoteInfo());
      setLoadErr('');
    } catch (e) {
      setLoadErr(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // "Try again" and "Check again" are the only retries there are — this loads once, and the words
  // used to promise "trying again shortly" with nothing behind them (spec §9: the next step you name
  // must really exist).
  const recheck = async () => {
    if (checking) return;
    setChecking(true);
    await load();
    setChecking(false);
    setChecked((n) => n + 1);
  };
  // A recheck can swap the whole stage (the error gives way to the switch, the "isn't on yet" note
  // to the address), taking the pressed button with it. Put focus on the first control of what
  // replaced it, instead of leaving it on <body> (spec §7). If the button is still there, it still
  // has focus, and this leaves it alone.
  useEffect(() => {
    if (!checked) return;
    const el = wrapRef.current;
    if (el && !el.contains(document.activeElement)) {
      el.querySelector<HTMLElement>('button, a[href], input, select')?.focus();
    }
  }, [checked]);

  const toggle = async (on: boolean) => {
    // Not disabled while saving, for the same reason as the buttons: it is the control with focus.
    if (saving) return;
    setSaving(true);
    setErr('');
    try {
      await setRemoteAdoption(on);
      if (!on) setPair(null);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const generate = async () => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      setPair(await createPairCode());
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (!info) {
    body = loadErr ? (
      <>
        <p className="hint">We couldn’t check remote access just now. {loadErr}</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void recheck()} aria-disabled={checking}>
          {checking ? 'Checking…' : 'Try again'}
        </button>
      </>
    ) : (
      <Skeleton rows={2} height="1.1rem" widths={['100%', '65%']} label="Checking remote access…" />
    );
  } else if (!info.available) {
    body = (
      <div className="empty-state">
        <div className="empty-emblem" aria-hidden="true">
          <Globe size={26} />
        </div>
        <p className="empty-title">Remote access isn't on yet</p>
        <p className="muted" style={{ maxWidth: '32rem', lineHeight: 1.55 }}>
          To pair a tablet at another site, first turn on <strong>Remote access</strong> in{' '}
          <strong>OpenMasjidOS → Settings</strong>, and switch it on for <strong>OpenMasjid Kiosk</strong> there. Then
          check again here — the internet address to type on the tablet will appear.
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void recheck()} aria-disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <Toggle
          label="Let tablets at other sites pair"
          hint={
            <>
              Off, no tablet can pair over the internet. Turn it on to let a tablet at another site pair over the
              internet. Only the setup page and the tablet connection are open to anyone there; this admin panel
              answers only to someone signed in to OpenMasjidOS from outside, and its own password works only on
              your network.
            </>
          }
          checked={info.allowAdoption}
          onChange={(v) => void toggle(v)}
        />

        {info.allowAdoption && (
          <>
            <p className="muted" style={{ lineHeight: 1.55, marginBlock: '0.9rem' }}>
              On the tablet, first install the app from <code dir="ltr">{info.publicUrl}/new</code>, then enter this{' '}
              <strong>server address</strong> and a <strong>pairing code</strong>:
            </p>
            <div className="field" style={{ marginBlockEnd: '0.9rem' }}>
              <span className="label">
                Server address <span className="faint">(type this on the tablet)</span>
              </span>
              <CopyableAddress url={info.publicUrl} />
              <p className="hint">Your kiosk’s internet address — it works from anywhere, with no certificate warning to accept.</p>
            </div>
            {pair ? (
              <PairCodeDisplay pair={pair} onNew={() => void generate()} busy={busy} />
            ) : (
              <button className="btn btn--primary" onClick={() => void generate()} aria-disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 size={16} className="spin" aria-hidden="true" /> Preparing…
                  </>
                ) : (
                  <>
                    <Plus size={16} aria-hidden="true" /> Add remote kiosk
                  </>
                )}
              </button>
            )}
          </>
        )}
        {err && <ResultLine ok={false}>{err}</ResultLine>}
      </>
    );
  }

  return <div ref={wrapRef}>{body}</div>;
}

/** The big 6-digit code with a live mm:ss countdown to its expiry. */
function PairCodeDisplay({ pair, onNew, busy }: { pair: PairCode; onNew: () => void; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  // The button that asked for this code is gone — it is replaced by the code itself, or ("Make a new
  // code") by the countdown. Move focus to the box, so a screen reader reads out the code that just
  // appeared and a keyboard user is not left at the top of the page.
  useEffect(() => {
    boxRef.current?.focus();
  }, [pair]);

  const remaining = Math.max(0, pair.expiresAt - now);
  const expired = remaining <= 0;
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);
  const clock = `${mm}:${ss.toString().padStart(2, '0')}`;

  return (
    <div className="pair-box" ref={boxRef} tabIndex={-1}>
      <span className="label">Pairing code</span>
      {/* The digits are drawn once for the eye and once, spaced, for the ear: read as a whole,
          "482913" comes out as four hundred and eighty-two thousand… Always left to right — a
          pairing code has no direction to mirror. */}
      <span className="pair-code" dir="ltr" aria-hidden="true">
        {pair.code}
      </span>
      <span className="sr-only">{pair.code.split('').join(' ')}</span>
      {/* A status that is always there (and takes no space), so the moment the code runs out is
          announced. The ticking clock below is deliberately NOT in it: a countdown read out every
          second drowns everything. */}
      <span className="sr-only" role="status">
        {expired ? 'The pairing code has expired.' : ''}
      </span>
      {expired ? (
        <>
          <p className="hint">This code has expired. Make a new one to try again.</p>
          <button className="btn btn--primary btn--sm" onClick={onNew} aria-disabled={busy}>
            {busy ? 'Preparing…' : 'Make a new code'}
          </button>
        </>
      ) : (
        <>
          <p className="muted pair-instr">Enter this pairing code on the tablet (after the server address) within 10 minutes.</p>
          <p className="hint">
            Expires in <span className="pair-clock">{clock}</span>
          </p>
        </>
      )}
    </div>
  );
}

// ── Your kiosks (the fleet) ─────────────────────────────────────────────────────
function DeviceList({
  devices,
  campaigns,
  serverVersion,
  onChange,
  onRemoved,
}: {
  devices: Device[];
  campaigns: Campaign[];
  serverVersion: string;
  onChange: () => void;
  onRemoved: (name: string) => void;
}) {
  if (!devices.length) {
    return (
      <div className="empty-state">
        <div className="empty-emblem" aria-hidden="true">
          <MonitorSmartphone size={26} />
        </div>
        <p className="empty-title">No kiosks paired yet</p>
        <p className="muted">When you pair a tablet it will show up here with its status, reader and app version.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      {devices.map((d) => (
        <DeviceRow key={d.id} device={d} campaigns={campaigns} serverVersion={serverVersion} onChange={onChange} onRemoved={onRemoved} />
      ))}
    </div>
  );
}

function DeviceRow({
  device,
  campaigns,
  serverVersion,
  onChange,
  onRemoved,
}: {
  device: Device;
  campaigns: Campaign[];
  serverVersion: string;
  onChange: () => void;
  onRemoved: (name: string) => void;
}) {
  const clock = useClock();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [savingName, setSavingName] = useState(false);
  const [busy, setBusy] = useState<'identify' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showUpdateHelp, setShowUpdateHelp] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const confirmHintId = useId();

  // Renaming and removing both swap the pressed button for another stage (a text box, a Yes/Cancel
  // pair), and swap back. Without this, focus goes down with the button that disappeared and lands
  // on <body> (spec §7). Set just before the swap back; acted on once it has rendered.
  const nameBtnRef = useRef<HTMLButtonElement>(null);
  const removeBtnRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<'name' | 'remove' | null>(null);
  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    (target === 'name' ? nameBtnRef : removeBtnRef).current?.focus();
  }, [editing, confirming]);

  const outOfDate = !!serverVersion && !!device.appVersion && device.appVersion !== serverVersion;
  const shown = campaignsForDevice(campaigns, device.id);
  const lastSeen = relativeTime(device.lastSeen);
  const pairedOn = formatDate(device.createdAt, clock);

  const cancelEdit = () => {
    refocus.current = 'name';
    setEditing(false);
    setName(device.name);
  };

  const saveName = async () => {
    if (savingName) return;
    const next = name.trim();
    if (!next || next === device.name) return cancelEdit();
    setErr('');
    setSavingName(true);
    try {
      await renameDevice(device.id, next);
      refocus.current = 'name';
      setEditing(false);
      onChange();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSavingName(false);
    }
  };

  const changeOrientation = async (orientation: DeviceOrientation) => {
    setErr('');
    try {
      await setDeviceOrientation(device.id, orientation);
      onChange();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  const changeNfcSide = async (nfcSide: DeviceNfcSide) => {
    setErr('');
    try {
      await setDeviceNfcSide(device.id, nfcSide);
      onChange();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  const identify = async () => {
    if (busy) return;
    setErr('');
    setNote('');
    setBusy('identify');
    try {
      await identifyDevice(device.id);
      // The server only raises a flag; the kiosk sees it on its next check-in (about every 10 s).
      // So this says what we did, not what the kiosk has done — nobody here watched it flash.
      setNote('Asked the kiosk to flash — it should within about 10 seconds.');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setErr('');
    setBusy('remove');
    try {
      await revokeDevice(device.id);
      onRemoved(device.name); // this row unmounts on the refreshed list
    } catch (e) {
      setErr(errorText(e));
      setBusy(null);
      refocus.current = 'remove';
      setConfirming(false);
    }
  };

  return (
    <div className="device-row glass-inset">
      <div className="device-row__head">
        <span className={`status-dot${device.online ? '' : ' status-dot--idle'}`} aria-hidden="true" />
        <div className="device-row__id">
          {editing ? (
            <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
              <input
                className="input device-name-input"
                value={name}
                autoFocus
                aria-label="Kiosk name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveName();
                  if (e.key === 'Escape') cancelEdit();
                }}
              />
              <button className="btn btn--primary btn--sm" onClick={() => void saveName()} aria-disabled={savingName}>
                {savingName ? 'Saving…' : 'Save'}
              </button>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  if (!savingName) cancelEdit();
                }}
                aria-disabled={savingName}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              ref={nameBtnRef}
              className="device-name"
              // From the name as it is NOW: renamed elsewhere since this card mounted, the box opened on
              // the old name, and pressing Enter quietly put it back.
              onClick={() => {
                setName(device.name);
                setEditing(true);
              }}
              title="Rename this kiosk"
            >
              {device.name || 'Unnamed kiosk'} <Pencil size={13} aria-hidden="true" />
            </button>
          )}
          <span className="device-sub muted">
            {device.online ? (
              'Online'
            ) : lastSeen ? (
              <>
                Offline · last seen{' '}
                <time dateTime={device.lastSeen} title={formatDateTime(device.lastSeen, clock)}>
                  {figures(lastSeen)}
                </time>
              </>
            ) : (
              'Offline'
            )}
            {pairedOn && <> · paired on {figures(pairedOn)}</>}
          </span>
        </div>
      </div>

      <div className="device-meta">
        {/* Battery / charging removed: kiosk tablets are wall-powered, so it's just noise (and many
            report "not charging" at 100% while plugged in). Reader + app version are what matter. */}
        <span className="status-pill">Reader: {readerLabel(device.readerStatus)}</span>
        <span className="status-pill">App v{device.appVersion || '—'}</span>
        <label className="device-orient" title="Rotate this kiosk's screen. Pick whichever angle looks upright on your mount.">
          Rotate screen:
          <select
            className="device-orient-select"
            value={device.orientation || '0'}
            onChange={(e) => void changeOrientation(e.target.value as DeviceOrientation)}
          >
            <option value="0">Default (0°)</option>
            <option value="90">90° ↻</option>
            <option value="180">180°</option>
            <option value="270">270° (−90°) ↺</option>
          </select>
        </label>
        {/* Left and right here are PHYSICAL — where the reader is bolted to the wall, as the donor
            faces it — so these labels and arrows deliberately do not mirror under a right-to-left
            layout. The tablet draws its hint with absolute alignment for the same reason. */}
        <label className="device-orient" title="Which side of the giving screen the card reader sits on, as the donor sees it. The kiosk points donors to it during payment — arrows march sideways for left/right, and up/down for top/bottom (usually what a portrait-mounted tablet needs).">
          Reader side:
          <select
            className="device-orient-select"
            value={device.nfcSide || 'off'}
            onChange={(e) => void changeNfcSide(e.target.value as DeviceNfcSide)}
          >
            <option value="off">No hint</option>
            <option value="left">Left ←</option>
            <option value="right">Right →</option>
            <option value="top">Top ↑</option>
            <option value="bottom">Bottom ↓</option>
          </select>
        </label>
        {outOfDate && (
          <button
            type="button"
            className="status-pill device-warn"
            onClick={() => setShowUpdateHelp((v) => !v)}
            aria-expanded={showUpdateHelp}
            title={`Latest is v${serverVersion}. Click for how to update this kiosk.`}
          >
            <span className="status-dot status-dot--warn" aria-hidden="true" /> Update available (v{serverVersion})
          </button>
        )}
      </div>

      {/* Which campaigns this kiosk is showing right now (set per-campaign in Campaigns → Kiosks). */}
      <div className="device-campaigns">
        <span className="device-campaigns__label">Showing:</span>
        {campaigns.length === 0 ? (
          <span className="faint">—</span>
        ) : shown.length === 0 ? (
          <span className="faint">No campaigns targeted at this kiosk yet</span>
        ) : (
          shown.map((c) => (
            <span key={c.id} className="camp-pill" title={c.isMain ? 'Your main campaign — always shown' : undefined}>
              {/* A campaign with no accent of its own is painted in the kiosk's default accent on the
                  tablet — not in whatever accent this admin panel happens to wear — so the dot shows
                  that one. Campaign colours are admin data, not theme. */}
              <span className="camp-pill__dot" style={{ background: c.accentColor || DEFAULT_CAMPAIGN_ACCENT }} aria-hidden="true" />
              {/* One flex item, not two: loose text beside a span in a flex box swaps round under
                  dir=rtl and the pill read "· main General Fund". */}
              <span>
                {c.title || 'Untitled campaign'}
                {c.isMain && <span className="camp-pill__main"> · main</span>}
              </span>
            </span>
          ))
        )}
      </div>

      <div className="device-actions">
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => void identify()}
          disabled={!device.online}
          aria-disabled={busy !== null}
          title={device.online ? 'Flash this kiosk so you can find it' : 'Only works while the kiosk is online'}
        >
          <Zap size={14} aria-hidden="true" /> Identify
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setShowLogs(true)}>
          <ScrollText size={14} aria-hidden="true" /> Logs
        </button>
        {confirming ? (
          <>
            <button
              className="btn btn--sm device-danger"
              onClick={() => void remove()}
              aria-disabled={busy === 'remove'}
              aria-describedby={confirmHintId}
            >
              {busy === 'remove' ? 'Removing…' : 'Yes, remove this kiosk'}
            </button>
            {/* The harmless choice takes focus, so a second press of Enter or Space backs out
                rather than removing the kiosk. */}
            <button
              className="btn btn--ghost btn--sm"
              autoFocus
              onClick={() => {
                if (busy === 'remove') return;
                refocus.current = 'remove';
                setConfirming(false);
              }}
              aria-disabled={busy === 'remove'}
            >
              Cancel
            </button>
          </>
        ) : (
          <button ref={removeBtnRef} className="btn btn--ghost btn--sm device-remove-btn" onClick={() => setConfirming(true)}>
            <Trash2 size={14} aria-hidden="true" /> Remove
          </button>
        )}
      </div>

      {confirming && (
        <p className="hint" id={confirmHintId}>
          Removing unlinks this kiosk — the tablet returns to its pairing screen until you add it again.
        </p>
      )}

      {outOfDate && showUpdateHelp && (
        <div className="update-help">
          <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>
            This kiosk is on <strong>v{device.appVersion}</strong>; the latest is <strong>v{serverVersion}</strong>. The app
            updates itself from this server — start it <strong>at the tablet</strong>:
          </p>
          <ol className="update-steps">
            <li>On the tablet, tap the giving screen <strong>10 times quickly</strong> (anywhere on the background), then enter the kiosk PIN.</li>
            <li>Tap <strong>Update app</strong>. It downloads the new version from this server and hands it straight to Android — no browser.</li>
            <li>Tap <strong>Install</strong> when Android asks. The first time, it will also ask you to allow this app to install apps; the checklist under <strong>Permissions &amp; lockdown</strong> on that same screen has a button for it.</li>
            <li>The kiosk relaunches on the new version and re-locks itself automatically.</li>
          </ol>
        </div>
      )}

      {note && (
        <ResultLine ok tone="info">
          {note}
        </ResultLine>
      )}
      {err && <ResultLine ok={false}>{err}</ResultLine>}

      {showLogs && <LogsModal device={device} onClose={() => setShowLogs(false)} />}
    </div>
  );
}

/** A window showing a kiosk's recent activity, newest first, color-coded by level — and, since colour
 *  alone says nothing to a colour-blind trustee or a screen reader, marked by shape and in words too. */
function LogsModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const clock = useClock();
  const titleId = useId();
  const headRef = useRef<HTMLHeadingElement>(null);
  const [logs, setLogs] = useState<DeviceLog[] | null>(null);
  const [err, setErr] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    getDeviceLogs(device.id)
      .then((r) => alive && setLogs(r.logs))
      .catch((e) => alive && setErr(errorText(e)));
    return () => {
      alive = false;
    };
  }, [device.id, attempt]);

  const retry = () => {
    setErr('');
    setAttempt((n) => n + 1);
    // The Try again button is about to disappear under the loading skeleton; the heading is the
    // nearest thing that stays, and it names the window focus is still inside.
    headRef.current?.focus();
  };

  // Draggable window: the title bar (traffic lights) is the drag handle; we translate the window
  // from its centered position. Pointer capture keeps the drag going outside the bar.
  //
  // Through the CSS `translate` property, NOT `transform`. Every dialog plays the `enter` entrance,
  // which animates `transform` with fill-mode both and ends on `transform: none` — and an animation's
  // value outranks an inline style. A `transform: translate(…)` here would be pinned at none the
  // moment the entrance finished, and the window would stop following the pointer for anyone who has
  // not asked for reduced motion (the one case where it would seem to work). `translate` is a separate
  // property the entrance never touches, and it composes with it. Physical x/y on purpose: it follows
  // the pointer, which does not mirror in right-to-left.
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const onDragStart = (e: ReactPointerEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({ x: d.bx + (e.clientX - d.sx), y: d.by + (e.clientY - d.sy) });
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  const sorted = logs ? [...logs].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)) : null;

  // The shared <Modal> is a native <dialog> in the browser's top layer: it traps focus, closes on
  // Escape and on a backdrop click, and puts focus back on the Logs button that opened it. The top
  // layer is also why the portal this used to need (to escape a panel's backdrop-filter) is gone.
  return (
    <Modal
      titleId={titleId}
      onClose={onClose}
      className="modal--window modal--drag"
      style={{ translate: `${pos.x}px ${pos.y}px` }}
    >
      <div className="tl-bar" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}>
        <button
          type="button"
          className="tl tl--red"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Close"
        >
          <X size={9} strokeWidth={3} aria-hidden="true" />
        </button>
        <span className="tl tl--amber" aria-hidden="true" />
      </div>
      <div className="modal-head">
        <div className="card-head__main">
          <h3 className="section-title-inline" id={titleId} ref={headRef} tabIndex={-1}>
            {device.name || 'Kiosk'} — activity
          </h3>
          <p className="muted">Recent events from this kiosk, newest first.</p>
        </div>
      </div>
      <div className="modal-body">
        {err && (
          <>
            <ResultLine ok={false}>We couldn’t load this kiosk’s activity. {err}</ResultLine>
            <button type="button" className="btn btn--ghost btn--sm" style={{ marginBlockStart: '0.6rem' }} onClick={retry}>
              Try again
            </button>
          </>
        )}
        {!logs && !err && <Skeleton rows={5} height="2.4rem" label="Loading this kiosk’s activity…" />}
        {sorted && sorted.length === 0 && <p className="muted">No activity recorded yet.</p>}
        {sorted && sorted.length > 0 && (
          <ul className="log-list">
            {sorted.map((l, i) => (
              <li key={i} className={`log-item log-item--${l.level}`}>
                <span className="log-dot" aria-hidden="true" />
                <div className="log-body">
                  <div className="log-top">
                    <span className="log-event">
                      {/* Level by shape as well as colour — an octagon for an error, a triangle for a
                          warning — and in words for a screen reader (WCAG 1.4.1). */}
                      {l.level === 'error' && <OctagonAlert size={13} aria-hidden="true" />}
                      {l.level === 'warn' && <TriangleAlert size={13} aria-hidden="true" />}
                      {l.level !== 'info' && <span className="sr-only">{l.level === 'error' ? 'Error: ' : 'Warning: '}</span>}
                      {eventWords(l.event, l.level)}
                    </span>
                    {/* Relative, because "5 min ago" is what someone checking on a kiosk wants; the
                        exact moment, in the masjid's time and with the Hijri date, on hover. */}
                    <time className="log-time faint" dateTime={l.ts} title={formatDateTime(l.ts, clock)}>
                      {figures(relativeTime(l.ts))}
                    </time>
                  </div>
                  {l.detail && (
                    <details className="log-tech">
                      <summary>Technical details</summary>
                      <p className="log-detail muted">
                        <code>{l.event}</code>
                        <br />
                        {l.detail}
                      </p>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ── Kiosk exit PIN ──────────────────────────────────────────────────────────────
function PinCard() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<'' | 'set' | 'cleared'>('');
  const hintId = useId();

  const save = async () => {
    if (busy) return;
    setErr('');
    setDone('');
    if (pin && !/^\d{4,8}$/.test(pin)) {
      setErr('Please use 4 to 8 digits, or leave it blank to remove the PIN.');
      return;
    }
    setBusy(true);
    try {
      const res = await setKioskPin(pin);
      setDone(res.set ? 'set' : 'cleared');
      setPin('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <Lock size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Kiosk exit PIN</h2>
          <p className="muted">Staff type this PIN to leave the giving screen.</p>
        </div>
      </div>
      <p className="hint" id={hintId} style={{ marginBlockEnd: '0.8rem', lineHeight: 1.55 }}>
        This PIN syncs to every kiosk and is checked on the tablet — even when it's offline. Choose 4 to 8 digits, or leave
        it blank to remove it.
      </p>
      <div className="field">
        <label className="label" htmlFor="kiosk-pin">
          New PIN
        </label>
        {/* Digits only, so always left to right: a mirrored PIN box would fill from the wrong end. */}
        <input
          id="kiosk-pin"
          className="input pin-input"
          dir="ltr"
          value={pin}
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          placeholder="4–8 digits"
          aria-describedby={hintId}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
      </div>
      {err && <ResultLine ok={false}>{err}</ResultLine>}
      <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn btn--primary btn--sm" onClick={() => void save()} aria-disabled={busy}>
          {busy ? 'Saving…' : 'Save PIN'}
        </button>
      </div>
      {done === 'set' && <ResultLine ok>PIN saved.</ResultLine>}
      {done === 'cleared' && <ResultLine ok>PIN removed.</ResultLine>}
    </section>
  );
}

// ── The Devices screen ──────────────────────────────────────────────────────────
export function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [serverVersion, setServerVersion] = useState('');
  const [err, setErr] = useState('');
  const [announce, setAnnounce] = useState('');
  const [removed, setRemoved] = useState('');
  const headRef = useRef<HTMLHeadingElement>(null);
  // Which kiosks were online at the last successful poll — null until the first one, so the page
  // opening is never announced as a dozen kiosks "coming online".
  const seen = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    let alive = true;
    getAppInfo().then((a) => alive && setServerVersion(a.version)).catch(() => {});
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await getDevices();
      // Tell a screen-reader user what changed ON ITS OWN since the last poll: a kiosk dropping off,
      // coming back, or a tablet finishing pairing while the admin waits (spec §7 live regions).
      // Transitions only — never the list, never the "last seen" times that move on every poll —
      // and set to '' when nothing changed, so the same news next time is still a change to announce.
      const prev = seen.current;
      if (prev) {
        const news: string[] = [];
        for (const d of r.devices) {
          const was = prev.get(d.id);
          if (was === undefined) news.push(`${d.name || 'A new kiosk'} just paired.`);
          else if (was && !d.online) news.push(`${d.name || 'A kiosk'} went offline.`);
          else if (!was && d.online) news.push(`${d.name || 'A kiosk'} is back online.`);
        }
        setAnnounce(news.join(' '));
      }
      seen.current = new Map(r.devices.map((d) => [d.id, d.online]));
      setDevices(r.devices);
      setErr('');
      // Campaigns feed the "what each kiosk is showing" list — best-effort, never block the fleet view.
      try {
        setCampaigns((await getCampaigns()).campaigns);
      } catch {
        /* keep the last known campaigns */
      }
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll every 10s so a kiosk going offline (server marks it after ~35s) shows here promptly.
    const iv = setInterval(() => void load(), 10_000);
    return () => clearInterval(iv);
  }, [load]);

  // A removed kiosk's row — and the button that removed it — vanish on the refresh, so focus goes to
  // the list's heading, with the outcome said right under it.
  const onRemoved = useCallback(
    (name: string) => {
      setRemoved(name || 'The kiosk');
      void load().then(() => headRef.current?.focus());
    },
    [load],
  );

  return (
    <>
      <AddKiosk />

      <section className="glass panel" aria-busy={devices === null && !err}>
        <div className="card-head">
          <MonitorSmartphone size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline" ref={headRef} tabIndex={-1}>
              Your kiosks
            </h2>
            <p className="muted">The tablets running your giving screen.</p>
          </div>
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </p>

        {removed && (
          <ResultLine ok>
            {removed} was removed. Its tablet goes back to the pairing screen the next time it checks in.
          </ResultLine>
        )}

        {devices === null ? (
          err ? (
            <p className="hint">We couldn't load your kiosks just now — trying again shortly.</p>
          ) : (
            <Skeleton rows={3} height="5rem" label="Loading your kiosks…" />
          )
        ) : (
          <>
            {err && <p className="hint">Couldn't refresh just now — showing the last known status.</p>}
            <DeviceList
              devices={devices}
              campaigns={campaigns}
              serverVersion={serverVersion}
              onChange={() => void load()}
              onRemoved={onRemoved}
            />
          </>
        )}
      </section>

      <PinCard />
    </>
  );
}
