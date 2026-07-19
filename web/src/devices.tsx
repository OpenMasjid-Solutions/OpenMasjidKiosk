// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Devices (fleet) screen for the admin panel. A volunteer pairs a tablet by generating
 *  a short code, then sees each kiosk's live status (online, battery, reader, app version),
 *  renames or removes them, flashes one to spot it, reads its recent activity, and sets the
 *  PIN staff use to leave the giving screen. Polls every ~10s. Every call fails soft to a
 *  friendly inline message — the page never crashes. Matches the admin design language
 *  (glass cards, tokens, RTL-safe logical spacing, reduced-motion respected). */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  Copy,
  Globe,
  Loader2,
  Lock,
  MonitorSmartphone,
  Pencil,
  Plus,
  ScrollText,
  Smartphone,
  Trash2,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import {
  createPairCode,
  getAppInfo,
  getCampaigns,
  getDeviceLogs,
  getDevices,
  getRemoteInfo,
  identifyDevice,
  renameDevice,
  revokeDevice,
  setDeviceOrientation,
  setRemoteAdoption,
  type DeviceOrientation,
  setKioskPin,
  type Campaign,
  type Device,
  type DeviceLog,
  type PairCode,
  type RemoteInfo,
} from './api';
import { withBase } from './base';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

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


/** Turn a raw reader status into plain words, but keep anything we don't recognise. */
function readerLabel(s: string): string {
  const map: Record<string, string> = {
    connected: 'connected',
    ready: 'ready',
    connecting: 'connecting…',
    disconnected: 'not connected',
    offline: 'not connected',
    none: 'not set up',
    '': 'not set up',
  };
  return map[s.toLowerCase()] ?? s;
}

/** A monospace address box with a Copy button — the exact URL a volunteer types on the tablet. */
function CopyableAddress({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the address is still shown, so it can be typed by hand */
    }
  };
  return (
    <div className="server-addr">
      <code className="server-addr__url">{url}</code>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()} title="Copy the server address">
        {copied ? (
          <>
            <CheckCircle2 size={14} /> Copied
          </>
        ) : (
          <>
            <Copy size={14} /> Copy
          </>
        )}
      </button>
    </div>
  );
}

/** The LAN server address a volunteer types into the kiosk app — simply this admin page's own origin
 *  (the OpenMasjidOS address the browser is already on), with a nudge if it's localhost (which a tablet
 *  can't reach). */
function ServerAddress() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const port = typeof window !== 'undefined' ? window.location.port : '';
  const isLocal = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(host);
  return (
    <div className="field" style={{ marginBlockEnd: '0.9rem' }}>
      <span className="label">Server address <span className="faint">(type this on the tablet)</span></span>
      <CopyableAddress url={origin} />
      {isLocal ? (
        <p className="note-amber">
          You're viewing this on <strong>{host}</strong>, which a tablet can't reach. On the tablet, use your
          server's network address instead — for example <code>https://192.168.1.50{port ? `:${port}` : ''}</code>.
        </p>
      ) : (
        <p className="hint">
          This is your OpenMasjidOS address — type it on the tablet exactly, including <code>https://</code>.
        </p>
      )}
    </div>
  );
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

      <div className="seg" role="tablist" aria-label="Where is the tablet?">
        <button
          role="tab"
          aria-selected={mode === 'local'}
          className={`seg__opt${mode === 'local' ? ' seg__opt--on' : ''}`}
          onClick={() => setMode('local')}
        >
          <Wifi size={15} /> On this network
        </button>
        <button
          role="tab"
          aria-selected={mode === 'remote'}
          className={`seg__opt${mode === 'remote' ? ' seg__opt--on' : ''}`}
          onClick={() => setMode('remote')}
        >
          <Globe size={15} /> Remote (another site)
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
    setErr('');
    setBusy(true);
    try {
      setPair(await createPairCode());
    } catch (e) {
      setErr(errMsg(e));
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
      <ServerAddress />
      {pair ? (
        <PairCodeDisplay pair={pair} onNew={() => void generate()} busy={busy} />
      ) : (
        <button className="btn btn--primary" onClick={() => void generate()} disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={16} className="spin" /> Preparing…
            </>
          ) : (
            <>
              <Plus size={16} /> Add kiosk
            </>
          )}
        </button>
      )}
      {err && <p className="form-error" style={{ marginBlockStart: '0.6rem' }}>{err}</p>}
    </>
  );
}

/** Pair a tablet at ANOTHER site over the OpenMasjidOS Cloudflare tunnel. Needs remote access on
 *  (OpenMasjidOS → Settings) AND the admin's opt-in "Allow remote adoption" here. */
