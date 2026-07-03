// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The admin panel shell + the public /new setup page, with a tiny hand-rolled router.
 *  Slice 2 adds the auth gate: first-run setup or password login, single sign-on via
 *  OpenMasjidOS (with a local-password fallback so the panel never bricks), live appearance
 *  inheritance, and an About page with a Fabric notification test. Devices / Payments /
 *  Giving-screen / Donations sections arrive in later slices. */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Bell,
  CreditCard,
  Download,
  ExternalLink,
  Info,
  LogOut,
  Palette,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { getAppInfo, getSession, login, logout, sendTestNotification, setupAdmin, type AppInfo, type NotifyTestResult, type Session } from './api';
import { withBase, stripBase } from './base';
import { useOmosAppearanceSync } from './prefs';
import { Crescent, ThemeToggle } from './ui';

const SOURCE_URL = 'https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk';

function navigate(to: string) {
  history.pushState(null, '', withBase(to));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [path, setPath] = useState(() => stripBase(location.pathname));
  const [app, setApp] = useState<AppInfo | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  const isAdminArea = path !== '/new';

  return (
    <>
      <div className="scene" aria-hidden="true" />
      <div className="shell">
        <header className="topbar">
          <button className="brand" onClick={() => navigate('/')}>
            <Crescent />
            <span className="on-scene">
              OpenMasjid <b>Kiosk</b>
            </span>
          </button>
          <div className="spacer" />
          {session?.authed && (
            <button className="icon-btn" title="About" aria-label="About" onClick={() => navigate('/about')}>
              <Info size={19} />
            </button>
          )}
          <ThemeToggle />
          {session?.authed && (
            <button
              className="icon-btn"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await logout().catch(() => {});
                await reloadSession();
                navigate('/');
              }}
            >
              <LogOut size={19} />
            </button>
          )}
        </header>

        <main className="main">
          {!loaded ? (
            <div className="wrap">
              <div className="glass-raised hero-card enter" aria-busy="true">
                <div className="emblem">
                  <Crescent size={30} />
                </div>
                <p className="muted">Loading…</p>
              </div>
            </div>
          ) : path === '/new' ? (
            <NewPage app={app} />
          ) : !session?.authed ? (
            <Auth session={session} onDone={reloadSession} />
          ) : path === '/about' ? (
            <About app={app} session={session} />
          ) : (
            <Dashboard session={session} />
          )}
        </main>

        <footer className="foot">
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code <ExternalLink size={13} />
          </a>
          <span aria-hidden="true"> · </span>
          AGPL-3.0 · v{app?.version ?? __APP_VERSION__}
          {isAdminArea ? null : ''}
        </footer>
      </div>
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

// ── Dashboard (slice-2 shell) ─────────────────────────────────────────────────
function Dashboard({ session }: { session: Session }) {
  const who = session.sso.username ? `Signed in via OpenMasjidOS as ${session.sso.username}` : 'Signed in as the local admin';
  return (
    <div className="wrap">
      <section className="glass-raised hero-card enter">
        <div className="emblem">
          <Crescent size={30} />
        </div>
        <h1 className="hero-title">OpenMasjid Kiosk</h1>
        <div className="row">
          <span className="pill pill--ok">
            <span className="status-dot" /> Running
          </span>
          <span className="pill">{who}</span>
        </div>
        <p className="hero-lead">
          Your tap-to-donate station is up. Finish setting it up in a few steps, then pair a tablet with a Stripe card
          reader. This is an early build — more of the admin panel arrives with each update.
        </p>

        <ul className="steps-list">
          <li>
            <CreditCard size={18} />
            <span>
              <b>Choose your Stripe account</b> — pick the account you set up in OpenMasjidOS (Settings → Payments).{' '}
              <span className="muted">Coming next.</span>
            </span>
          </li>
          <li>
            <Palette size={18} />
            <span>
              <b>Design your giving screen</b> — six amounts, a custom amount, a thank-you message and your wallpaper.{' '}
              <span className="muted">Coming soon.</span>
            </span>
          </li>
          <li>
            <Smartphone size={18} />
            <span>
              <b>Pair a tablet</b> — download the kiosk app and enter a 6-digit pairing code.
            </span>
          </li>
        </ul>

        <div className="row" style={{ marginBlockStart: '0.6rem' }}>
          <button className="btn btn--primary" onClick={() => navigate('/new')}>
            <Smartphone size={17} /> Set up a tablet <ArrowRight size={16} />
          </button>
          <button className="btn btn--ghost" onClick={() => navigate('/about')}>
            <Info size={16} /> About
          </button>
        </div>
      </section>
    </div>
  );
}

// ── About (version, Fabric status, notification test, source) ─────────────────
function About({ app, session }: { app: AppInfo | null; session: Session }) {
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

  return (
    <div className="wrap">
      <section className="glass-raised setup enter">
        <div className="setup-head">
          <div className="emblem">
            <Info size={26} />
          </div>
          <h1 className="setup-title">About</h1>
          <p className="muted">OpenMasjid Kiosk · v{app?.version ?? __APP_VERSION__}</p>
        </div>

        <div className="kv">
          <div className="kv-row">
            <span className="kv-k">OpenMasjidOS</span>
            <span className="kv-v">
              {session.sso.enabled ? (session.sso.reachable ? 'Connected' : 'Configured, but unreachable') : 'Standalone (not embedded)'}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Signed in as</span>
            <span className="kv-v">{session.sso.username ?? 'Local admin'}</span>
          </div>
        </div>

        <div className="stack" style={{ marginBlockStart: '1rem' }}>
          <button className="btn btn--ghost" onClick={test} disabled={busy}>
            <Bell size={16} /> {busy ? 'Sending…' : 'Send a test alert'}
          </button>
          {res && (
            <p className={res.delivered ? 'pill pill--ok' : 'muted'}>
              {res.delivered
                ? 'Delivered — donation alerts will reach your masjid here.'
                : res.reason === 'no-fabric'
                  ? 'Not embedded under OpenMasjidOS, so there’s nowhere to send alerts (that’s fine).'
                  : 'Not delivered — enable notifications in OpenMasjidOS to receive donation alerts.'}
            </p>
          )}
          {err && <p className="form-error">{err}</p>}
        </div>

        <div className="row" style={{ marginBlockStart: '1.2rem', justifyContent: 'space-between' }}>
          <a className="btn btn--ghost" href={SOURCE_URL} target="_blank" rel="noreferrer">
            <ShieldCheck size={16} /> Source code (AGPL-3.0)
          </a>
          <button className="btn" onClick={() => navigate('/')}>
            Back
          </button>
        </div>
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
