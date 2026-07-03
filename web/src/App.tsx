// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The admin panel shell + the public /new setup page, with a tiny hand-rolled router.
 *  The shell mirrors the OpenMasjidOS dashboard: an ambient scene with a custom-wallpaper
 *  inheritance, a top bar (brand + clock + profile menu) and a bottom dock for the four
 *  sections (Dashboard, Devices, Analytics, Settings). Auth (first-run setup / password
 *  login / SSO with a local-password fallback) gates everything but the public /new page.
 *  Devices/Payments/Donations gain real data in later slices. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Coins,
  Download,
  ExternalLink,
  LayoutDashboard,
  MonitorSmartphone,
  Palette,
  Plus,
  ReceiptText,
  Settings,
  ShieldCheck,
  Smartphone,
  TrendingUp,
} from 'lucide-react';
import { getAppInfo, getSession, login, sendTestNotification, setupAdmin, type AppInfo, type NotifyTestResult, type Session } from './api';
import { withBase, stripBase } from './base';
import { useOmosAppearanceSync, usePrefs, useReadableTheme } from './prefs';
import { Brand, Clock, Crescent, ProfileMenu, Scene } from './ui';

const SOURCE_URL = 'https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk';

/** Client-side navigation for pathname routes (the public /new page). */
function navigate(to: string) {
  history.pushState(null, '', withBase(to));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [path, setPath] = useState(() => stripBase(location.pathname));
  const [app, setApp] = useState<AppInfo | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const prefs = usePrefs();

  const reloadSession = useCallback(async () => {
    try {
      setSession(await getSession());
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    const onPop = () => setPath(stripBase(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    void Promise.allSettled([getAppInfo().then(setApp), reloadSession()]).then(() => setLoaded(true));
  }, [reloadSession]);

  // Follow the dashboard's theme/wallpaper/accent live when opened from OpenMasjidOS.
  useOmosAppearanceSync(app?.embedded);

  // On-scene text colour follows the WALLPAPER, not the light/dark toggle: preset
  // wallpapers are dark → light on-scene text in both themes; a light custom wallpaper
  // image flips data-scene to "light" so on-scene text goes dark and stays readable.
  const sceneTone = useReadableTheme(prefs.wallpaperImage.trim() || undefined, 'dark');
  useEffect(() => {
    const html = document.documentElement;
    if (sceneTone === 'light') html.setAttribute('data-scene', 'light');
    else html.removeAttribute('data-scene');
  }, [sceneTone]);

  return (
    <>
      <Scene />
      {path === '/new' ? (
        // Public tablet-setup page — no auth, no dock/profile.
        <div className="shell">
          <main className="main">
            <NewPage app={app} />
          </main>
        </div>
      ) : !loaded ? (
        <div className="shell">
          <main className="main">
            <LoadingCard />
          </main>
        </div>
      ) : !session?.authed ? (
        // Not signed in → show only the auth card (no shell chrome).
        <div className="shell">
          <main className="main">
            <Auth session={session} onDone={reloadSession} />
          </main>
        </div>
      ) : (
        <AdminShell app={app} session={session} />
      )}
    </>
  );
}

function LoadingCard() {
  return (
    <div className="wrap">
      <div className="glass-raised hero-card enter" aria-busy="true">
        <div className="emblem">
          <Crescent size={30} />
        </div>
        <p className="muted">Loading…</p>
      </div>
    </div>
  );
}

// ── Admin shell: top bar + hash-routed tabs + bottom dock ─────────────────────
type Tab = 'dashboard' | 'devices' | 'analytics' | 'settings';
const TABS: { id: Tab; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'devices', label: 'Devices', Icon: MonitorSmartphone },
  { id: 'analytics', label: 'Analytics', Icon: TrendingUp },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

/** Which tab a URL hash like "#settings" selects (defaults to dashboard). */
function tabFromHash(): Tab {
  const h = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
  return TABS.some((t) => t.id === h) ? (h as Tab) : 'dashboard';
}

function Dock({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="dock-wrap">
      <nav className="dock glass-raised" aria-label="Sections">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`nav-item${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            aria-label={label}
            title={label}
          >
            <Icon size={20} />
            <span className="nav-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function AdminShell({ app, session }: { app: AppInfo | null; session: Session }) {
  const embedded = !!app?.embedded;
  // Tab is reflected in the URL hash so the profile menu's "Settings" (→ #settings), the
  // brand mark (→ #dashboard) and refresh/back all land on the right section.
  const [tab, setTabState] = useState<Tab>(() => tabFromHash());
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setTab = (t: Tab) => {
    if (typeof location !== 'undefined') history.replaceState(null, '', `${location.pathname}#${t}`);
    setTabState(t);
  };

  const meta: Record<Tab, { title: string; sub: string }> = {
    dashboard: { title: 'Dashboard', sub: `${session.sso.username ? `Signed in as ${session.sso.username}` : 'Signed in'}${embedded ? ' · via OpenMasjidOS' : ''}` },
    devices: { title: 'Devices', sub: 'The tablets running your giving screen.' },
    analytics: { title: 'Analytics', sub: 'Donations your kiosks have taken.' },
    settings: { title: 'Settings', sub: 'Your account, platform connection and this app.' },
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <Clock />
        <ProfileMenu info={app} />
      </header>
      <main className="admin">
        <div className="page-head">
          <h1 className="page-title">{meta[tab].title}</h1>
          <p className="page-sub">{meta[tab].sub}</p>
        </div>

        {tab === 'dashboard' && <DashboardTab session={session} embedded={embedded} />}
        {tab === 'devices' && <DevicesTab />}
        {tab === 'analytics' && <AnalyticsTab />}
        {tab === 'settings' && <SettingsTab app={app} session={session} embedded={embedded} />}
      </main>
      <Dock tab={tab} setTab={setTab} />
    </div>
  );
}

function StatTile({ icon, label, value, sub, accent }: { icon: ReactNode; label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`stat-tile${accent ? ' stat-tile--accent' : ''}`}>
      <span className="stat-tile__icon" aria-hidden="true">{icon}</span>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__sub">{sub ?? ' '}</span>
    </div>
  );
}

// ── Dashboard tab ─────────────────────────────────────────────────────────────
function DashboardTab({ session, embedded }: { session: Session; embedded: boolean }) {
  const who = session.sso.username
    ? `Signed in as ${session.sso.username}${embedded ? ' · via OpenMasjidOS' : ''}`
    : 'Signed in as the local admin';
  return (
    <>
      <section className="glass panel">
        <div className="card-head">
          <LayoutDashboard size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Welcome</h2>
            <p className="muted">Your tap-to-donate station is up and running.</p>
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <span className="status-pill status-pill--ok"><span className="status-dot" /> Running</span>
          <span className="status-pill">{who}</span>
        </div>
        <p className="muted" style={{ marginBlockStart: '0.85rem', lineHeight: 1.6 }}>
          Set up a tablet with a Stripe card reader, then pair it here to start taking donations. This is an early build —
          more of the admin panel arrives with each update.
        </p>
        <div className="row" style={{ marginBlockStart: '1rem', flexWrap: 'wrap' }}>
          <button className="btn btn--primary" onClick={() => navigate('/new')}>
            <Smartphone size={17} /> Set up a tablet <ArrowRight size={16} />
          </button>
          <a className="btn btn--ghost" href="#devices">
            <Plus size={16} /> Add a kiosk
          </a>
        </div>
      </section>

      <div className="stat-grid stat-grid--two">
        <StatTile icon={<MonitorSmartphone size={17} />} label="Kiosks" value="0" sub="None paired yet" />
        <StatTile icon={<Coins size={17} />} label="Donations" value="—" sub="Coming soon" />
      </div>
    </>
  );
}

// ── Devices tab ───────────────────────────────────────────────────────────────
function DevicesTab() {
  const [showInfo, setShowInfo] = useState(false);
  return (
    <section className="glass panel">
      <div className="card-head">
        <MonitorSmartphone size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Kiosks</h2>
          <p className="muted">Pair and manage the tablets running your giving screen.</p>
        </div>
      </div>

      <div className="empty-state">
        <div className="empty-emblem" aria-hidden="true">
          <MonitorSmartphone size={26} />
        </div>
        <p className="empty-title">No kiosks paired yet</p>
        <p className="muted">When you pair a tablet it will show up here with its status, battery and reader.</p>
        <button className="btn btn--primary" onClick={() => setShowInfo((v) => !v)}>
          <Plus size={16} /> Add kiosk
        </button>
        {showInfo && (
          <div className="pair-hint pair-hint--block">
            Adding a kiosk generates a single-use <b>6-digit pairing code</b> that you type into the tablet app to link it
            securely — no camera or QR needed. Full pairing lands in the next update.
          </div>
        )}
      </div>

      <p className="hint devices-note">
        First time?{' '}
        <a href={withBase('/new')} onClick={(e) => { e.preventDefault(); navigate('/new'); }}>
          Install the kiosk app
        </a>{' '}
        on your tablet.
      </p>
    </section>
  );
}

// ── Analytics tab ─────────────────────────────────────────────────────────────
function AnalyticsTab() {
  const tiles: { icon: ReactNode; label: string; value: string; sub?: string; accent?: boolean }[] = [
    { icon: <Coins size={17} />, label: 'Total raised', value: '—', accent: true },
    { icon: <CalendarDays size={17} />, label: 'This month', value: '—' },
    { icon: <ReceiptText size={17} />, label: 'Donations', value: '0' },
    { icon: <TrendingUp size={17} />, label: 'Average gift', value: '—' },
  ];
  return (
    <section className="metrics">
      <div className="stat-grid">
        {tiles.map((t) => (
          <StatTile key={t.label} icon={t.icon} label={t.label} value={t.value} sub={t.sub} accent={t.accent} />
        ))}
      </div>
      <section className="glass panel">
        <div className="empty-state">
          <div className="empty-emblem" aria-hidden="true">
            <TrendingUp size={26} />
          </div>
          <p className="empty-title">No donations yet</p>
          <p className="muted">They will appear here once the reader is taking payments.</p>
        </div>
      </section>
    </section>
  );
}

// ── Settings tab (account + platform + about) ─────────────────────────────────
function SettingsTab({ app, session, embedded }: { app: AppInfo | null; session: Session; embedded: boolean }) {
  const [res, setRes] = useState<NotifyTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const test = async () => {
    setErr('');
    setBusy(true);
    setRes(null);
    try {
      setRes(await sendTestNotification());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const platform = session.sso.enabled
    ? session.sso.reachable
      ? 'Connected'
      : 'Configured, but unreachable'
    : 'Standalone (not embedded)';

  return (
    <>
      <section className="glass panel">
        <div className="card-head">
          <ShieldCheck size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Account &amp; platform</h2>
            <p className="muted">How this kiosk connects to OpenMasjidOS.</p>
          </div>
        </div>
        <div className="kv">
          <div className="kv-row">
            <span className="kv-k">Version</span>
            <span className="kv-v">v{app?.version ?? __APP_VERSION__}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">OpenMasjidOS</span>
            <span className="kv-v">{platform}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Signed in as</span>
            <span className="kv-v">{session.sso.username ?? 'Local admin'}</span>
          </div>
        </div>
      </section>

      <section className="glass panel">
        <div className="card-head">
          <Bell size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Notifications</h2>
            <p className="muted">Send a test alert to check donation notifications reach your dashboard.</p>
          </div>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={test} disabled={busy}>
          <Bell size={15} /> {busy ? 'Sending…' : 'Send a test alert'}
        </button>
        {res && (
          <p className={res.delivered ? 'status-pill status-pill--ok' : 'hint'} style={{ marginBlockStart: '0.6rem' }}>
            {res.delivered
              ? 'Delivered — donation alerts will reach your masjid here.'
              : res.reason === 'no-fabric'
                ? 'Not embedded under OpenMasjidOS, so there is nowhere to send alerts (that is fine).'
                : 'Not delivered — enable notifications in OpenMasjidOS to receive donation alerts.'}
          </p>
        )}
        {err && <p className="form-error">{err}</p>}
      </section>

      <section className="glass panel">
        <div className="card-head">
          <Palette size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Appearance</h2>
            <p className="muted">
              {embedded
                ? 'The panel follows your OpenMasjidOS theme and wallpaper automatically. Use the account menu to override light/dark on this device.'
                : 'Running standalone. Use the account menu to switch light/dark on this device.'}
            </p>
          </div>
        </div>
      </section>

      <p className="admin-foot faint">
        OpenMasjid Kiosk v{app?.version ?? __APP_VERSION__} ·{' '}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
          Source code <ExternalLink size={12} />
        </a>{' '}
        · AGPL-3.0
      </p>
    </>
  );
}

// ── Auth: first-run setup, password login, or SSO prompt ──────────────────────
function Auth({ session, onDone }: { session: Session | null; onDone: () => Promise<void> }) {
  const sso = session?.sso;
  // Under SSO with no local password and the platform reachable, the way in is to press
  // Open in the dashboard (which sends the omos_session cookie and mints our session).
  const ssoOnly = !!sso?.enabled && !!sso?.reachable && !session?.hasPassword && !session?.needsSetup;
  // First run standalone, OR recovery when the platform is configured but unreachable.
  const showSetup = !!session?.needsSetup || (!!sso?.enabled && !sso?.reachable && !session?.hasPassword);

  if (ssoOnly) {
    return (
      <div className="wrap">
        <section className="glass-raised auth-card enter">
          <div className="emblem">
            <ShieldCheck size={26} />
          </div>
          <h1 className="auth-title">Sign in from your dashboard</h1>
          <p className="auth-sub muted">
            Open this app from your <b>OpenMasjidOS dashboard</b> — press <b>Open</b> on the Kiosk app and it signs you in
            automatically.
          </p>
          <button className="btn btn--primary btn--block" onClick={() => void onDone()}>
            I’ve signed in — continue
          </button>
        </section>
      </div>
    );
  }

  return showSetup ? <SetupForm sso={sso} onDone={onDone} /> : <LoginForm sso={sso} onDone={onDone} />;
}

function SetupForm({ sso, onDone }: { sso: Session['sso'] | undefined; onDone: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw.length < 8) return setErr('Please choose a password of at least 8 characters.');
    if (pw !== pw2) return setErr('The two passwords don’t match.');
    setBusy(true);
    try {
      await setupAdmin(pw, name.trim() || undefined);
      await onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap">
      <section className="glass-raised auth-card enter">
        <div className="emblem">
          <Crescent size={26} />
        </div>
        <h1 className="auth-title">Welcome</h1>
        <p className="auth-sub muted">
          {sso?.enabled
            ? 'Your OpenMasjidOS couldn’t be reached, so set a recovery password to manage the kiosk.'
            : 'Set an admin password to manage your kiosk. You can change it later.'}
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor="name">
              Your name <span className="faint">(optional)</span>
            </label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </div>
          <div className="field">
            <label className="label" htmlFor="pw">
              Password
            </label>
            <input id="pw" className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="field">
            <label className="label" htmlFor="pw2">
              Confirm password
            </label>
            <input id="pw2" className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </div>
          {err && <p className="form-error">{err}</p>}
          <button className="btn btn--primary btn--block" disabled={busy} type="submit">
            {busy ? 'Setting up…' : 'Create admin account'}
          </button>
        </form>
      </section>
    </div>
  );
}

function LoginForm({ sso, onDone }: { sso: Session['sso'] | undefined; onDone: () => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(pw);
      await onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap">
      <section className="glass-raised auth-card enter">
        <div className="emblem">
          <Crescent size={26} />
        </div>
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-sub muted">
          {sso?.enabled ? 'Enter the local admin password, or open the app from your OpenMasjidOS dashboard.' : 'Enter your admin password.'}
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor="pw">
              Password
            </label>
            <input id="pw" className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus />
          </div>
          {err && <p className="form-error">{err}</p>}
          <button className="btn btn--primary btn--block" disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}

// ── /new (public tablet setup page) ───────────────────────────────────────────
function NewPage({ app }: { app: AppInfo | null }) {
  const apkReady = app?.apkAvailable ?? false;
  const apkHref = withBase(app?.apkDownloadPath ?? '/download/openmasjidkiosk.apk');

  return (
    <div className="wrap">
      <section className="glass-raised setup enter">
        <div className="setup-head">
          <div className="emblem">
            <Smartphone size={28} />
          </div>
          <h1 className="setup-title">Set up your kiosk tablet</h1>
          <p className="muted">Three quick steps — no technical knowledge needed.</p>
        </div>

        <ol className="setup-steps">
          <li className="setup-step">
            <span className="num">1</span>
            <div className="setup-step__body">
              <div className="setup-step__title">Download the kiosk app on the tablet</div>
              <p className="setup-step__sub">On the Android tablet, open this page in its browser and tap Download.</p>
              <div className="download-row">
                {apkReady ? (
                  <a className="btn btn--primary" href={apkHref} download={app?.apkFilename}>
                    <Download size={17} /> Download the kiosk app
                  </a>
                ) : (
                  <>
                    <button className="btn" disabled>
                      <Download size={17} /> Download the kiosk app
                    </button>
                    <span className="pill pill--test">Available after the first build</span>
                  </>
                )}
              </div>
            </div>
          </li>

          <li className="setup-step">
            <span className="num">2</span>
            <div className="setup-step__body">
              <div className="setup-step__title">Allow the install</div>
              <p className="setup-step__sub">
                When the tablet asks, allow installing apps from your browser, then open the downloaded file to install
                “OpenMasjid Kiosk”.
              </p>
            </div>
          </li>

          <li className="setup-step">
            <span className="num">3</span>
            <div className="setup-step__body">
              <div className="setup-step__title">Pair it with this server</div>
              <p className="setup-step__sub">
                In the admin panel, go to <b>Devices → Add kiosk</b> to get a 6-digit pairing code, then type it into the
                tablet app (no camera needed). Pairing arrives in the next update.
              </p>
              <div className="download-row">
                <div className="pair-hint">Your 6-digit pairing code will appear in <b>Devices</b></div>
              </div>
            </div>
          </li>
        </ol>

        <div className="row" style={{ marginBlockStart: '1.2rem', justifyContent: 'center' }}>
          <button className="btn btn--ghost" onClick={() => navigate('/')}>
            Back to the dashboard
          </button>
        </div>
      </section>
    </div>
  );
}