function RemoteAdopt() {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [pair, setPair] = useState<PairCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setInfo(await getRemoteInfo());
      setLoadErr('');
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (on: boolean) => {
    setSaving(true);
    setErr('');
    try {
      await setRemoteAdoption(on);
      if (!on) setPair(null);
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };
  const generate = async () => {
    setErr('');
    setBusy(true);
    try {
      setPair(await createPairCode());
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!info) {
    return loadErr ? (
      <p className="hint">We couldn't check remote access just now — trying again shortly.</p>
    ) : (
      <p className="muted">Loading…</p>
    );
  }

  if (!info.available) {
    return (
      <div className="empty-state">
        <div className="empty-emblem" aria-hidden="true">
          <Globe size={26} />
        </div>
        <p className="empty-title">Remote access isn't on yet</p>
        <p className="muted" style={{ maxWidth: '32rem', lineHeight: 1.55 }}>
          To adopt a tablet at another site, first turn on <strong>Remote access</strong> in{' '}
          <strong>OpenMasjidOS → Settings</strong> (a Cloudflare tunnel), and make sure{' '}
          <strong>OpenMasjid Kiosk</strong> is exposed there. Then come back — the tablet's internet address
          will appear here.
        </p>
      </div>
    );
  }

  return (
    <>
      <label className="toggle-row">
        <span className="toggle-text">
          <span className="toggle-label">Allow remote adoption</span>
          <span className="hint">
            Off keeps the internet address inactive. Turn it on to let a tablet at another site pair over your
            Cloudflare tunnel — only the setup page and the device connection are exposed; your admin panel
            stays on your own network.
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={info.allowAdoption}
          aria-label="Allow remote adoption"
          disabled={saving}
          className={`switch${info.allowAdoption ? ' switch--on' : ''}`}
          onClick={() => void toggle(!info.allowAdoption)}
        >
          <span className="switch-knob" />
        </button>
      </label>

      {info.allowAdoption && (
        <>
          <p className="muted" style={{ lineHeight: 1.55, marginBlock: '0.9rem' }}>
            On the tablet, first install the app from <code>{info.publicUrl}/new</code>, then enter this{' '}
            <strong>server address</strong> and a <strong>pairing code</strong>:
          </p>
          <div className="field" style={{ marginBlockEnd: '0.9rem' }}>
            <span className="label">Server address <span className="faint">(type this on the tablet)</span></span>
            <CopyableAddress url={info.publicUrl} />
            <p className="hint">
              Your kiosk's public address over your Cloudflare tunnel — it works from anywhere with internet,
              with no certificate warning to accept (unlike a local address).
            </p>
          </div>
          {pair ? (
            <PairCodeDisplay pair={pair} onNew={() => void generate()} busy={busy} />
          ) : (
            <button className="btn btn--primary" onClick={() => void generate()} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={16} className="spin" /> Preparing…
                </>
              ) : (
                <>
                  <Plus size={16} /> Add remote kiosk
                </>
              )}
            </button>
          )}
        </>
      )}
      {err && <p className="form-error" style={{ marginBlockStart: '0.6rem' }}>{err}</p>}
    </>
  );
}

/** The big 6-digit code with a live mm:ss countdown to its expiry. */
function PairCodeDisplay({ pair, onNew, busy }: { pair: PairCode; onNew: () => void; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const remaining = Math.max(0, pair.expiresAt - now);
  const expired = remaining <= 0;
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);
  const clock = `${mm}:${ss.toString().padStart(2, '0')}`;

  return (
    <div className="pair-box">
      <span className="label">Pairing code</span>
      <span className="pair-code" aria-label={`Pairing code ${pair.code.split('').join(' ')}`}>
        {pair.code}
      </span>
      {expired ? (
        <>
          <p className="hint">This code has expired. Make a new one to try again.</p>
          <button className="btn btn--primary btn--sm" onClick={onNew} disabled={busy}>
            {busy ? 'Preparing…' : 'New code'}
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
function DeviceList({ devices, campaigns, serverVersion, onChange }: { devices: Device[]; campaigns: Campaign[]; serverVersion: string; onChange: () => void }) {
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
        <DeviceRow key={d.id} device={d} campaigns={campaigns} serverVersion={serverVersion} onChange={onChange} />
      ))}
    </div>
  );
}

