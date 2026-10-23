// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Campaigns designer: each appeal is its own giving screen (a tab on the kiosk) with its own
 *  amounts, color, images, monthly/cover-fees, Stripe account and thank-you. The MAIN campaign
 *  always shows on the kiosk (even when hidden) and can't be deleted; others appear only when
 *  live and in the order you set. A live preview mirrors the kiosk as you type. Above the list
 *  sit the kiosk-wide settings (masjid name, name/email prompts). Saving pushes
 *  live: kiosks pick the change up on their next check-in. Amounts are edited in whole/decimal
 *  currency units but stored as integer MINOR units. Non-optimistic — every change re-hydrates
 *  from the server's response. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronUp,
  Megaphone,
  Pencil,
  Plus,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  createCampaign,
  deleteCampaign,
  errorText,
  getCampaigns,
  getGiving,
  reorderCampaigns,
  saveGiving,
  setMainCampaign,
  updateCampaign,
  uploadImage,
  type Campaign,
  type CampaignPatch,
  type CampaignsData,
  type CampaignTheme,
  type CampaignType,
  type GivingSettings,
  type PromptPolicy,
  type StripeAccountRef,
  type TabSize,
} from './api';
import {
  bestInkOn,
  contrastRatio,
  DEFAULT_CAMPAIGN_ACCENT,
  defaultCampaignPrimary,
  INK_BLACK,
  mixHex,
  relLuminance,
  THEME_PRESETS,
} from './contrast';
import { factor, formatMoney, symbolFor, toMajorStr, toMinor } from './money';
import { ResultLine, safeImageUrl, Skeleton, Toggle, useClock } from './ui';

const MAX_PRESETS = 6;

/** Campaign-tab sizes — kept in sync with the kiosk (android GivingHome.kt `tabMetricsFor`).
 *  `medium` is the original hardcoded size, so it's the safe default. font/padX/padY are the
 *  dp/sp values the tablet uses; the web preview reuses them 1:1 as px for a faithful mock. */
const TAB_SIZES: { id: TabSize; label: string; font: number; padX: number; padY: number }[] = [
  { id: 'small', label: 'Small', font: 15, padX: 20, padY: 12 },
  { id: 'medium', label: 'Medium', font: 16, padX: 26, padY: 16 },
  { id: 'large', label: 'Large', font: 22, padX: 34, padY: 22 },
  { id: 'xlarge', label: 'Extra large', font: 28, padX: 46, padY: 30 },
];
/** Campaign title/description limits — kept tight so the tab name and the kiosk header never overflow
 *  or get cut off on the giving screen. */
const TITLE_MAX = 48;
const DESC_MAX = 150;
/** The server's cap on an image address (index.ts campaign schema). Enforced on the box too, so a
 *  pasted address that is too long stops at the limit while typing instead of failing the whole save
 *  with a message that names no field. */
const IMAGE_URL_MAX = 500;

// The colour helpers, the curated THEME_PRESETS and the two default campaign colours live in
// contrast.ts, which is React-free so server/src/ink-contrast.test.ts can prove every preset gets
// readable ink. They used to be private to this file, where no test could reach them.

/** A friendly starting set for a brand-new campaign (major units; the admin edits them). */
const DEFAULT_NEW_PRESETS = ['5', '10', '25', '50', '100'];

/** The campaign editor's tabs — the settings are grouped so the window stays tidy at any size. */
type CampaignTabId = 'design' | 'amounts' | 'type' | 'payments' | 'kiosks' | 'message';
const CAMPAIGN_TABS: { id: CampaignTabId; label: string }[] = [
  { id: 'design', label: 'Design' },
  { id: 'amounts', label: 'Amounts' },
  { id: 'type', label: 'Type & fees' },
  { id: 'payments', label: 'Payments' },
  { id: 'kiosks', label: 'Kiosks' },
  { id: 'message', label: 'Message' },
];

// ── The section ─────────────────────────────────────────────────────────────────
/**
 * Link to the campaign editor's own page. Includes the current path so the href works when the panel
 * is served under a `/<basePath>` prefix (OpenMasjidOS remote access) — a bare "#campaign/x" would
 * resolve against the wrong root once opened in a fresh tab.
 */
export const campaignEditorHref = (id: string) =>
  `${typeof location === 'undefined' ? '' : location.pathname}#campaign/${encodeURIComponent(id)}`;

/**
 * Open the editor in a new tab VIA SCRIPT, so that tab is allowed to close itself again.
 *
 * Browsers only let `window.close()` shut a window a script opened — a tab created by a plain
 * `target="_blank"` link is refused (silently in Chrome, with a console warning in Firefox). Since
 * closing the editor should close its tab, the tab has to be opened this way.
 *
 * Still rendered as a real <a href>, so middle-click, ⌘/Ctrl-click and "Open link in new tab" all keep
 * working and the address is copyable. Those routes bypass this handler, and such a tab simply falls
 * back to showing the campaign list on close (see CampaignEditorPage) rather than failing.
 *
 * Deliberately NOT 'noopener': the new tab is our own origin, and severing the opener is what takes
 * the ability to self-close away again.
 */
export function openCampaignEditor(e: ReactMouseEvent<HTMLAnchorElement>, href: string): void {
  // Let the browser handle anything that already means "somewhere else": a modified click, or a
  // middle/right button.
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const w = window.open(href, '_blank');
  if (w) e.preventDefault(); // only swallow the click if the tab actually opened
}

