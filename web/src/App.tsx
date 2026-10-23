// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The admin panel shell + the public /new setup page, with a tiny hand-rolled router.
 *  The shell mirrors the OpenMasjidOS dashboard: an ambient scene with a custom-wallpaper
 *  inheritance, a top bar (brand + clock + profile menu) and a bottom dock for the six
 *  sections (Dashboard, Devices, Campaigns, Donations, Recurring, Settings). Auth (first-run setup /
 *  password login / SSO with a local-password fallback) gates everything but the public /new page.
 *
 *  THE SECTIONS ARE LAZY — each is a chunk of its own, fetched only once someone has signed in. The
 *  public /new page is opened on a tablet's browser before it is paired, and the sign-in card is the
 *  first thing every admin meets; neither needs the ~130 kB of section code, and on a Raspberry Pi
 *  (app UI spec §8) parsing it is the slow part. Nothing on those two screens may import a section
 *  module, or the split silently undoes itself: /new takes its server-address box from
 *  serverAddress.tsx, which exists so that it does not have to import devices.tsx. */
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  Coins,
  Download,
  ExternalLink,
  LayoutDashboard,
  Megaphone,
  MonitorSmartphone,
  Palette,
  Plus,
  Repeat,
  RotateCw,
  Settings,
  ShieldCheck,
  Smartphone,
  Tablet,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import {
  errorText,
  getAppInfo,
  getDevices,
  getDonations,
  getMasjid,
  getPayments,
  getSession,
  login,
  saveMasjid,
  setupAdmin,
  SIGNED_OUT_EVENT,
  type AppInfo,
  type Device,
  type Masjid,
  type Session,
} from './api';
import { withBase, stripBase } from './base';
import { deviceTimeZone, isValidTimeZone, localeForCountry, setClock } from './locale';
import { formatMoney } from './money';
import { resolveTheme, useOmosAppearanceSync, useOmosLogo, usePrefs, useReadableTheme } from './prefs';
import { ServerAddress } from './serverAddress';
import { Brand, Clock, Crescent, figures, ProfileMenu, ResultLine, Scene, Skeleton, useClock } from './ui';

const SOURCE_URL = 'https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk';

// ── The sections, one chunk each ─────────────────────────────────────────────
// Each loader is named once so the same import() serves the lazy component AND the warm-up below — a
// module is fetched once however many components come out of it (campaigns has two).
const loadPayments = () => import('./payments');
const loadDevices = () => import('./devices');
const loadCampaigns = () => import('./campaigns');
const loadDonations = () => import('./donations');
const loadPlans = () => import('./plans');
const loadEmail = () => import('./email');
const loadAlerts = () => import('./alerts');

const PaymentsSection = lazy(() => loadPayments().then((m) => ({ default: m.PaymentsSection })));
const DevicesSection = lazy(() => loadDevices().then((m) => ({ default: m.DevicesSection })));
const CampaignsSection = lazy(() => loadCampaigns().then((m) => ({ default: m.CampaignsSection })));
const CampaignEditorPage = lazy(() => loadCampaigns().then((m) => ({ default: m.CampaignEditorPage })));
const DonationsSection = lazy(() => loadDonations().then((m) => ({ default: m.DonationsSection })));
const PlansSection = lazy(() => loadPlans().then((m) => ({ default: m.PlansSection })));
const EmailReceiptSection = lazy(() => loadEmail().then((m) => ({ default: m.EmailReceiptSection })));
const NotificationsSection = lazy(() => loadAlerts().then((m) => ({ default: m.NotificationsSection })));

const SECTION_LOADERS: (() => Promise<unknown>)[] = [loadDevices, loadCampaigns, loadDonations, loadPlans, loadPayments, loadAlerts, loadEmail];

/**
 * Fetch every section in the background once someone is signed in and the browser is idle.
 *
 * Not only to make the first visit to a tab instant. A chunk's file name carries its build's hash,
 * and the image serves ONLY its own build — so a panel left open across an update (Hasan presses
 * Update on the dev channel several times an afternoon) would ask for a chunk that no longer exists
 * the first time someone opened a tab it had not visited yet. Warmed early, every section is already
 * in the browser's module map, from the same build as the page around it. A warm-up that fails is
 * ignored: the tab's own import() tries again when it is opened, and SectionBoundary catches it then.
 */