function DeviceRow({ device, campaigns, serverVersion, onChange }: { device: Device; campaigns: Campaign[]; serverVersion: string; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [savingName, setSavingName] = useState(false);
  const [busy, setBusy] = useState<'identify' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showUpdateHelp, setShowUpdateHelp] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const outOfDate = !!serverVersion && !!device.appVersion && device.appVersion !== serverVersion;
  const shown = campaignsForDevice(campaigns, device.id);

  const cancelEdit = () => {
    setEditing(false);
    setName(device.name);
  };

  const saveName = async () => {
    const next = name.trim();
    if (!next || next === device.name) return cancelEdit();
    setErr('');
    setSavingName(true);
    try {
      await renameDevice(device.id, next);
      setEditing(false);
      onChange();
    } catch (e) {
      setErr(errMsg(e));
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
      setErr(errMsg(e));
    }
  };

  const identify = async () => {
    setErr('');
    setNote('');
    setBusy('identify');
    try {
      await identifyDevice(device.id);
      setNote('The kiosk will flash so you can spot it.');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setErr('');
    setBusy('remove');
    try {
      await revokeDevice(device.id);
      onChange(); // this row unmounts on the refreshed list
    } catch (e) {
      setErr(errMsg(e));
      setBusy(null);
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
              <button className="btn btn--primary btn--sm" onClick={() => void saveName()} disabled={savingName}>
                {savingName ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={cancelEdit} disabled={savingName}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="device-name" onClick={() => setEditing(true)} title="Rename this kiosk">
              {device.name || 'Unnamed kiosk'} <Pencil size={13} aria-hidden="true" />
            </button>
          )}
          <span className="device-sub muted">
            {device.online ? 'Online' : `Offline · last seen ${relativeTime(device.lastSeen)}`} · paired{' '}
            {relativeTime(device.createdAt)}
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
        {outOfDate && (
          <button
            type="button"
            className="status-pill device-warn"
            onClick={() => setShowUpdateHelp((v) => !v)}
            title={`Latest is v${serverVersion}. Click for how to update this kiosk.`}
          >
            <span className="status-dot status-dot--warn" /> Update available (v{serverVersion})
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
              <span className="camp-pill__dot" style={{ background: c.accentColor || 'var(--color-primary)' }} aria-hidden="true" />
              {c.title || 'Untitled campaign'}
              {c.isMain && <span className="camp-pill__main"> · main</span>}
            </span>
          ))
        )}
      </div>

      <div className="device-actions">
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => void identify()}
          disabled={busy !== null || !device.online}
          title={device.online ? 'Flash this kiosk so you can find it' : 'Only works while the kiosk is online'}
        >
          <Zap size={14} aria-hidden="true" /> Identify
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setShowLogs(true)}>
          <ScrollText size={14} aria-hidden="true" /> Logs
        </button>
        {confirming ? (
          <>
            <button className="btn btn--sm device-danger" onClick={() => void remove()} disabled={busy === 'remove'}>
              {busy === 'remove' ? 'Removing…' : 'Confirm remove'}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)} disabled={busy === 'remove'}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn--ghost btn--sm device-remove-btn" onClick={() => setConfirming(true)}>
            <Trash2 size={14} aria-hidden="true" /> Remove
          </button>
        )}
      </div>

      {confirming && (
        <p className="hint">
          Removing unlinks this kiosk — the tablet returns to its pairing screen until you add it again.
        </p>
      )}

      {outOfDate && showUpdateHelp && (
        <div className="update-help">
          <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>
            This kiosk is on <strong>v{device.appVersion}</strong>; the latest is <strong>v{serverVersion}</strong>. Android
            won't let the app update itself, so update it <strong>at the tablet</strong>:
          </p>
          <ol className="update-steps">
            <li>On the tablet, tap the giving screen <strong>7 times quickly</strong>, then enter the kiosk PIN.</li>
            <li>Tap <strong>Update app</strong>. The kiosk leaves kiosk mode and opens the new app in its browser.</li>
            <li>Tap through any security notice for your server and let it download, then open the file and tap <strong>Install</strong> (allow installs from the browser if asked).</li>
            <li>The kiosk relaunches on the new version automatically.</li>
          </ol>
        </div>
      )}

      {note && (
        <p className="status-pill status-pill--ok" style={{ marginBlockStart: '0.2rem' }}>
          <Zap size={13} aria-hidden="true" /> {note}
        </p>
      )}
      {err && <p className="form-error" style={{ marginBlockStart: '0.4rem' }}>{err}</p>}

      {showLogs && <LogsModal device={device} onClose={() => setShowLogs(false)} />}
    </div>
  );
}