export function CampaignsSection() {
  const [data, setData] = useState<CampaignsData | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [actErr, setActErr] = useState('');
  const [pending, setPending] = useState(''); // id of the campaign a list action is mutating
  // Where focus goes when the control that had it is gone: a deleted row, or the "Try again" button
  // once the list it was standing in for has loaded. Focusable by script only (tabIndex -1).
  const headingRef = useRef<HTMLHeadingElement>(null);

  const reload = useCallback(async (): Promise<boolean> => {
    try {
      setData(await getCampaigns());
      setLoadErr('');
      return true;
    } catch (e) {
      setLoadErr(errorText(e));
      return false;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A real retry. The failure line used to promise "trying again shortly", but the list only ever
  // loaded once, so an admin waited for something that never came.
  const retry = async () => {
    if (retrying) return; // aria-disabled, not disabled: the button keeps focus while it works
    setRetrying(true);
    const ok = await reload();
    setRetrying(false);
    if (ok) headingRef.current?.focus();
  };

  // Run a list action (make-main / reorder / delete), then re-hydrate from the server. `after` runs
  // only once the action and the re-hydrate have both finished, for moving focus off a row that is gone.
  const runAction = async (id: string, fn: () => Promise<unknown>, after?: () => void) => {
    setActErr('');
    setPending(id);
    try {
      await fn();
      await reload();
      after?.();
    } catch (e) {
      setActErr(errorText(e));
    } finally {
      setPending('');
    }
  };

  // Only non-main campaigns are reorderable; the main stays pinned first.
  const nonMain = useMemo(() => (data?.campaigns ?? []).filter((c) => !c.isMain), [data]);

  const move = (id: string, dir: -1 | 1) => {
    const ids = nonMain.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void runAction(id, () => reorderCampaigns(ids));
  };

  return (
    <>
      <GlobalSettingsCard />

      <section className="glass panel" aria-busy={!data && !loadErr}>
        <div className="card-head">
          <Megaphone size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline" ref={headingRef} tabIndex={-1}>Campaigns</h2>
            <p className="muted">Each appeal is its own giving screen (a tab on the kiosk). Your main campaign always shows first.</p>
          </div>
          {data && (
            <a
              className="btn btn--primary btn--sm"
              style={{ marginInlineStart: 'auto', flex: 'none', whiteSpace: 'nowrap' }}
              href={campaignEditorHref('new')}
              target="_blank"
              onClick={(e) => openCampaignEditor(e, campaignEditorHref('new'))}
            >
              <Plus size={15} aria-hidden="true" /> New campaign
            </a>
          )}
        </div>

        {!data ? (
          loadErr ? (
            <>
              <ResultLine ok={false}>We couldn’t load your campaigns. {loadErr}</ResultLine>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ marginBlockStart: '0.6rem' }}
                aria-disabled={retrying}
                onClick={() => void retry()}
              >
                {retrying ? 'Trying again…' : 'Try again'}
              </button>
            </>
          ) : (
            // Shaped like the rows it stands in for.
            <Skeleton rows={3} height="3.4rem" label="Loading your campaigns…" />
          )
        ) : (
          <>
            {actErr && <ResultLine ok={false}>{actErr}</ResultLine>}
            <div className="camp-list">
              {data.campaigns.map((c) => (
                <CampaignRow
                  key={c.id}
                  c={c}
                  busy={pending === c.id}
                  canUp={!c.isMain && nonMain.length > 1 && nonMain[0].id !== c.id}
                  canDown={!c.isMain && nonMain.length > 1 && nonMain[nonMain.length - 1].id !== c.id}
                  editHref={campaignEditorHref(c.id)}
                  onMakeMain={() => void runAction(c.id, () => setMainCampaign(c.id))}
                  onMoveUp={() => move(c.id, -1)}
                  onMoveDown={() => move(c.id, 1)}
                  // The row, and the button that had focus, disappear with the campaign — so focus goes
                  // to the list's heading rather than falling back to the top of the page.
                  onDelete={() => void runAction(c.id, () => deleteCampaign(c.id), () => headingRef.current?.focus())}
                />
              ))}
            </div>
          </>
        )}
      </section>

    </>
  );
}

// ── Kiosk-wide settings (shared by every campaign) ────────────────────────────────
function GlobalSettingsCard() {
  useClock(); // the amount boxes' currency symbol follows the masjid's locale once it loads
  const [loaded, setLoaded] = useState<GivingSettings | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [retrying, setRetrying] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [masjidName, setMasjidName] = useState('');
  const [namePolicy, setNamePolicy] = useState<PromptPolicy>('optional');
  const [emailPolicy, setEmailPolicy] = useState<PromptPolicy>('optional');
  const [maxBrightness, setMaxBrightness] = useState(true);
  const [footerText, setFooterText] = useState('OpenMasjid Solutions');
  const [tabSize, setTabSize] = useState<TabSize>('medium');
  const [currency, setCurrency] = useState('USD');
  const [largeThreshold, setLargeThreshold] = useState(''); // major units; '' = off
  const [largeNote, setLargeNote] = useState('');
  const [largeImage, setLargeImage] = useState('');
  const [celebrateEnabled, setCelebrateEnabled] = useState(false);
  const [celebrateThreshold, setCelebrateThreshold] = useState(''); // major units; '' = every gift
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const hydrate = useCallback((s: GivingSettings) => {
    setLoaded(s);
    setMasjidName(s.masjidName);
    setNamePolicy(s.giving.namePolicy);
    setEmailPolicy(s.giving.emailPolicy);
    setMaxBrightness(s.giving.maxBrightness !== false);
    setFooterText(s.giving.footerText ?? 'OpenMasjid Solutions');
    setTabSize(s.giving.tabSize ?? 'medium');
    setCurrency(s.currency);
    setLargeThreshold(s.giving.largeAmountThresholdMinor > 0 ? toMajorStr(s.giving.largeAmountThresholdMinor, s.currency) : '');
    setLargeNote(s.giving.largeAmountNote ?? '');
    setLargeImage(s.giving.largeAmountImage ?? '');
    setCelebrateEnabled(s.giving.celebrateEnabled === true);
    setCelebrateThreshold(s.giving.celebrateThresholdMinor > 0 ? toMajorStr(s.giving.celebrateThresholdMinor, s.currency) : '');
  }, []);

  useEffect(() => {
    let alive = true;
    getGiving()
      .then((s) => alive && hydrate(s))
      .catch((e) => alive && setLoadErr(errorText(e)));
    return () => {
      alive = false;
    };
  }, [hydrate]);

  // The failure line used to say "try again shortly" with nothing to press but the browser's reload.
  const retry = async () => {
    if (retrying) return; // aria-disabled, so the button keeps focus while it works
    setRetrying(true);
    try {
      hydrate(await getGiving());
      setLoadErr('');
      // The button is about to be replaced by the form; land on the card's heading, not the page top.
      headingRef.current?.focus();
    } catch (e) {
      setLoadErr(errorText(e));
    } finally {
      setRetrying(false);
    }
  };

  const save = async () => {
    if (busy) return; // aria-disabled rather than disabled, so the pressed button keeps focus
    setErr('');
    setSaved(false);
    setBusy(true);
    try {
      // Only the kiosk-wide subset lives here now; amounts/monthly/thank-you are per-campaign.
      const fresh = await saveGiving({
        masjidName,
        namePolicy,
        emailPolicy,
        maxBrightness,
        footerText,
        tabSize,
        largeAmountThresholdMinor: toMinor(largeThreshold, currency), // 0 when blank = off
        largeAmountNote: largeNote,
        largeAmountImage: largeImage.trim(),
        celebrateEnabled,
        celebrateThresholdMinor: toMinor(celebrateThreshold, currency), // 0 when blank = every gift
      });
      hydrate(fresh);
      setSaved(true);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass panel" aria-busy={!loaded && !loadErr}>
      <div className="card-head">
        <SlidersHorizontal size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline" ref={headingRef} tabIndex={-1}>Kiosk settings</h2>
          <p className="muted">Shared by every campaign. Changes reach your kiosks within a few seconds.</p>
        </div>
      </div>

      {!loaded ? (
        loadErr ? (
          <>
            <ResultLine ok={false}>We couldn’t load these settings. {loadErr}</ResultLine>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ marginBlockStart: '0.6rem' }}
              aria-disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
          </>
        ) : (
          // Shaped like the first few fields it stands in for.
          <Skeleton rows={4} height="2.4rem" widths={['100%', '100%', '70%', '85%']} label="Loading your kiosk settings…" />
        )
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor="g-masjid">Masjid name</label>
            <input id="g-masjid" className="input" value={masjidName} maxLength={160} placeholder="Al-Noor Masjid" onChange={(e) => setMasjidName(e.target.value)} />
          </div>

          <div className="field">
            <label className="label" htmlFor="g-footer">Bottom tagline</label>
            <input id="g-footer" className="input" value={footerText} maxLength={80} placeholder="OpenMasjid Solutions" onChange={(e) => setFooterText(e.target.value)} />
            <p className="hint">Small line at the bottom of the kiosk giving screen. Leave blank to hide it.</p>
          </div>

          <TabSizeField value={tabSize} onChange={setTabSize} />

          <p className="hint" style={{ marginBlock: '0.25rem 0.9rem' }}>
            Donors can always tap “Enter card details” to pay by typing their card — with or without a
            reader connected. (Your Stripe account must have online card payments enabled.)
          </p>

          <div className="row row--top" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
            <PolicyField id="g-name" label="Ask for a name" value={namePolicy} onChange={setNamePolicy} />
            <PolicyField id="g-email" label="Ask for an email" value={emailPolicy} onChange={setEmailPolicy} hint="An email lets Stripe send a receipt." />
          </div>

          <Toggle
            label="Force maximum screen brightness"
            hint="Keeps a wall-mounted tablet as bright as possible so the giving screen is easy to read."
            checked={maxBrightness}
            onChange={setMaxBrightness}
          />

          <div className="field" style={{ marginBlockStart: '0.6rem' }}>
            <span className="label">Large-donation alternative</span>
            <p className="hint" style={{ marginBlockStart: 0 }}>
              Card fees are highest on big gifts. Above the amount you set, the kiosk gently suggests a
              cheaper way to give (like a bank transfer or a Zelle QR code) before the card — the donor
              can still choose to pay by card.
            </p>
            <div className="row row--top" style={{ gap: '0.8rem', flexWrap: 'wrap', marginBlockStart: '0.4rem' }}>
              <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
                <label className="label" htmlFor="g-large">Show it at or above <span className="faint">({currency})</span></label>
                <div className="preset-input">
                  <span className="preset-sym" aria-hidden="true">{symbolFor(currency)}</span>
                  <input
                    id="g-large"
                    className="input"
                    dir="ltr"
                    value={largeThreshold}
                    inputMode="decimal"
                    placeholder="e.g. 250"
                    onChange={(e) => setLargeThreshold(e.target.value.replace(/[^\d.]/g, ''))}
                  />
                </div>
                <span className="hint">Leave blank to never show it.</span>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="g-large-note">What to show the donor</label>
              <textarea
                id="g-large-note"
                className="input"
                rows={3}
                maxLength={600}
                value={largeNote}
                placeholder="e.g. For larger gifts, a bank transfer means more reaches the masjid. Zelle: give@al-noor.org — or scan the code below."
                onChange={(e) => setLargeNote(e.target.value)}
              />
            </div>
            <ImageField
              id="g-large-img"
              label="QR code / image (optional)"
              hint="A Zelle/bank QR code or any image to show on the large-donation screen."
              value={largeImage}
              onChange={setLargeImage}
            />
          </div>

          <Toggle
            label="Celebrate donations with fireworks"
            hint="Plays a short, joyful fireworks animation on the thank-you screen after a successful gift."
            checked={celebrateEnabled}
            onChange={setCelebrateEnabled}
          />
          {celebrateEnabled && (
            <div className="field" style={{ maxWidth: '16rem' }}>
              <label className="label" htmlFor="g-celebrate">Only for gifts of at least <span className="faint">({currency})</span></label>
              <div className="preset-input">
                <span className="preset-sym" aria-hidden="true">{symbolFor(currency)}</span>
                <input
                  id="g-celebrate"
                  className="input"
                  dir="ltr"
                  value={celebrateThreshold}
                  inputMode="decimal"
                  placeholder="e.g. 100"
                  onChange={(e) => setCelebrateThreshold(e.target.value.replace(/[^\d.]/g, ''))}
                />
              </div>
              <span className="hint">Leave blank to celebrate every donation.</span>
            </div>
          )}

          <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap', marginBlockStart: '0.4rem' }}>
            <button className="btn btn--primary" onClick={() => void save()} aria-disabled={busy}>
              {busy ? 'Saving…' : 'Save & push to kiosks'}
            </button>
          </div>
          {/* The outcome, announced as it appears. "Update shortly" is honest: saving reaches the server,
              and each kiosk picks the change up on its next check-in. */}
          {err ? <ResultLine ok={false}>{err}</ResultLine> : saved ? <ResultLine ok>Saved — kiosks update shortly</ResultLine> : null}
        </>
      )}
    </section>
  );
}

