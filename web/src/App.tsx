// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The admin panel shell. Slice 1: a themed dashboard placeholder + the public /new
 *  setup page, with a tiny hand-rolled router (no router dependency). Auth/SSO, the
 *  Devices/Payments/Giving-screen/Donations sections, and live appearance sync arrive in
 *  later slices. */
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CreditCard,
  Download,
  ExternalLink,
  Palette,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { getAppInfo, type AppInfo } from './api';
import { withBase, stripBase } from './base';
import { Crescent, ThemeToggle } from './ui';

const SOURCE_URL = 'https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk';

function navigate(to: string) {
  history.pushState(null, '', withBase(to));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [path, setPath] = useState(() => stripBase(location.pathname));
  const [app, setApp] = useState<AppInfo | null>(null);

  useEffect(() => {
    const onPop = () => setPath(stripBase(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    void getAppInfo()
      .then(setApp)
      .catch(() => setApp(null));
  }, []);

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
          <ThemeToggle />
        </header>

        <main className="main">
          {path === '/new' ? <NewPage app={app} /> : <Dashboard app={app} />}
        </main>

        <footer className="foot">
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code <ExternalLink size={13} />
          </a>
          <span aria-hidden="true"> · </span>
          AGPL-3.0 · v{app?.version ?? __APP_VERSION__}
        </footer>
      </div>
    </>
  );
}

function Dashboard({ app }: { app: AppInfo | null }) {
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
          <span className="pill">{app?.embedded ? 'Signed in via OpenMasjidOS' : 'Standalone'}</span>
        </div>
        <p className="hero-lead">
          Your tap-to-donate station is up. Finish setting it up in a few steps, then pair a
          tablet with a Stripe card reader. This is an early build — more of the admin panel
          arrives with each update.
        </p>

        <ul className="steps-list">
          <li>
            <CreditCard size={18} />
            <span>
              <b>Choose your Stripe account</b> — pick the account you set up in OpenMasjidOS
              (Settings → Payments). <span className="muted">Coming next.</span>
            </span>
          </li>
          <li>
            <Palette size={18} />
            <span>
              <b>Design your giving screen</b> — six amounts, a custom amount, a thank-you
              message and your wallpaper. <span className="muted">Coming soon.</span>
            </span>
          </li>
          <li>
            <Smartphone size={18} />
            <span>
              <b>Pair a tablet</b> — download the kiosk app and scan a pairing code.
            </span>
          </li>
        </ul>

        <div className="row" style={{ marginBlockStart: '0.6rem' }}>
          <button className="btn btn--primary" onClick={() => navigate('/new')}>
            <Smartphone size={17} /> Set up a tablet <ArrowRight size={16} />
          </button>
          <a className="btn btn--ghost" href={SOURCE_URL} target="_blank" rel="noreferrer">
            <ShieldCheck size={16} /> Source code
          </a>
        </div>
      </section>
    </div>
  );
}

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
              <p className="setup-step__sub">
                On the Android tablet, open this page in its browser and tap Download.
              </p>
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
                When the tablet asks, allow installing apps from your browser, then open the
                downloaded file to install “OpenMasjid Kiosk”.
              </p>
            </div>
          </li>

          <li className="setup-step">
            <span className="num">3</span>
            <div className="setup-step__body">
              <div className="setup-step__title">Pair it with this server</div>
              <p className="setup-step__sub">
                In the admin panel, go to <b>Devices → Add kiosk</b> to get a pairing code,
                then scan it with the tablet app. Pairing arrives in the next update.
              </p>
              <div className="download-row">
                <div className="qr-placeholder">Your pairing QR will appear in Devices</div>
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