/** A modal showing a kiosk's recent activity, newest first, colour-coded by level. */
function LogsModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const [logs, setLogs] = useState<DeviceLog[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    getDeviceLogs(device.id)
      .then((r) => alive && setLogs(r.logs))
      .catch((e) => alive && setErr(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [device.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Draggable window: the title bar (traffic lights) is the drag handle; we translate the window
  // from its centred position. Pointer capture keeps the drag going outside the bar.
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
  const onDragEnd = () => { dragRef.current = null; };

  const sorted = logs ? [...logs].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)) : null;

  // Render into <body> via a portal: the modal is position:fixed, but an ancestor panel uses
  // backdrop-filter, which makes "fixed" resolve against that panel instead of the viewport — so
  // the scrim didn't cover the page and the window overlapped the cards/PIN behind it. A portal
  // escapes those containing blocks so the backdrop truly covers everything.
  return createPortal(
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={`Activity for ${device.name || 'kiosk'}`}
      onClick={onClose}
    >
      <div
        className="modal modal--window glass-raised"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tl-bar" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd}>
          <button
            className="tl tl--red"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close"
          >
            <X size={9} strokeWidth={3} />
          </button>
          <span className="tl tl--amber" aria-hidden="true" />
        </div>
        <div className="modal-head">
          <div className="card-head__main">
            <h3 className="section-title-inline">{device.name || 'Kiosk'} — activity</h3>
            <p className="muted">Recent events from this kiosk, newest first.</p>
          </div>
        </div>
        <div className="modal-body">
          {err && <p className="form-error">{err}</p>}
          {!logs && !err && <p className="muted">Loading…</p>}
          {sorted && sorted.length === 0 && <p className="muted">No activity recorded yet.</p>}
          {sorted && sorted.length > 0 && (
            <ul className="log-list">
              {sorted.map((l, i) => (
                <li key={i} className={`log-item log-item--${l.level}`}>
                  <span className="log-dot" aria-hidden="true" />
                  <div className="log-body">
                    <div className="log-top">
                      <span className="log-event">{l.event}</span>
                      <span className="log-time faint">{relativeTime(l.ts)}</span>
                    </div>
                    {l.detail && <p className="log-detail muted">{l.detail}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Kiosk exit PIN ──────────────────────────────────────────────────────────────
function PinCard() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<'' | 'set' | 'cleared'>('');

  const save = async () => {
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
      setErr(errMsg(e));
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
      <p className="hint" style={{ marginBlockEnd: '0.8rem', lineHeight: 1.55 }}>
        This PIN syncs to every kiosk and is checked on the tablet — even when it's offline. Choose 4 to 8 digits, or leave
        it blank to remove it.
      </p>
      <div className="field">
        <label className="label" htmlFor="kiosk-pin">
          New PIN
        </label>
        <input
          id="kiosk-pin"
          className="input pin-input"
          value={pin}
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          placeholder="4–8 digits"
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
      </div>
      {err && <p className="form-error">{err}</p>}
      <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save PIN'}
        </button>
        {done === 'set' && (
          <span className="status-pill status-pill--ok">
            <CheckCircle2 size={14} /> PIN saved
          </span>
        )}
        {done === 'cleared' && <span className="status-pill">PIN removed</span>}
      </div>
    </section>
  );
}

// ── The Devices screen ──────────────────────────────────────────────────────────
export function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [serverVersion, setServerVersion] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    getAppInfo().then((a) => alive && setServerVersion(a.version)).catch(() => {});
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await getDevices();
      setDevices(r.devices);
      setErr('');
      // Campaigns feed the "what each kiosk is showing" list — best-effort, never block the fleet view.
      try {
        setCampaigns((await getCampaigns()).campaigns);
      } catch {
        /* keep the last known campaigns */
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll every 10s so a kiosk going offline (server marks it after ~35s) shows here promptly.
    const iv = setInterval(() => void load(), 10_000);
    return () => clearInterval(iv);
  }, [load]);

  return (
    <>
      <AddKiosk />

      <section className="glass panel">
        <div className="card-head">
          <MonitorSmartphone size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Your kiosks</h2>
            <p className="muted">The tablets running your giving screen.</p>
          </div>
        </div>

        {devices === null ? (
          err ? (
            <p className="hint">We couldn't load your kiosks just now — trying again shortly.</p>
          ) : (
            <p className="muted">Loading…</p>
          )
        ) : (
          <>
            {err && <p className="hint">Couldn't refresh just now — showing the last known status.</p>}
            <DeviceList devices={devices} campaigns={campaigns} serverVersion={serverVersion} onChange={() => void load()} />
          </>
        )}
      </section>

      <PinCard />
    </>
  );
}