// ── Campaign-tab size picker (kiosk-wide) ──────────────────────────────────────────
/** A segmented picker for the campaign-tab size, with a faithful mini preview of the tab strip
 *  (mirrors android GivingHome.kt CampaignTabs: rounded-top browser tabs, color-coded, one filled
 *  "selected"). Tabs only appear on the kiosk when there are 2+ campaigns. */
function TabSizeField({ value, onChange }: { value: TabSize; onChange: (v: TabSize) => void }) {
  const m = TAB_SIZES.find((t) => t.id === value) ?? TAB_SIZES[1];
  const sample = [
    { title: 'General', color: '#0891b2' },
    { title: 'Zakat', color: '#16a34a' },
    { title: 'Building', color: '#d97706' },
  ];
  return (
    <div className="field">
      <span className="label">Campaign tab size</span>
      <p className="hint" style={{ marginBlockStart: 0 }}>
        The size of the tabs across the top of the kiosk. These only appear when you have more than
        one campaign. “Medium” is the standard size.
      </p>
      <div className="ce-tabs" role="group" aria-label="Campaign tab size" style={{ borderBlockEnd: 'none', marginBlock: '0.4rem' }}>
        {TAB_SIZES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`ce-tab${t.id === value ? ' ce-tab--on' : ''}`}
            aria-pressed={t.id === value}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          gap: '0.6rem',
          overflowX: 'auto',
          padding: '0.7rem 0.6rem 0.5rem',
          borderRadius: 'var(--radius-card)',
          background: 'linear-gradient(180deg, #b9e6f2, #7fd4e8)',
        }}
      >
        {sample.map((s, i) => {
          const selected = i === 1;
          return (
            <span
              key={s.title}
              style={{
                flex: 'none',
                fontWeight: 700,
                fontSize: `${m.font}px`,
                lineHeight: 1,
                padding: `${m.padY}px ${m.padX}px`,
                borderRadius: '18px 18px 6px 6px',
                border: `2px solid ${s.color}`,
                background: selected ? s.color : `${s.color}33`,
                // The same inks the tablet draws: on the filled tab, whichever of near-black and white
                // reads better on THAT fill (CampaignTabs uses bestTextOn) — a fixed white measured
                // 3.2–3.7:1 on these very samples, and the kiosk never showed it; off it, the scene ink,
                // which on a light wash like this one is near-black.
                color: selected ? bestInkOn(s.color) : INK_BLACK,
                boxShadow: selected ? '0 6px 14px rgba(0,0,0,0.22)' : 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {s.title}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── One campaign in the list ──────────────────────────────────────────────────────
function CampaignRow({
  c,
  busy,
  canUp,
  canDown,
  editHref,
  onMakeMain,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  c: Campaign;
  busy: boolean;
  canUp: boolean;
  canDown: boolean;
  /** Where the editor lives — a real link, so the browser can open it in a new tab (and the admin
   *  can middle-click / open several appeals side by side). */
  editHref: string;
  onMakeMain: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // An empty accent inherits the default — show the default swatch color so the chip isn't blank.
  // The KIOSK's default, not the viewer's OS accent: the tablet paints a blank accent as cyan whatever
  // the dashboard's theme, so a gold OS accent here would misreport what donors see.
  const swatch = c.accentColor || DEFAULT_CAMPAIGN_ACCENT;

  const deleteRef = useReturnFocus(confirming);
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLAnchorElement>(null);
  // Which control started the action in flight, so focus can go back to it once the list has
  // re-hydrated. Moving a row re-inserts its DOM node, which drops focus; and "Make main" removes its
  // own button, so focus goes to the row's Edit link, which is still there.
  const started = useRef<'up' | 'down' | 'main' | null>(null);
  useEffect(() => {
    if (busy || !started.current) return;
    const which = started.current;
    started.current = null;
    const target = which === 'up' ? upRef.current : which === 'down' ? downRef.current : (mainRef.current ?? editRef.current);
    target?.focus();
  }, [busy]);
  // aria-disabled rather than disabled on every control that can be pressed while a request runs: a
  // disabled button loses focus, and the keyboard user is thrown back to the top of the page.
  const press = (which: 'up' | 'down' | 'main', allowed: boolean, fn: () => void) => () => {
    if (busy || !allowed) return;
    started.current = which;
    fn();
  };

  return (
    <div className="camp-row glass-inset">
      <span className="camp-swatch" style={{ background: swatch }} aria-hidden="true" />
      <div className="camp-row__main">
        <div className="camp-row__title">
          <span className="camp-name">{c.title || 'Untitled campaign'}</span>
          {c.isMain && (
            <span className="badge badge--main">
              <Star size={10} aria-hidden="true" /> Main
            </span>
          )}
          {c.live ? <span className="status-pill status-pill--ok">Live</span> : <span className="status-pill">Hidden</span>}
        </div>
        {c.description ? <span className="camp-desc">{c.description}</span> : null}
      </div>

      <div className="camp-actions">
        {!c.isMain && (
          <span className="camp-reorder">
            <button
              ref={upRef}
              className="icon-btn icon-btn--sm"
              onClick={press('up', canUp, onMoveUp)}
              aria-disabled={busy || !canUp}
              aria-label="Move up"
              title="Move up"
            >
              <ChevronUp size={16} aria-hidden="true" />
            </button>
            <button
              ref={downRef}
              className="icon-btn icon-btn--sm"
              onClick={press('down', canDown, onMoveDown)}
              aria-disabled={busy || !canDown}
              aria-label="Move down"
              title="Move down"
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </span>
        )}
        {!c.isMain && (
          <button
            ref={mainRef}
            className="btn btn--ghost btn--sm"
            onClick={press('main', true, onMakeMain)}
            aria-disabled={busy}
            title="Show this campaign first, always"
          >
            <Star size={14} aria-hidden="true" /> Make main
          </button>
        )}
        <a ref={editRef} className="btn btn--ghost btn--sm" href={editHref} target="_blank" onClick={(e) => openCampaignEditor(e, editHref)}>
          <Pencil size={14} aria-hidden="true" /> Edit
        </a>
        {!c.isMain &&
          (confirming ? (
            <>
              <button className="btn btn--sm device-danger" onClick={() => !busy && onDelete()} aria-disabled={busy}>
                {busy ? 'Deleting…' : 'Yes, delete this campaign'}
              </button>
              {/* Focus lands on the harmless choice, so a double press of Delete cannot delete. */}
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)} disabled={busy} autoFocus>
                Cancel
              </button>
            </>
          ) : (
            <button ref={deleteRef} className="btn btn--ghost btn--sm device-remove-btn" onClick={() => setConfirming(true)}>
              <Trash2 size={14} aria-hidden="true" /> Delete
            </button>
          ))}
      </div>
    </div>
  );
}

/**
 * The Delete button behind a Confirm/Cancel pair, focused again when the pair closes without deleting.
 *
 * The pair REPLACES the button that opened it, so backing out (Cancel, or a failed delete) would
 * otherwise leave focus on nothing and a keyboard user back at the top of the page. A successful delete
 * never gets here: the row, or the whole editor tab, is gone.
 */
function useReturnFocus(open: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) ref.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return ref;
}

// ── The campaign editor (a page with a live preview) ──────────────────────────────
function CampaignEditor({
  campaign,
  currency,
  accounts,
  devices,
  primaryAccountId,
  hasLocal,
  footerText,
  onClose,
  onSaved,
}: {
  campaign: Campaign | null;
  currency: string;
  accounts: StripeAccountRef[];
  devices: { id: string; name: string }[];
  primaryAccountId: string;
  hasLocal: boolean;
  footerText: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  useClock(); // the amount boxes' symbol and the preview's amounts follow the masjid's locale
  const editing = !!campaign;
  const isMain = campaign?.isMain ?? false;

  const [title, setTitle] = useState(campaign?.title ?? '');
  const [type, setType] = useState<CampaignType>(campaign?.type ?? 'donation');
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [presets, setPresets] = useState<string[]>(campaign ? campaign.presetsMinor.map((m) => toMajorStr(m, currency)) : [...DEFAULT_NEW_PRESETS]);
  const [allowCustom, setAllowCustom] = useState(campaign?.allowCustom ?? true);
  const [customMin, setCustomMin] = useState(campaign ? toMajorStr(campaign.customMinMinor, currency) : '1');
  const [customMax, setCustomMax] = useState(campaign ? toMajorStr(campaign.customMaxMinor, currency) : '');
  const [primaryColor, setPrimaryColor] = useState(campaign?.primaryColor ?? '');
  const [accentColor, setAccentColor] = useState(campaign?.accentColor ?? '');
  const [theme, setTheme] = useState<CampaignTheme>(campaign?.theme ?? 'auto');
  const [backgroundImage, setBackgroundImage] = useState(campaign?.backgroundImage ?? '');
  const [coverImage, setCoverImage] = useState(campaign?.coverImage ?? '');
  const [logo, setLogo] = useState(campaign?.logo ?? '');
  const [stripeAccountId, setStripeAccountId] = useState(campaign?.stripeAccountId ?? '');
  // Prune any phantom ids (kiosks that were removed since this campaign was last saved) so the chip UI
  // reflects only real kiosks and can't get stuck in an inconsistent "targeted at a device that no
  // longer exists" state. The server also cleans these up when a device is revoked.
  const [deviceIds, setDeviceIds] = useState<string[]>((campaign?.deviceIds ?? []).filter((id) => devices.some((d) => d.id === id)));
  const [coverFees, setCoverFees] = useState(campaign?.coverFees ?? false);
  const [forceCoverFees, setForceCoverFees] = useState(campaign?.forceCoverFees ?? false);
  const [monthlyEnabled, setMonthlyEnabled] = useState(campaign?.monthlyEnabled ?? true);
  const [thankYou, setThankYou] = useState(campaign?.thankYouMessage ?? '');
  const [live, setLive] = useState(campaign ? campaign.live : true);
  const [tab, setTab] = useState<CampaignTabId>('design');

  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [confirmingDel, setConfirmingDel] = useState(false);
  const [err, setErr] = useState('');
  const deleteRef = useReturnFocus(confirmingDel);
  const tabRefs = useRef<Partial<Record<CampaignTabId, HTMLButtonElement | null>>>({});

  // Keep the local fee state honest with the type→fee rule as the admin switches type, so the labels
  // match what the server will actually save (the server re-derives authoritatively via deriveFees).
  useEffect(() => {
    if (type === 'zakat') {
      setForceCoverFees(true);
      setCoverFees(true);
    } else if (type === 'donation') {
      setForceCoverFees(false);
    }
    // tuition: leave forceCoverFees to the admin's "require" toggle.
  }, [type]);

  // No Escape handler, deliberately. This used to close on Escape "like the Devices logs modal", from
  // when it was a dialog — but it is a page now, and a stray Escape in the title or a hex box threw away
  // every unsaved edit and closed the tab without asking. Escape closes dialogs; nothing on a page.

  // The settings tabs follow the ARIA tabs pattern: one tab stop for the whole strip (roving tabIndex),
  // arrows move between tabs and select as they go, Home/End jump to the ends. The arrows follow the
  // reading direction, so under dir="rtl" the RIGHT arrow walks back along the strip.
  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, from: CampaignTabId) => {
    const n = CAMPAIGN_TABS.length;
    const i = CAMPAIGN_TABS.findIndex((t) => t.id === from);
    const forward = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1;
    let j: number;
    if (e.key === 'ArrowRight') j = i + forward;
    else if (e.key === 'ArrowLeft') j = i - forward;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    else return;
    e.preventDefault();
    const next = CAMPAIGN_TABS[(j + n) % n].id;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const setPreset = (i: number, v: string) => setPresets((ps) => ps.map((p, j) => (j === i ? v.replace(/[^\d.]/g, '') : p)));
  const removePreset = (i: number) => setPresets((ps) => ps.filter((_, j) => j !== i));
  const addPreset = () => setPresets((ps) => (ps.length < MAX_PRESETS ? [...ps, ''] : ps));

  // Live preview amounts (drop blanks/invalid, cap at 6) — recomputed as you type.
  const previewPresets = useMemo(() => presets.map((p) => toMinor(p, currency)).filter((n) => n > 0).slice(0, MAX_PRESETS), [presets, currency]);

  // A non-primary account USED to mean keyed entry only, because a reader is registered to one Stripe
  // account. The kiosk now re-registers the reader onto the campaign's account when someone donates to
  // it, so this is no longer a restriction — just a note that the first tap takes a moment.
  // `hasLocal` still lets the picker mean "the reader account".
  const crossAccount = !!stripeAccountId && stripeAccountId !== primaryAccountId;
  const showAccountPicker = accounts.length > 0 || hasLocal;

  const save = async () => {
    if (busy || del) return; // aria-disabled rather than disabled, so the pressed button keeps focus
    setErr('');
    const t = title.trim();
    if (!t) {
      setErr('Please give this campaign a title.');
      return;
    }
    const presetsMinor = presets.map((p) => toMinor(p, currency)).filter((n) => n > 0);
    // Tuition campaigns have no preset amounts — the balance comes from OpenMasjid Students — so the
    // suggested-amount / custom-bound checks don't apply.
    if (type !== 'tuition' && presetsMinor.length === 0) {
      setTab('amounts'); // surface the offending field even if the admin was on another tab
      setErr('Add at least one suggested amount.');
      return;
    }
    // Blank bounds fall back to one whole unit and ten thousand — scaled by the currency's own minor
    // unit, never a raw 100. As literals these were 0.100 KWD and 1,000 KWD for a Gulf masjid, and
    // ¥100 and ¥1,000,000 for a yen one.
    const min = toMinor(customMin, currency) || factor(currency);
    const max = toMinor(customMax, currency) || 10_000 * factor(currency);
    if (type !== 'tuition' && allowCustom && max < min) {
      setTab('amounts');
      setErr('The maximum custom amount must be at least the minimum.');
      return;
    }
    const patch: CampaignPatch = {
      title: t,
      type,
      description: description.trim(),
      primaryColor,
      accentColor,
      theme,
      backgroundImage: backgroundImage.trim(),
      coverImage: coverImage.trim(),
      logo: logo.trim(),
      presetsMinor,
      allowCustom,
      customMinMinor: min,
      customMaxMinor: max,
      monthlyEnabled,
      // Donation offers coverFees; Zakat/Tuition offer it only when the fee is enforced. The server
      // re-derives this authoritatively (deriveFees) — this just keeps the client in sync.
      coverFees: type === 'donation' ? coverFees : forceCoverFees,
      forceCoverFees,
      thankYouMessage: thankYou,
      deviceIds,
      stripeAccountId,
      live: isMain ? true : live, // the main campaign is always shown
    };
    setBusy(true);
    try {
      if (editing && campaign) await updateCampaign(campaign.id, patch);
      else await createCampaign(patch);
      onSaved(); // parent closes + re-hydrates; this component unmounts
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!campaign || del) return;
    setErr('');
    setDel(true);
    try {
      await deleteCampaign(campaign.id);
      onSaved();
    } catch (e) {
      setErr(errorText(e));
      setDel(false);
      setConfirmingDel(false); // closes the pair; useReturnFocus puts focus back on Delete
    }
  };

  const head = (
    <div className="modal-head">
      <div className="card-head__main">
        <h3 className="section-title-inline">{editing ? 'Edit campaign' : 'New campaign'}</h3>
        <p className="muted">A live preview of the giving screen your kiosks will show.</p>
      </div>
    </div>
  );

  // One frame now: the editor is always a page. It used to be a dialog over the campaign list, which
  // meant a two-column form with a live kiosk preview scrolled inside a box inside a box.
  const shell = (inner: ReactNode) => (
    <div className="ce-page">
      {head}
      {inner}
    </div>
  );

  return shell(
        <div className="modal-body">
          <div className="ce-grid">
            <aside className="ce-preview">
              <p className="hint" style={{ marginBlockEnd: '0.6rem', textAlign: 'center' }}>Live preview — what your kiosks show</p>
              {type === 'tuition' ? (
                <div className="tuition-preview-note">
                  <p className="tuition-preview-title">Tuition appeal</p>
                  <p>
                    On the kiosk this tab asks for the child's <strong>Student ID</strong>, confirms the child's name,
                    then shows the family's balance and invoices to pay — the school details, balances and receipts are
                    managed by <strong>OpenMasjid Students</strong>, not here. There are no preset amounts to design.
                  </p>
                </div>
              ) : (
                <DualPreview
                  title={title}
                  description={description}
                  presetsMinor={previewPresets}
                  allowCustom={allowCustom}
                  // The reader (and so Monthly) can't take a cross-account campaign — mirror the kiosk,
                  // which only offers Monthly when the campaign is reader-capable.
                  monthlyEnabled={monthlyEnabled && !crossAccount}
                  thankYou={thankYou}
                  currency={currency}
                  primaryColor={primaryColor}
                  accentColor={accentColor}
                  theme={theme}
                  backgroundImage={backgroundImage}
                  logo={logo}
                  footerText={footerText}
                />
              )}
            </aside>

            <div className="ce-form">
              <div className="field">
                <label className="label" htmlFor="c-title">Title</label>
                <input id="c-title" className="input" value={title} maxLength={TITLE_MAX} placeholder="e.g. General fund, Zakat, Building fund" onChange={(e) => setTitle(e.target.value)} autoFocus />
                <span className={`char-count ${title.length > TITLE_MAX ? 'form-error' : 'hint'}`}>{title.length}/{TITLE_MAX} — this is the tab name, so keep it short.</span>
              </div>

              <div className="ce-tabs" role="tablist" aria-label="Campaign settings">
                {CAMPAIGN_TABS.map((t) => (
                  <button
                    key={t.id}
                    ref={(el) => {
                      tabRefs.current[t.id] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`ce-tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls="ce-panel"
                    tabIndex={tab === t.id ? 0 : -1}
                    className={`ce-tab${tab === t.id ? ' ce-tab--on' : ''}`}
                    onClick={() => setTab(t.id)}
                    onKeyDown={(e) => onTabKey(e, t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="ce-panel" role="tabpanel" id="ce-panel" aria-labelledby={`ce-tab-${tab}`}>
                {tab === 'design' && (
                  <>
                    <div className="field">
                      <span className="label">Color theme <span className="faint">(presets)</span></span>
                      <div className="theme-presets">
                        {THEME_PRESETS.map((p) => (
                          <button
                            key={p.name}
                            type="button"
                            className={`theme-preset${primaryColor === p.primary && accentColor === p.accent ? ' theme-preset--on' : ''}`}
                            // The ring is not the only sign of the chosen preset: a screen reader hears it too.
                            aria-pressed={primaryColor === p.primary && accentColor === p.accent}
                            title={`${p.name} — sets the colors below (still editable)`}
                            onClick={() => {
                              setPrimaryColor(p.primary);
                              setAccentColor(p.accent);
                            }}
                          >
                            <span className="theme-preset-sw" style={{ background: p.primary }} aria-hidden="true" />
                            <span className="theme-preset-sw" style={{ background: p.accent }} aria-hidden="true" />
                            <span className="theme-preset-name">{p.name}</span>
                          </button>
                        ))}
                      </div>
                      <p className="hint">Pick a preset to fill the two colors below — you can still fine-tune either one.</p>
                    </div>

                    <ColorField
                      id="ce-primary"
                      label="Primary color"
                      sub="(background)"
                      value={primaryColor}
                      fallback={defaultCampaignPrimary(accentColor)}
                      unsetLabel="Using the default background"
                      onChange={setPrimaryColor}
                      hint="Tints the giving screen's background — a soft wash of this color behind the amount tiles."
                    />
                    <ColorField
                      id="ce-accent"
                      label="Accent color"
                      sub="(buttons)"
                      value={accentColor}
                      fallback={DEFAULT_CAMPAIGN_ACCENT}
                      // "the", not "your": a blank accent is the kiosk's fixed default, not the
                      // dashboard's accent — tablets are not themed from OpenMasjidOS.
                      unsetLabel="Using the default accent"
                      onChange={setAccentColor}
                      hint="The color of the “Donate” band on each amount tile, and the buttons."
                    />

                    <div className="field">
                      <label className="label" htmlFor="c-theme">Appearance</label>
                      <select id="c-theme" className="input" value={theme} onChange={(e) => setTheme(e.target.value as CampaignTheme)}>
                        <option value="auto">Auto — bright, or dark over a dark background image</option>
                        <option value="light">Bright (light)</option>
                        <option value="dark">Dark</option>
                      </select>
                      <p className="hint">The kiosk defaults to a bright, vibrant look. Choose Dark for a calm night-time screen.</p>
                    </div>

                    <ImageField id="c-cover" label="Cover image (optional)" hint="Shown on the giving card." value={coverImage} onChange={setCoverImage} />
                    <ImageField id="c-bg" label="Background image (optional)" hint="This tab's full-screen background. Leave empty for the default look." value={backgroundImage} onChange={setBackgroundImage} />
                    {/* The hint used to promise "Leave empty to use your masjid logo", but neither the tablet
                        nor the preview has ever fallen back to one — a blank logo shows nothing and the
                        title leads. Say what actually happens. */}
                    <ImageField id="c-logo" label="Campaign logo (optional)" hint="Shown at the top of this campaign. Leave empty for no logo — the campaign title leads." value={logo} onChange={setLogo} />
                  </>
                )}

                {tab === 'amounts' && (type === 'tuition' ? (
                  <div className="field">
                    <span className="label">Amounts</span>
                    <p className="hint" style={{ lineHeight: 1.55 }}>
                      Tuition amounts come from <strong>OpenMasjid Students</strong> — a parent types their child's
                      Student ID, confirms the name, and pays the balance (or picks specific months). There are no
                      preset amounts to set here.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <span className="label">Suggested amounts <span className="faint">({currency})</span></span>
                      <div className="preset-grid">
                        {presets.map((p, i) => (
                          <div className="preset-input" key={i}>
                            <span className="preset-sym" aria-hidden="true">{symbolFor(currency)}</span>
                            <input className="input" dir="ltr" value={p} inputMode="decimal" aria-label={`Suggested amount ${i + 1}`} onChange={(e) => setPreset(i, e.target.value)} />
                            {/* Numbered like the box beside it: six buttons all called "Remove amount" could not be told apart. */}
                            <button className="preset-rm" onClick={() => removePreset(i)} aria-label={`Remove amount ${i + 1}`} title="Remove">
                              <X size={13} strokeWidth={3} aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                      {presets.length < MAX_PRESETS && (
                        <button className="btn btn--ghost btn--sm" onClick={addPreset} style={{ marginBlockStart: '0.5rem' }}>
                          <Plus size={14} aria-hidden="true" /> Add amount
                        </button>
                      )}
                    </div>

                    <Toggle label="Allow donors to enter their own amount" hint="Shows a “Choose your own amount” number pad on the kiosk." checked={allowCustom} onChange={setAllowCustom} />
                    {allowCustom && (
                      <div className="row row--top" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
                        <div className="field" style={{ flex: 1, minWidth: '8rem' }}>
                          <label className="label" htmlFor="c-min">Minimum custom amount</label>
                          <input id="c-min" className="input" dir="ltr" value={customMin} inputMode="decimal" onChange={(e) => setCustomMin(e.target.value.replace(/[^\d.]/g, ''))} />
                        </div>
                        <div className="field" style={{ flex: 1, minWidth: '8rem' }}>
                          <label className="label" htmlFor="c-max">Maximum custom amount</label>
                          <input id="c-max" className="input" dir="ltr" value={customMax} inputMode="decimal" onChange={(e) => setCustomMax(e.target.value.replace(/[^\d.]/g, ''))} />
                        </div>
                      </div>
                    )}

                    <Toggle
                      label="Offer a monthly (recurring) option"
                      hint="Monthly giving is taken on the card reader, so a donor needs the reader (not a typed card) to set one up."
                      checked={monthlyEnabled}
                      onChange={setMonthlyEnabled}
                    />
                  </>
                ))}

                {tab === 'type' && (
                  <>
                    <div className="field">
                      <label className="label" htmlFor="c-type">Type</label>
                      <select id="c-type" className="input" value={type} onChange={(e) => setType(e.target.value as CampaignType)}>
                        <option value="donation">Donation</option>
                        <option value="zakat">Zakat</option>
                        <option value="tuition">Tuition</option>
                      </select>
                      <p className="hint">
                        {type === 'zakat'
                          ? 'Zakat always covers the card fee, so the full Zakat reaches the masjid.'
                          : type === 'tuition'
                            ? 'For tuition you can require the payer to cover the card fee.'
                            : 'For a donation you can offer donors the option to cover the card fee.'}
                      </p>
                    </div>

                    {type === 'tuition' && (
                      <p className="note-amber">
                        A tuition appeal is powered by <strong>OpenMasjid Students</strong>: the parent types their
                        child's <strong>Student ID</strong> (on their statement), confirms the child's name, and pays
                        the balance on the card reader. Turn it on in OpenMasjidOS and in
                        the Students app (if it's off, the tile stays hidden), and charge it on the{' '}
                        <strong>same Stripe account the school uses in OpenMasjid Students</strong> — that's the
                        reader's account, so tuition lands in the school's account and reconciles there.
                      </p>
                    )}

                    {/* Card-fee control, driven by the campaign type (the server re-derives + enforces it). */}
                    {type === 'zakat' ? (
                      <p className="hint">
                        Card fees are covered by the donor (required for Zakat) — the masjid receives the full Zakat. The kiosk
                        tells the donor the fee is added because it's Zakat.
                      </p>
                    ) : type === 'tuition' ? (
                      <Toggle
                        label="Require the payer to cover the card fee"
                        hint="Adds the card fee (≈2.9% + a small fixed fee) to the payment so the masjid keeps the full amount. Leave off and the masjid absorbs the fee."
                        checked={forceCoverFees}
                        onChange={setForceCoverFees}
                      />
                    ) : (
                      <Toggle
                        label="Offer donors the option to cover card fees"
                        hint="Shows a toggle on the tablet so the donor can add an estimated card fee (≈2.9% + a small fixed fee) — their choice."
                        checked={coverFees}
                        onChange={setCoverFees}
                      />
                    )}
                  </>
                )}

                {tab === 'payments' && (
                  <>
                    {showAccountPicker ? (
                      <div className="field">
                        <label className="label" htmlFor="c-acct">Stripe account</label>
                        <select id="c-acct" className="input" value={stripeAccountId} onChange={(e) => setStripeAccountId(e.target.value)}>
                          <option value="">Primary account — the card reader's (recommended)</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                        {crossAccount && (
                          <p className="hint">
                            The card reader works for this appeal too — it moves onto this account when someone donates,
                            which takes a few seconds the first time. Your main appeal is unaffected.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="hint">
                        No Stripe account is linked yet. Add one in <strong>OpenMasjidOS → Settings → Payments</strong>, then
                        choose it here.
                      </p>
                    )}
                    {/* Two different truths. Linked through OpenMasjidOS, the keys stay in the platform; on a
                        standalone install they were typed into this app's own Settings → Payments and are
                        kept here, so "they never live in this app" would be false. */}
                    {hasLocal ? (
                      <p className="hint">
                        This app is using the Stripe keys entered in <strong>Settings → Payments</strong>. Here you just
                        choose which account this campaign’s donations are paid into.
                      </p>
                    ) : (
                      <p className="hint">
                        Stripe accounts and secret keys are managed in <strong>OpenMasjidOS → Settings → Payments</strong> — they
                        never live in this app. Here you just choose which linked account this campaign’s donations are paid into.
                      </p>
                    )}
                  </>
                )}

                {tab === 'kiosks' && (
                  <>
                    {isMain ? (
                      <p className="hint">Your main campaign always shows on every kiosk.</p>
                    ) : devices.length === 0 ? (
                      <p className="hint">Pair a kiosk (Devices tab) to choose which kiosks show this campaign.</p>
                    ) : (
                      <div className="field">
                        <span className="label">Show on which kiosks</span>
                        <label className="toggle-row" style={{ marginBlockStart: '0.2rem' }}>
                          <span className="toggle-text"><span className="toggle-label">All kiosks</span></span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={deviceIds.length === 0}
                            aria-label="Show on all kiosks"
                            className={`switch${deviceIds.length === 0 ? ' switch--on' : ''}`}
                            onClick={() => setDeviceIds(deviceIds.length === 0 ? devices.map((d) => d.id) : [])}
                          >
                            <span className="switch-knob" />
                          </button>
                        </label>
                        {deviceIds.length > 0 && (
                          <div className="device-pick">
                            {devices.map((d) => {
                              const on = deviceIds.includes(d.id);
                              return (
                                <button
                                  key={d.id}
                                  type="button"
                                  className={`device-chip${on ? ' device-chip--on' : ''}`}
                                  aria-pressed={on}
                                  onClick={() => setDeviceIds(on ? deviceIds.filter((x) => x !== d.id) : [...deviceIds, d.id])}
                                >
                                  {d.name || 'Kiosk'}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <p className="hint">New campaigns show on <strong>all kiosks</strong> by default. Turn that off to pick only the kiosks that should show this appeal — the rest never see it.</p>
                      </div>
                    )}
                  </>
                )}

                {tab === 'message' && (
                  <>
                    <div className="field">
                      <label className="label" htmlFor="c-desc">Description <span className="faint">(optional)</span></label>
                      <textarea id="c-desc" className="input" rows={3} maxLength={DESC_MAX} value={description} placeholder="A short line about this appeal." onChange={(e) => setDescription(e.target.value)} />
                      <span className={`char-count ${description.length > DESC_MAX ? 'form-error' : 'hint'}`}>{description.length}/{DESC_MAX} — keep it brief so it fits the kiosk screen without being cut off.</span>
                    </div>

                    <div className="field">
                      <label className="label" htmlFor="c-thanks">Custom thank-you for this campaign <span className="faint">(optional)</span></label>
                      <textarea id="c-thanks" className="input" rows={2} maxLength={500} value={thankYou} placeholder="Leave blank to use your default thank-you." onChange={(e) => setThankYou(e.target.value)} />
                    </div>
                  </>
                )}
              </div>

              <Toggle
                label="Live (visible to donors)"
                hint={isMain ? 'Your main campaign is always shown, so this stays on.' : 'Hidden campaigns stay off the kiosk until you turn them on.'}
                checked={isMain ? true : live}
                onChange={setLive}
                disabled={isMain}
              />

              {err && <ResultLine ok={false}>{err}</ResultLine>}

              <div className="row-between" style={{ marginBlockStart: '0.6rem' }}>
                {editing && !isMain ? (
                  confirmingDel ? (
                    <div className="row" style={{ gap: '0.4rem' }}>
                      <button className="btn btn--sm device-danger" onClick={() => void remove()} aria-disabled={del}>
                        {del ? 'Deleting…' : 'Yes, delete this campaign'}
                      </button>
                      {/* Focus lands on the harmless choice, so a double press of Delete cannot delete. */}
                      <button className="btn btn--ghost btn--sm" onClick={() => setConfirmingDel(false)} disabled={del} autoFocus>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button ref={deleteRef} className="btn btn--ghost btn--sm device-remove-btn" onClick={() => setConfirmingDel(true)}>
                      <Trash2 size={14} aria-hidden="true" /> Delete
                    </button>
                  )
                ) : (
                  <span />
                )}
                <div className="row" style={{ gap: '0.4rem' }}>
                  <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy || del}>
                    Cancel
                  </button>
                  <button className="btn btn--primary btn--sm" onClick={() => void save()} aria-disabled={busy || del}>
                    {busy ? 'Saving…' : editing ? 'Save campaign' : 'Create campaign'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
  );
}

/**
 * The campaign editor as a PAGE, for its own browser tab (`#campaign/<id>`, or `#campaign/new`).
 *
 * A new tab starts with no React state, so this loads the campaign list itself and picks its one
 * campaign out of it — which also means the URL is shareable and survives a refresh, and an admin can
 * keep several appeals open side by side while comparing them.
 */
export function CampaignEditorPage({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<CampaignsData | null>(null);
  const [err, setErr] = useState('');
  const [retrying, setRetrying] = useState(false);
  const isNew = campaignId === 'new';

  useEffect(() => {
    let alive = true;
    getCampaigns()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Stays on the error view while it works (the button keeps focus); on success the editor replaces it
  // and its title box takes focus, which is where anyone opening an editor wants to be.
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      setData(await getCampaigns());
      setErr('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setRetrying(false);
    }
  };

  // Closing or saving returns this tab to the campaign list. window.close() only works for a tab the
  // page opened itself, so it is never relied on — navigating always works, whether this is a second
  // tab or the admin followed the link in place.
  const backToList = () => {
    // The editor lives in its own tab, so "Cancel"/"Save" should close it rather than leave the admin
    // staring at a second copy of the dashboard. window.close() is refused for a tab the browser
    // opened itself (a middle-click, or a pasted URL) — so check whether we are still here a moment
    // later and fall back to the campaign list, which is the only sensible place left to be.
    window.close();
    window.setTimeout(() => {
      if (!window.closed) location.hash = 'giving';
    }, 150);
  };

  if (err) {
    return (
      <section className="panel glass">
        <ResultLine ok={false}>We couldn’t open this campaign. {err}</ResultLine>
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
          <button type="button" className="btn btn--ghost btn--sm" aria-disabled={retrying} onClick={() => void retry()}>
            {retrying ? 'Trying again…' : 'Try again'}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={backToList}>Back to campaigns</button>
        </div>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel glass" aria-busy="true">
        {/* Shaped like the editor: its heading, the wide preview, then the first fields. */}
        <Skeleton rows={4} height="3rem" widths={['40%', '100%', '100%', '70%']} label="Opening the campaign…" />
      </section>
    );
  }

  const campaign = isNew ? null : data.campaigns.find((c) => c.id === campaignId) ?? null;
  if (!isNew && !campaign) {
    return (
      <section className="panel glass">
        <p className="empty-title">That campaign no longer exists</p>
        <p className="muted">It may have been deleted in another tab.</p>
        <button className="btn btn--ghost btn--sm" onClick={backToList}>Back to campaigns</button>
      </section>
    );
  }

  return (
    <CampaignEditor
      campaign={campaign}
      currency={data.currency}
      accounts={data.accounts}
      devices={data.devices}
      primaryAccountId={data.primaryAccountId}
      hasLocal={data.hasLocal}
      footerText={data.footerText}
      onClose={backToList}
      onSaved={backToList}
    />
  );
}

/**
 * A color with a swatch AND a typed hex, so a masjid can use its OWN brand color.
 *
 * The swatch alone was the whole control before, which meant any color was technically reachable but
 * only by hunting for it in the OS picker — there was no way to enter the hex a masjid already has
 * written down, and next to a grid of presets the whole thing read as "presets only".
 *
 * The text box is free while you type (you cannot enter "#1f7a5c" without passing through "#1", "#1f"
 * …), so it keeps its own draft and only commits when the value is a real color. Leaving it empty
 * clears back to the default rather than committing a broken value.
 */
function ColorField({
  id,
  label,
  sub,
  value,
  fallback,
  unsetLabel,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  sub?: string;
  value: string;
  fallback: string;
  unsetLabel: string;
  onChange: (v: string) => void;
  hint: string;
}) {
  const [draft, setDraft] = useState(value);
  // Follow the value when it changes from OUTSIDE this field (a preset was clicked, or Reset).
  useEffect(() => setDraft(value), [value]);

  const normalize = (raw: string): string | null => {
    const v = raw.trim().replace(/^#?/, '#');
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    // Accept the 3-digit shorthand people copy from CSS, expanded to the 6 the picker needs.
    if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase();
    return null;
  };
  const commit = (raw: string) => {
    if (!raw.trim()) return onChange(''); // cleared → back to the default
    const hex = normalize(raw);
    if (hex) onChange(hex);
    else setDraft(value); // not a color — snap back rather than keep something unusable
  };
  const bad = draft.trim() !== '' && normalize(draft) === null;

  return (
    <div className="field">
      <span className="label">{label} {sub && <span className="faint">{sub}</span>}</span>
      <div className="accent-row">
        <input
          type="color"
          className="accent-swatch-input"
          aria-label={`${label} — pick`}
          value={normalize(draft) || normalize(value) || normalize(fallback) || '#000000'}
          onChange={(e) => { setDraft(e.target.value); onChange(e.target.value); }}
        />
        <input
          id={id}
          className="input color-hex"
          dir="ltr"
          value={draft}
          spellCheck={false}
          placeholder={fallback}
          aria-label={`${label} — hex code`}
          aria-invalid={bad}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit((e.target as HTMLInputElement).value); } }}
        />
        {value ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange('')}>Reset to default</button>
        ) : (
          <span className="hint" style={{ margin: 0 }}>{unsetLabel}</span>
        )}
      </div>
      {bad && <p className="form-error">Use a hex color like #1f7a5c.</p>}
      <p className="hint">{hint}</p>
    </div>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────────────
// (The on/off switch is ui.tsx's Toggle, shared with the rest of the panel, which also ties each
// switch to its hint so a screen reader hears what the setting does.)

function PolicyField({ id, label, value, onChange, hint }: { id: string; label: string; value: PromptPolicy; onChange: (v: PromptPolicy) => void; hint?: string }) {
  return (
    <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as PromptPolicy)}>
        <option value="off">Don't ask</option>
        <option value="optional">Optional</option>
        <option value="required">Required</option>
      </select>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** An image input that accepts a URL OR an uploaded file (stored on the data volume). URLs and
 *  uploads are sanitized before they're shown as an <img>/CSS background. */
function ImageField({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = safeImageUrl(value);
  // The field's own name, for the upload button and the thumbnail. Three of these sit on the Design tab,
  // and three buttons all called "Upload" cannot be told apart by anyone who cannot see which box each
  // one is beside.
  const name = label.replace(/\s*\(optional\)\s*$/i, '');

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!f) return;
    setBusy(true);
    setErr('');
    try {
      onChange(await uploadImage(f));
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="img-field">
        {preview && <img className="img-preview" src={preview} alt={`${name} preview`} />}
        {/* Upload leads: an uploaded file is served by this app, so it never depends on a third-party
            host (or on the masjid's network reaching one). A pasted address still works. */}
        <input
          id={id}
          className="input"
          dir="ltr"
          value={value}
          maxLength={IMAGE_URL_MAX}
          placeholder="Upload a file, or paste an image address"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label={busy ? `Uploading ${name}…` : `Upload ${name}`}
          // aria-disabled, not disabled: focus comes back here from the file picker, and a disabled
          // button would drop it while the upload runs.
          aria-disabled={busy}
          onClick={() => !busy && inputRef.current?.click()}
        >
          {busy ? (
            'Uploading…'
          ) : (
            <>
              <Upload size={14} aria-hidden="true" /> Upload
            </>
          )}
        </button>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={onFile} />
      </div>
      {err ? <ResultLine ok={false}>{err}</ResultLine> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

// ── Faithful giving-screen preview (mirrors the Android kiosk exactly) ─────────────
// These are the kiosk's own colors (android/.../GivingHome.kt `sceneStyleFor` + AmountTile), kept in
// sync so the admin sees the real thing: white glassy tiles with big BLACK numbers on a bright primary
// wash, or a calm dark scene with elevated tiles when the campaign is Dark / has a background image.
// INK_BLACK (the tablet's InkBlack) comes from contrast.ts with the rest of the ink arithmetic.
const INK_DARK = '#f4f7fb'; // near-white (core Color.kt InkDark)
const INK_MUTED_DARK = '#aebacd'; // core Color.kt InkMutedDark
const SURFACE_OVERLAY_DARK = '#0f2040';
/** The dark scene's middle stop (core Color.kt SceneMid): what text on the dark scene is measured
 *  against, as the tablet does. */
const SCENE_MID = '#082230';
const SCENE_DARK = `linear-gradient(155deg, #0c3a4d, ${SCENE_MID} 60%, #020a12)`;
/** WCAG AA for body text — the bar the accent has to clear to be used as text on the scene. */
const AA_TEXT = 4.5;

type Scene = {
  accent: string;
  /** Ink ON a filled accent (the "Donate" band, the selected One-time segment). */
  onAccent: string;
  /** The accent where it is drawn as TEXT on the scene itself: the accent when it reads there, the
   *  scene ink when it does not. The tablet uses it for the amount being charged and the "hold your
   *  card" line; nothing in this scale model draws accent text yet, but it is resolved here, from the
   *  same rule, so the day something does it cannot quietly pick a different one. */
  accentInk: string;
  onScene: string;
  onSceneMuted: string;
  tile: string;
  tileInk: string;
  tileBorder: string;
  tileShadow: string;
  background: string;
  bgCover: boolean;
};

/** Resolve the giving-screen color set from the campaign, exactly as the tablet does (bright primary
 *  wash with white tiles + black numbers, or the calm dark scene with elevated tiles).
 *
 *  A line-for-line port of GivingHome.kt `sceneStyleFor`: change one, change the other. CONTRAST IS
 *  COMPUTED, NOT ASSUMED — every ink is picked against what it is actually painted on, so any campaign
 *  color a masjid chooses stays readable. `mixHex` blends in sRGB where Compose's `lerp` blends in
 *  Oklab, so a blended shade can differ by a hair; the inks, which are what AA depends on, match. */
function computeScene(primaryColor: string, accentColor: string, theme: CampaignTheme, bgUrl: string): Scene {
  const accent = accentColor || DEFAULT_CAMPAIGN_ACCENT;
  // Whichever of near-black and white reads better on the accent fill. This was `luminance > 0.4 ?
  // dark : white`, copied from the tablet, which is exactly wrong between L≈0.18 and 0.4: five of the
  // editor's own eight presets drew white at 2.6–3.7:1. Both sides now use the same bestInkOn rule.
  const onAccent = bestInkOn(accent);
  const bright = !bgUrl && theme !== 'dark';
  if (!bright) {
    // Dark theme, or a background image → the calm dark scene, light text on solid elevated tiles.
    const onScene = INK_DARK;
    return {
      accent,
      onAccent,
      accentInk: contrastRatio(accent, SCENE_MID) >= AA_TEXT ? accent : onScene,
      onScene,
      // Brighter than the dashboard's muted ink, as on the tablet: halfway back toward the main ink.
      onSceneMuted: mixHex(INK_MUTED_DARK, INK_DARK, 0.5),
      tile: SURFACE_OVERLAY_DARK,
      tileInk: INK_DARK,
      tileBorder: 'rgba(255,255,255,0.08)',
      tileShadow: 'none',
      background: bgUrl ? `linear-gradient(rgba(4,14,20,0.5), rgba(4,14,20,0.68)), url("${bgUrl}")` : SCENE_DARK,
      bgCover: !!bgUrl,
    };
  }
  // Bright: a soft PRIMARY-color wash. A light base → dark text; a darker base → a deepened wash and
  // whichever ink wins on that base (the gradient's mid stop). It used to be white regardless, which is
  // not what the tablet draws on a mid-tone primary. Tiles are white with big black numbers either way.
  const sceneBase = primaryColor || defaultCampaignPrimary(accent);
  const lightScene = relLuminance(sceneBase) > 0.35;
  const onScene = lightScene ? INK_BLACK : bestInkOn(sceneBase);
  return {
    accent,
    onAccent,
    accentInk: contrastRatio(accent, sceneBase) >= AA_TEXT ? accent : onScene,
    onScene,
    // Secondary text is a step down from the heading — 12% toward the background, never a washed-out
    // grey — so it keeps the hierarchy and the legibility (the tablet's rule).
    onSceneMuted: mixHex(onScene, sceneBase, 0.12),
    tile: 'rgba(255,255,255,0.92)',
    tileInk: INK_BLACK,
    tileBorder: 'rgba(0,0,0,0.06)',
    tileShadow: '0 6px 14px rgba(0,0,0,0.14)',
    background: lightScene
      ? `linear-gradient(180deg, ${mixHex(sceneBase, '#ffffff', 0.45)}, ${sceneBase}, ${mixHex(sceneBase, '#ffffff', 0.12)})`
      : `linear-gradient(180deg, ${mixHex(sceneBase, '#000000', 0.06)}, ${sceneBase}, ${mixHex(sceneBase, '#000000', 0.28)})`,
    bgCover: false,
  };
}

/** One orientation of the kiosk giving screen, laid out and colored like the tablet. Container queries
 *  size everything to the frame, so the same markup reads right at any preview size — a true scale
 *  model of the mounted tablet, including the portrait 1–2 / landscape 2–3 column split. */
function GivingPreview({
  orientation,
  scene,
  title,
  description,
  presetsMinor,
  allowCustom,
  monthlyEnabled,
  currency,
  logo,
  footerText,
}: {
  orientation: 'portrait' | 'landscape';
  scene: Scene;
  title: string;
  description: string;
  presetsMinor: number[];
  allowCustom: boolean;
  monthlyEnabled: boolean;
  currency: string;
  logo: string;
  footerText: string;
}) {
  useClock(); // the tile amounts are formatted in the masjid's locale
  const portrait = orientation === 'portrait';
  const safeLogo = safeImageUrl(logo);
  const n = presetsMinor.length;
  const cols = portrait ? (n <= 2 ? 1 : 2) : n <= 4 ? 2 : 3;
  const screenStyle: CSSProperties = {
    background: scene.background,
    color: scene.onScene,
    ...(scene.bgCover ? { backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' } : {}),
  };
  return (
    <figure className={`gv-frame gv-frame--${orientation}`}>
      <div className="gv-screen" style={screenStyle}>
        {safeLogo && <img className="gv-logo" src={safeLogo} alt="" />}
        <div className="gv-title" style={{ color: scene.onScene }}>
          {title.trim() || 'Support your masjid'}
        </div>
        <div className="gv-desc" style={{ color: scene.onSceneMuted }}>
          {description.trim() || 'Choose an amount to give'}
        </div>
        {monthlyEnabled && (
          <div className="gv-seg" style={{ color: scene.onScene }}>
            <span className="gv-seg__opt gv-seg__opt--on" style={{ background: scene.accent, color: scene.onAccent }}>
              One-time
            </span>
            <span className="gv-seg__opt" style={{ color: scene.onScene }}>Monthly</span>
          </div>
        )}
        <div className="gv-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {n === 0 ? (
            <div className="gv-empty" style={{ color: scene.onSceneMuted }}>Add an amount to see it here</div>
          ) : (
            presetsMinor.map((m, i) => (
              <div
                className="gv-tile"
                key={i}
                style={{ background: scene.tile, boxShadow: `inset 0 0 0 1px ${scene.tileBorder}, ${scene.tileShadow}` }}
              >
                <span className="gv-tile-amt" style={{ color: scene.tileInk }}>{formatMoney(m, currency)}</span>
                <span className="gv-tile-donate" style={{ background: scene.accent, color: scene.onAccent }}>Donate</span>
              </div>
            ))
          )}
        </div>
        {allowCustom && (
          <div className="gv-pill" style={{ color: scene.onScene, borderColor: scene.accent }}>
            Choose your own amount
          </div>
        )}
        {footerText.trim() && (
          <div className="gv-footer" style={{ color: scene.onSceneMuted }}>{footerText.trim()}</div>
        )}
      </div>
      <figcaption className="gv-cap">{portrait ? 'Portrait' : 'Landscape'}</figcaption>
    </figure>
  );
}

/** Both orientations side-by-side, colored from the campaign — a true-to-device look at what each
 *  mounted tablet will show (a kiosk shows one, chosen by its Rotate-screen setting in Devices). */
function DualPreview(props: {
  title: string;
  description: string;
  presetsMinor: number[];
  allowCustom: boolean;
  monthlyEnabled: boolean;
  thankYou: string;
  currency: string;
  primaryColor: string;
  accentColor: string;
  theme: CampaignTheme;
  backgroundImage: string;
  logo: string;
  footerText: string;
}) {
  const scene = computeScene(props.primaryColor, props.accentColor, props.theme, safeImageUrl(props.backgroundImage));
  const shared = {
    scene,
    title: props.title,
    description: props.description,
    presetsMinor: props.presetsMinor,
    allowCustom: props.allowCustom,
    monthlyEnabled: props.monthlyEnabled,
    currency: props.currency,
    logo: props.logo,
    footerText: props.footerText,
  };
  return (
    <div className="gv-previews" aria-hidden="true">
      <div className="gv-row">
        <GivingPreview orientation="landscape" {...shared} />
        <GivingPreview orientation="portrait" {...shared} />
      </div>
      <div className="gv-thanks">
        <span className="gv-check">✓</span>{' '}
        {props.thankYou.trim() || 'JazākAllāhu khayran — thank you for your generous donation.'}
      </div>
    </div>
  );
}