function warmSections() {
  for (const load of SECTION_LOADERS) void load().catch(() => undefined);
}

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

  // An admin call came back 401 — almost always an SSO session that ran out while the panel sat open
  // (it lasts an hour, and only GET /api/session re-mints it from the dashboard's cookie). Re-check
  // the session rather than leave every Save button saying "sign in" with nowhere to do it: when the
  // dashboard cookie is still good this quietly re-mints and the panel carries on where it was; when
  // it is not, the session comes back unauthed and the sign-in card replaces the shell. A poller and
  // a save can both hit the 401 in the same moment, so one re-check at a time.
  useEffect(() => {
    let checking = false;
    const onSignedOut = () => {
      if (checking) return;
      checking = true;
      void reloadSession().finally(() => {
        checking = false;
      });
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [reloadSession]);

  // Follow the dashboard's theme/wallpaper/accent live when opened from OpenMasjidOS.
  useOmosAppearanceSync();

  // On-scene text color follows whatever is ACTUALLY behind it, which is not always the theme.
  // With a preset wallpaper the theme decides (both now have their own light/dark gradient), so
  // `data-scene` is left off entirely and tokens.css picks the ink from data-theme.
  //
  // A CUSTOM wallpaper image overrides both: it is whatever the masjid uploaded, in either theme.
  // So when one is set we state the sampled tone EXPLICITLY — "dark" as well as "light" — because
  // the case that breaks otherwise is a dark photo under light theme: light theme would put dark
  // ink on it, and merely removing the attribute would leave that standing. tokens.css orders the
  // two data-scene rules after the theme rules so a stated tone always wins.
  //
  // The FALLBACK matters as much as the sampling. It used to be a hardcoded 'dark', which was
  // harmless while light mode kept the dark backdrop and became a real fault the moment it didn't:
  // an image that cannot be sampled (a decode failure, a cross-origin URL that taints the canvas)
  // would state `data-scene="dark"` on a light page, putting light ink on light glass — the titles
  // disappear entirely. Falling back to the CURRENT theme keeps the page self-consistent, which is
  // exactly the state a preset wallpaper is already in.
  const hasImage = prefs.wallpaperImage.trim().length > 0;
  const sceneTone = useReadableTheme(prefs.wallpaperImage.trim() || undefined, resolveTheme(prefs.theme));
  useEffect(() => {
    const html = document.documentElement;
    if (hasImage) html.setAttribute('data-scene', sceneTone);
    else html.removeAttribute('data-scene');
  }, [hasImage, sceneTone]);

  return (
    <>
      <Scene />
      {path === '/new' ? (
        // Public tablet-setup page — no auth, no dock/profile. It waits for the app info because
        // every button on it depends on which APKs this image carries: rendered before that answer,
        // it said "not included" for a moment even when both were, and chose the wrong app to lead.
        <div className="shell">
          <main className="main">{loaded ? <NewPage app={app} /> : <LoadingCard />}</main>
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
        <Skeleton rows={2} height="0.9rem" widths={['12rem', '8rem']} />
      </div>
    </div>
  );
}

// ── Section loading and failure ───────────────────────────────────────────────
/** What a section shows while its chunk is on the way: a panel-shaped skeleton, never a spinner. */
function SectionSkeleton() {
  return (
    <section className="glass panel" aria-busy="true">
      <Skeleton rows={4} height="1.05rem" widths={['38%', '100%', '92%', '64%']} />
    </section>
  );
}

/**
 * A section that could not be shown. The usual cause is the one warmSections() exists to prevent —
 * the app was updated while this page was open and a section's chunk is gone — and the cure for that
 * is a reload, so that is the button. Anything else that throws while a section renders lands here
 * too, rather than taking the whole panel (dock, top bar and all) down to a blank page.
 */
function SectionFailed({ error }: { error: Error }) {
  return (
    <section className="glass panel">
      <div className="card-head">
        <TriangleAlert size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">This part of the panel didn’t load</h2>
          <p className="muted" role="alert">
            This usually means the kiosk app was just updated. Reload the page to carry on — nothing you have already
            saved is lost.
          </p>
        </div>
      </div>
      <button type="button" className="btn btn--primary btn--sm" onClick={() => window.location.reload()}>
        <RotateCw size={15} aria-hidden="true" /> Reload the page
      </button>
      {error.message && (
        <details className="tech-details">
          <summary>Technical details</summary>
          <p className="log-detail" dir="ltr">
            <code>{error.message}</code>
          </p>
        </details>
      )}
    </section>
  );
}

/** Suspense for a lazy section, plus the error boundary a lazy import needs: React has no hook for
 *  catching a render error, so this one piece is a class. */
class SectionBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (this.state.error) return <SectionFailed error={this.state.error} />;
    return <Suspense fallback={<SectionSkeleton />}>{this.props.children}</Suspense>;
  }
}

// ── The masjid's clock ────────────────────────────────────────────────────────
/** Every date and amount in the panel is written in the masjid's zone, hour cycle and conventions
 *  (locale.ts), which live with the masjid details on the server. */
function applyMasjidClock(m: Masjid) {
  setClock({
    timeZone: m.timeZone,
    clock24h: m.clock24h,
    hijriOffset: m.hijriOffset,
    locale: localeForCountry(m.address?.country ?? ''),
  });
}

/** Once per page load at most: an empty zone is filled from this computer's once, and only once, so a
 *  sign-out and back in does not ask again. */
let zoneSuggested = false;

// ── Admin shell: top bar + hash-routed tabs + bottom dock ─────────────────────
type Tab = 'dashboard' | 'devices' | 'giving' | 'analytics' | 'recurring' | 'settings';
const TABS: { id: Tab; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'devices', label: 'Devices', Icon: MonitorSmartphone },
  { id: 'giving', label: 'Campaigns', Icon: Megaphone },
  { id: 'analytics', label: 'Donations', Icon: TrendingUp },
  { id: 'recurring', label: 'Recurring', Icon: Repeat },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

/** The campaign id in a "#campaign/<id>" hash (or "new"), else ''. That route is a PAGE of its own —
 *  the campaign editor opens in its own browser tab, so the hash has to survive a fresh load. */
function campaignFromHash(): string {
  const h = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
  const m = /^campaign\/(.+)$/.exec(h);
  return m ? decodeURIComponent(m[1]) : '';
}

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
            <Icon size={20} aria-hidden="true" />
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
  // "#campaign/<id>" is a page rather than a tab — the campaign editor is a big two-column form with a
  // live kiosk preview, so it opens in its own browser tab instead of a dialog over the list.
  const [campaignId, setCampaignId] = useState<string>(() => campaignFromHash());
  useEffect(() => {
    const onHash = () => {
      setTabState(tabFromHash());
      setCampaignId(campaignFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setTab = (t: Tab) => {
    if (typeof location !== 'undefined') history.replaceState(null, '', `${location.pathname}#${t}`);
    setTabState(t);
    setCampaignId(''); // replaceState fires no hashchange, so leave the editor page explicitly
  };

  // The masjid's clock, loaded as soon as someone is signed in — every date on every tab waits on it
  // (components re-render through useClock when it lands). The zone is empty only until the first
  // sign-in, and then this computer's zone is SAVED as the masjid's, once: visibly, on Settings →
  // Payments → Masjid details, where it can be changed. From then on the browser has no say, so a
  // trustee checking in from abroad sees the masjid's times, not their hotel's. If any of this
  // fails, the defaults stand and dates still render — just in this device's zone, as before.
  useEffect(() => {
    void (async () => {
      try {
        const m = await getMasjid();
        applyMasjidClock(m);
        const zone = deviceTimeZone();
        if (!m.timeZone && !zoneSuggested && isValidTimeZone(zone)) {
          zoneSuggested = true;
          applyMasjidClock(await saveMasjid({ timeZone: zone }));
        }
      } catch {
        /* keep the defaults — see above */
      }
    })();
  }, []);

  // The sections' chunks, fetched while the admin is reading the dashboard (see warmSections).
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warmSections, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(warmSections, 1500); // Safari has no requestIdleCallback
    return () => clearTimeout(t);
  }, []);

  const meta: Record<Tab, { title: string; sub: string }> = {
    dashboard: { title: 'Dashboard', sub: `${session.sso.username ? `Signed in as ${session.sso.username}` : 'Signed in'}${embedded ? ' · via OpenMasjidOS' : ''}` },
    devices: { title: 'Devices', sub: 'The tablets running your giving screen.' },
    giving: { title: 'Campaigns', sub: 'Design the giving screens your kiosks show — each appeal is its own tab.' },
    analytics: { title: 'Donations', sub: 'What your kiosks have taken.' },
    recurring: { title: 'Recurring', sub: 'Monthly donations set up at your kiosks — read live from Stripe.' },
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
          <h1 className="page-title">{campaignId ? 'Campaign' : meta[tab].title}</h1>
          <p className="page-sub">
            {campaignId ? 'Design one appeal — the giving screen your kiosks show for it.' : meta[tab].sub}
          </p>
        </div>

        {/* Keyed by the route, so a section that failed does not stay failed after moving to another. */}
        <SectionBoundary key={campaignId ? `campaign/${campaignId}` : tab}>
          {campaignId && <CampaignEditorPage key={campaignId} campaignId={campaignId} />}
          {!campaignId && tab === 'dashboard' && <DashboardTab session={session} embedded={embedded} />}
          {!campaignId && tab === 'devices' && <DevicesTab />}
          {!campaignId && tab === 'giving' && <CampaignsSection />}
          {!campaignId && tab === 'analytics' && <DonationsSection />}
          {!campaignId && tab === 'recurring' && <PlansSection />}
          {!campaignId && tab === 'settings' && <SettingsTab app={app} session={session} embedded={embedded} />}
        </SectionBoundary>
      </main>
      <Dock tab={tab} setTab={setTab} />
    </div>
  );
}

/** `index` staggers the grid in once on mount (the `.stagger` rule) — these tiles are not polled, and
 *  a grid that is must never re-animate on a refresh. */
function StatTile({
  index,
  icon,
  label,
  value,
  sub,
  accent,
}: {
  index: number;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat-tile${accent ? ' stat-tile--accent' : ''}`} style={{ '--i': index } as CSSProperties}>
      <span className="stat-tile__icon" aria-hidden="true">{icon}</span>
      <span className="stat-tile__label">{label}</span>
      <div className="stat-tile__value">{value}</div>
      <span className="stat-tile__sub">{figures(sub ?? ' ')}</span>
    </div>
  );
}

// ── Dashboard tab ─────────────────────────────────────────────────────────────
/**
 * The landing tab, and the one place that says how things are. So it says only what it has just
 * checked: it used to announce "up and running" beside a permanent green "Running" pill whether or
 * not a Stripe account was chosen or a single kiosk was paired, and a failed request read as "0 —
 * None paired yet", a false statement about the fleet. Now the fleet line comes from the devices the
 * server returned, "Ready to take donations" appears only when a kiosk is online AND payments are set
 * up in live mode, and a failed check says it failed, with a button that really checks again.
 */
function DashboardTab({ session, embedded }: { session: Session; embedded: boolean }) {
  useClock(); // the total is written in the masjid's locale, which can arrive after this mounts
  const who = session.sso.username
    ? `Signed in as ${session.sso.username}${embedded ? ' · via OpenMasjidOS' : ''}`
    : 'Signed in as the local admin';
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devErr, setDevErr] = useState('');
  // Kept as numbers and formatted at render, so the masjid's locale applies once it has loaded.
  const [raised, setRaised] = useState<{ minor: number; currency: string; count: number } | null>(null);
  const [raisedErr, setRaisedErr] = useState('');
  const [pay, setPay] = useState<{ configured: boolean; testMode: boolean } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setDevErr('');
    setRaisedErr('');
    await Promise.allSettled([
      getDevices().then(
        (r) => alive.current && setDevices(r.devices),
        (e) => alive.current && setDevErr(errorText(e, 'We couldn’t check on your kiosks just now. Please try again.')),
      ),
      getDonations().then(
        (r) => alive.current && setRaised({ minor: r.totals.allTime, currency: r.currency, count: r.totals.count }),
        (e) => alive.current && setRaisedErr(errorText(e, 'We couldn’t check your donations just now. Please try again.')),
      ),
      // Payments only ever ADDS something here — a nudge, a test-mode badge, the ready pill. If it
      // cannot be read we say nothing about payments rather than guess either way.
      getPayments().then(
        (p) => alive.current && setPay({ configured: !!p.resolved?.configured, testMode: p.testMode }),
        () => undefined,
      ),
    ]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // The button stays in place (and focused) while it works — it is not disabled, and it does not
  // vanish the instant the old error clears.
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    await load();
    if (alive.current) setRetrying(false);
  };

  const fleetKnown = !devErr && devices != null;
  const total = fleetKnown ? devices.length : 0;
  const online = fleetKnown ? devices.filter((d) => d.online).length : 0;
  const failure = devErr || raisedErr;
  const ready = fleetKnown && online > 0 && !!pay?.configured && !pay.testMode;

  let fleetLine: ReactNode = null;
  if (!devErr && devices == null) {
    fleetLine = <Skeleton rows={1} height="0.95rem" widths={['16rem']} label="Checking your kiosks…" />;
  } else if (fleetKnown) {
    fleetLine = (
      <p className="muted">
        {total === 0
          ? 'No kiosks are paired yet.'
          : online === 0
            ? total === 1
              ? 'Your kiosk isn’t online right now — check it’s switched on and connected to Wi-Fi.'
              : `None of your ${total} kiosks is online right now — check they’re switched on and connected to Wi-Fi.`
            : online === total
              ? total === 1
                ? 'Your kiosk is online.'
                : `All ${total} kiosks are online.`
              : (
                  <>
                    {online} of {total} kiosks are online — <a href="#devices">open Devices</a> to see which.
                  </>
                )}
      </p>
    );
  }

  // Silent (label=""): the fleet line above is already saying "Checking your kiosks…", and three
  // loading announcements at once is noise.
  const kiosksValue: ReactNode =
    devices == null && !devErr ? <Skeleton rows={1} height="1.2rem" label="" /> : fleetKnown ? String(total) : '—';
  const kiosksSub = devErr ? 'Couldn’t check just now' : !fleetKnown ? ' ' : total === 0 ? 'None paired yet' : `${online} online`;
  const raisedValue: ReactNode = raisedErr
    ? '—'
    : raised
      ? formatMoney(raised.minor, raised.currency)
      : <Skeleton rows={1} height="1.2rem" label="Loading donations…" />;
  const raisedSub = raisedErr ? 'Couldn’t check just now' : raised ? (raised.count ? `${raised.count} all time` : 'None yet') : ' ';

  return (
    <>
      <section className="glass panel">
        <div className="card-head">
          <LayoutDashboard size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Welcome</h2>
            {fleetLine}
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          {ready && (
            <span className="status-pill status-pill--ok">
              <span className="status-dot" aria-hidden="true" /> Ready to take donations
            </span>
          )}
          {pay?.testMode && <span className="badge badge--test">Test mode</span>}
          <span className="status-pill">{who}</span>
        </div>
        {failure && <ResultLine ok={false}>{failure}</ResultLine>}
        <p className="muted" style={{ marginBlockStart: '0.85rem', lineHeight: 1.6 }}>
          Set up a tablet with a Stripe card reader, then pair it here to start taking donations.
        </p>
        {pay && !pay.configured && (
          <p className="muted" style={{ marginBlockStart: '0.5rem', lineHeight: 1.6 }}>
            Next: connect the Stripe account donations are paid into, in <a href="#settings">Settings → Payments</a>.
          </p>
        )}
        {pay?.testMode && (
          <p className="muted" style={{ marginBlockStart: '0.5rem', lineHeight: 1.6 }}>
            Payments are in test mode, so no real money is taken. Switch to your live Stripe account in{' '}
            <a href="#settings">Settings → Payments</a> before donors use a kiosk.
          </p>
        )}
        <div className="row" style={{ marginBlockStart: '1rem', flexWrap: 'wrap' }}>
          <button className="btn btn--primary" onClick={() => navigate('/new')}>
            <Smartphone size={17} aria-hidden="true" /> Set up a tablet <ArrowRight size={16} className="rtl-flip" aria-hidden="true" />
          </button>
          <a className="btn btn--ghost" href="#devices">
            <Plus size={16} aria-hidden="true" /> Add a kiosk
          </a>
          {(failure || retrying) && (
            <button type="button" className="btn btn--ghost" onClick={() => void retry()} aria-disabled={retrying}>
              <RotateCw size={16} aria-hidden="true" /> {retrying ? 'Checking again…' : 'Try again'}
            </button>
          )}
        </div>
      </section>

      <div className="stat-grid stat-grid--two stagger">
        <StatTile index={0} icon={<MonitorSmartphone size={17} />} label="Kiosks" value={kiosksValue} sub={kiosksSub} />
        <StatTile index={1} icon={<Coins size={17} />} label="Donations" value={raisedValue} sub={raisedSub} />
      </div>
    </>
  );
}

// ── Devices tab ───────────────────────────────────────────────────────────────
function DevicesTab() {
  return (
    <>
      <DevicesSection />
      <p className="hint devices-note">
        First time?{' '}
        <a href={withBase('/new')} onClick={(e) => { e.preventDefault(); navigate('/new'); }}>
          Install the kiosk app
        </a>{' '}
        on your tablet.
      </p>
    </>
  );
}

// ── Settings tab (account + platform + about) ─────────────────────────────────
/**
 * Each lazy section has a boundary of its own, so the panels that are plain markup (the account, the
 * appearance note, the footer) show at once and each section fills in as its chunk arrives.
 *
 * There used to be a second "Notifications" panel here with its own "Send a test alert" button,
 * which reached only the OpenMasjidOS bell. The notifications matrix below has the OpenMasjidOS relay
 * as its first row, and its test follows every route the admin set up — so two panels with the same
 * heading and two test buttons of different reach became one of each.
 */
function SettingsTab({ app, session, embedded }: { app: AppInfo | null; session: Session; embedded: boolean }) {
  const platform = session.sso.enabled
    ? session.sso.reachable
      ? 'Connected'
      : 'Set up, but not answering right now — check OpenMasjidOS is running'
    : 'Not connected to OpenMasjidOS';

  return (
    <>
      <SectionBoundary>
        <PaymentsSection />
      </SectionBoundary>

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

      <SectionBoundary>
        <NotificationsSection />
      </SectionBoundary>

      <SectionBoundary>
        <EmailReceiptSection />
      </SectionBoundary>

      <section className="glass panel">
        <div className="card-head">
          <Palette size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Appearance</h2>
            <p className="muted">
              {embedded
                ? 'The panel follows your OpenMasjidOS theme, accent color and wallpaper automatically. Use the account menu to override light/dark on this device.'
                : 'Not connected to OpenMasjidOS. Use the account menu to switch light/dark on this device.'}
            </p>
          </div>
        </div>
      </section>

      <p className="admin-foot faint">
        OpenMasjid Kiosk v{app?.version ?? __APP_VERSION__} ·{' '}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
          Source code <ExternalLink size={12} aria-hidden="true" />
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
  // Open in the dashboard (which sends the omos_session cookie and mints our session). From outside
  // the masjid that is the ONLY way in: the password form and setup are refused there.
  const remote = !!session?.remote;
  const ssoOnly = remote || (!!sso?.enabled && !!sso?.reachable && !session?.hasPassword && !session?.needsSetup);
  // First run standalone, OR recovery when the platform is configured but unreachable.
  const showSetup = !!session?.needsSetup || (!!sso?.enabled && !sso?.reachable && !session?.hasPassword);

  if (ssoOnly) return <SsoPrompt onDone={onDone} remote={remote} />;

  return showSetup ? <SetupForm sso={sso} onDone={onDone} /> : <LoginForm sso={sso} onDone={onDone} />;
}

/** "Open this from your dashboard." The button re-checks the session: when that worked this card is
 *  replaced by the panel, and when it did not, the same card used to come straight back unchanged —
 *  which reads as a button that does nothing. So it says so, and says what to do instead. */
function SsoPrompt({ onDone, remote }: { onDone: () => Promise<void>; remote: boolean }) {
  const [busy, setBusy] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setNotYet(false);
    try {
      await onDone();
    } finally {
      setBusy(false);
      setNotYet(true);
    }
  };

  return (
    <div className="wrap">
      <section className="glass-raised auth-card enter">
        <div className="emblem">
          <ShieldCheck size={26} aria-hidden="true" />
        </div>
        <h1 className="auth-title">Sign in from your dashboard</h1>
        <p className="auth-sub muted">
          Open this app from your <b>OpenMasjidOS dashboard</b> — press <b>Open</b> on the Kiosk app and it signs you in
          automatically.
          {remote && ' You’re outside the masjid, so Kiosk’s own password won’t work here — it only works on the masjid’s network.'}
        </p>
        <button className="btn btn--primary btn--block" onClick={() => void check()} aria-disabled={busy}>
          {busy ? 'Checking…' : 'I’ve signed in — continue'}
        </button>
        {notYet && (
          <ResultLine ok={false}>
            You’re not signed in yet. Go back to your OpenMasjidOS dashboard and press <b>Open</b> on the Kiosk app.
          </ResultLine>
        )}
      </section>
    </div>
  );
}

function SetupForm({ sso, onDone }: { sso: Session['sso'] | undefined; onDone: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (pw.length < 8) return setErr('Please choose a password of at least 8 characters.');
    if (pw !== pw2) return setErr('The two passwords don’t match.');
    setBusy(true);
    try {
      await setupAdmin(pw, name.trim() || undefined);
      await onDone();
    } catch (e2) {
      setErr(errorText(e2));
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
          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}
          {/* aria-disabled rather than disabled: a disabled button drops the focus it had. */}
          <button className="btn btn--primary btn--block" aria-disabled={busy} type="submit">
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
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      await login(pw);
      await onDone();
    } catch (e2) {
      setErr(errorText(e2));
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
          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}
          <button className="btn btn--primary btn--block" aria-disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}

// ── /new (public device setup page) ───────────────────────────────────────────
/**
 * Two apps, one page.
 *
 * A masjid runs a wall-mounted **kiosk** (locked down, one tablet, always there) and hands
 * volunteers the **mobile donations** app at a fundraising event (an ordinary phone, unlocked, in
 * a pocket). The install steps are nearly the same for both — download, allow, pair with a 6-digit
 * code — so this is one flow with a chooser rather than two pages that would drift apart.
 *
 * Each app is offered only when its APK is actually bundled in this image. That is the same rule
 * the kiosk button already followed, and it is why there is no "coming in a future update" copy
 * anywhere here: /new is read by a volunteer standing at a device, and a page that promises
 * something the server cannot hand over wastes the one moment they were ready to act. When one is
 * missing, the page says who can fix that, which is the only useful thing to say.
 */
type SetupTarget = 'kiosk' | 'mobile';

/**
 * The masjid's own identity at the top of /new — the page a volunteer meets standing at a new
 * tablet, where "is this our masjid's server?" is a fair question. Their logo when OpenMasjidOS has
 * one (through our same-origin relay), else their name as a wordmark, else the device emblem. Never a
 * broken image: a logo that fails to load falls back exactly as if there were none (spec §1b). The
 * name is shown as given — never re-cased or shortened.
 */
function MasjidMark({ name, fallback }: { name: string; fallback: ReactNode }) {
  const logo = useOmosLogo();
  const [failed, setFailed] = useState('');
  const hasName = name.trim().length > 0;
  if (logo && failed !== logo) {
    return (
      <img
        className="setup-logo"
        src={withBase(logo)}
        alt={hasName ? name : 'Your masjid'}
        height={72}
        style={{ maxInlineSize: '100%', objectFit: 'contain' }}
        onError={() => setFailed(logo)}
      />
    );
  }
  if (hasName) {
    return (
      <p className="setup-wordmark" dir="auto">
        {name}
      </p>
    );
  }
  return <>{fallback}</>;
}

function NewPage({ app }: { app: AppInfo | null }) {
  const kioskReady = app?.apkAvailable ?? false;
  const mobileReady = app?.mobileApkAvailable ?? false;
  // Default to whichever is on offer. When both are, the kiosk leads — it is the install that has
  // to happen once per masjid, where the mobile app is per volunteer per event.
  const [target, setTarget] = useState<SetupTarget>(kioskReady || !mobileReady ? 'kiosk' : 'mobile');

  const isKiosk = target === 'kiosk';
  const ready = isKiosk ? kioskReady : mobileReady;
  const href = withBase(
    (isKiosk ? app?.apkDownloadPath : app?.mobileApkDownloadPath) ??
      (isKiosk ? '/download/openmasjidkiosk.apk' : '/download/openmasjidmobile.apk'),
  );
  const filename = isKiosk ? app?.apkFilename : app?.mobileApkFilename;
  const appName = isKiosk ? 'OpenMasjid Kiosk' : 'OpenMasjid Mobile Donations';
  const device = isKiosk ? 'tablet' : 'phone';
  // The address to type is this page's own only when this page is on HTTPS: the app never talks plain
  // HTTP, and over http:// on the LAN this origin is the wrong port as well as the wrong scheme.
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';

  return (
    <div className="wrap">
      <section className="glass-raised setup enter">
        <div className="setup-head">
          <MasjidMark
            name={app?.masjidName ?? ''}
            fallback={
              <div className="emblem">
                {isKiosk ? <Tablet size={28} aria-hidden="true" /> : <Smartphone size={28} aria-hidden="true" />}
              </div>
            }
          />
          <h1 className="setup-title">{isKiosk ? 'Set up your kiosk tablet' : 'Set up a collector’s phone'}</h1>
          <p className="muted">Three quick steps — no technical knowledge needed.</p>
        </div>

        {/* Only a chooser when there is genuinely a choice. */}
        {kioskReady && mobileReady && (
          <div className="app-pick" role="group" aria-label="Which app do you need?">
            <button
              type="button"
              className={`app-pick__opt${isKiosk ? ' app-pick__opt--on' : ''}`}
              aria-pressed={isKiosk}
              onClick={() => setTarget('kiosk')}
            >
              <Tablet size={20} aria-hidden="true" />
              <span className="app-pick__name">Kiosk</span>
              <span className="app-pick__sub">A tablet on the wall, locked to the giving screen</span>
            </button>
            <button
              type="button"
              className={`app-pick__opt${!isKiosk ? ' app-pick__opt--on' : ''}`}
              aria-pressed={!isKiosk}
              onClick={() => setTarget('mobile')}
            >
              <Smartphone size={20} aria-hidden="true" />
              <span className="app-pick__name">Mobile donations</span>
              <span className="app-pick__sub">A phone carried round at a fundraising event</span>
            </button>
          </div>
        )}

        <ol className="setup-steps">
          <li className="setup-step">
            <span className="num">1</span>
            <div className="setup-step__body">
              <div className="setup-step__title">Download the app on the {device}</div>
              <p className="setup-step__sub">
                On the Android {device}, open this page in its browser and tap Download.
              </p>
              <div className="download-row">
                {ready ? (
                  <a className="btn btn--primary" href={href} download={filename}>
                    <Download size={17} aria-hidden="true" /> Download {appName}
                  </a>
                ) : app ? (
                  <>
                    <button className="btn" disabled>
                      <Download size={17} aria-hidden="true" /> Download {appName}
                    </button>
                    <span className="hint">
                      Not included in this install yet — ask whoever looks after OpenMasjidOS to update the Kiosk app.
                    </span>
                  </>
                ) : (
                  // We could not ask which apps this image carries, so say that — not "not included".
                  <>
                    <ResultLine ok={false}>
                      We couldn’t check which apps this server has. Make sure this {device} is on the masjid’s Wi-Fi,
                      then reload the page.
                    </ResultLine>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => window.location.reload()}>
                      <RotateCw size={15} aria-hidden="true" /> Reload the page
                    </button>
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
                When the {device} asks, allow installing apps from your browser, then open the downloaded file to
                install “{appName}”.
              </p>
            </div>
          </li>

          <li className="setup-step">
            <span className="num">3</span>
            <div className="setup-step__body">
              <div className="setup-step__title">Pair it with this server</div>
              <p className="setup-step__sub">
                In the admin panel, go to <b>Devices → Add {isKiosk ? 'kiosk' : 'device'}</b> to get a 6-digit pairing
                code, then type it into the app along with this server’s address (no camera needed — the code expires
                after 10 minutes and works once).
              </p>
              {secure ? (
                <div style={{ marginBlockStart: '0.7rem' }}>
                  <ServerAddress device={device} />
                </div>
              ) : (
                <p className="setup-step__sub">
                  Use the <code dir="ltr">https://</code> address shown in <b>Admin → Devices</b> — the {device} only
                  connects over HTTPS.
                </p>
              )}
              <div className="download-row">
                <div className="pair-hint">
                  {/* One span, so the sentence is ONE flex item. Loose text beside a <b> in a flex box
                      becomes two items, and in a right-to-left page they swap round:
                      "Devices Your 6-digit pairing code will appear in". */}
                  <span>
                    Your 6-digit pairing code will appear in <b>Devices</b>
                  </span>
                </div>
              </div>
            </div>
          </li>
        </ol>

        {!isKiosk && (
          <p className="muted note" style={{ marginBlockStart: '1rem' }}>
            The mobile app does <b>not</b> lock the phone down — it stays an ordinary phone that a volunteer can
            still use. It takes cards with a Stripe Reader M2 over Bluetooth or USB. If this server is reachable at a
            public address, a volunteer can do all three steps from anywhere, without being on the masjid’s Wi-Fi.
          </p>
        )}

        <div className="row" style={{ marginBlockStart: '1.2rem', justifyContent: 'center' }}>
          <button className="btn btn--ghost" onClick={() => navigate('/')}>
            Back to the dashboard
          </button>
        </div>
      </section>
    </div>
  );
}
