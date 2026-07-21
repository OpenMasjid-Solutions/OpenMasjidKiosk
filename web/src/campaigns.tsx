// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** The Campaigns designer: each appeal is its own giving screen (a tab on the kiosk) with its own
 *  amounts, colour, images, monthly/cover-fees, Stripe account and thank-you. The MAIN campaign
 *  always shows on the kiosk (even when hidden) and can't be deleted; others appear only when
 *  live and in the order you set. A live preview mirrors the kiosk as you type. Above the list
 *  sit the kiosk-wide settings (masjid name, name/email prompts). Saving pushes
 *  live: kiosks pick the change up on their next check-in. Amounts are edited in whole/decimal
 *  currency units but stored as integer MINOR units. Non-optimistic — every change re-hydrates
 *  from the server's response. */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
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
} from './api';
import { formatMoney, symbolFor, toMajorStr, toMinor } from './money';
import { safeImageUrl } from './ui';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

const MAX_PRESETS = 6;
/** Campaign title/description limits — kept tight so the tab name and the kiosk header never overflow
 *  or get cut off on the giving screen. */
const TITLE_MAX = 48;
const DESC_MAX = 150;
/** Shown in the colour picker while a campaign inherits the default accent (it needs a value). */
const DEFAULT_ACCENT = '#22d3ee';
/** Shown in the primary-colour picker while a campaign inherits the default background. */
const DEFAULT_PRIMARY = '#a8f2b7';

/** Curated theme presets — a primary (background) + accent (buttons) that go well together. Picking
 *  one just POPULATES the two colour fields; the admin can still tweak either afterwards. */
const THEME_PRESETS: { name: string; primary: string; accent: string }[] = [
  { name: 'Emerald', primary: '#a8f2b7', accent: '#1fa37a' },
  { name: 'Ocean', primary: '#bfe3ff', accent: '#2563eb' },
  { name: 'Sunset', primary: '#ffd9b3', accent: '#ea580c' },
  { name: 'Royal', primary: '#e0d4ff', accent: '#7c3aed' },
  { name: 'Rose', primary: '#ffd6e5', accent: '#e11d63' },
  { name: 'Gold', primary: '#fdeec2', accent: '#c99a2e' },
  { name: 'Teal', primary: '#bff2ee', accent: '#0d9488' },
  { name: 'Midnight', primary: '#1e293b', accent: '#38bdf8' },
];

// ── Colour helpers (mirror the kiosk's scene logic so the preview matches the device) ─────────────
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Mix `hex` toward `toward` by fraction `t` (0..1), returning a #rrggbb string. */
function mixHex(hex: string, toward: string, t: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  if (!a || !b) return hex;
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}
/** WCAG relative luminance of a #rrggbb colour (0 = black, 1 = white). */
function relLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
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
export function CampaignsSection() {
  const [data, setData] = useState<CampaignsData | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [actErr, setActErr] = useState('');
  const [pending, setPending] = useState(''); // id of the campaign a list action is mutating
  // Editor: `undefined` = closed, `null` = a new campaign, a Campaign = editing that one.
  const [editor, setEditor] = useState<Campaign | null | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setData(await getCampaigns());
      setLoadErr('');
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Run a list action (make-main / reorder / delete), then re-hydrate from the server.
  const runAction = async (id: string, fn: () => Promise<unknown>) => {
    setActErr('');
    setPending(id);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActErr(errMsg(e));
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

      <section className="glass panel">
        <div className="card-head">
          <Megaphone size={18} className="panel-ico" aria-hidden="true" />
          <div className="card-head__main">
            <h2 className="section-title-inline">Campaigns</h2>
            <p className="muted">Each appeal is its own giving screen (a tab on the kiosk). Your main campaign always shows first.</p>
          </div>
          {data && (
            <button className="btn btn--primary btn--sm" style={{ marginInlineStart: 'auto' }} onClick={() => setEditor(null)}>
              <Plus size={15} /> New campaign
            </button>
          )}
        </div>

        {!data ? (
          loadErr ? (
            <p className="hint">We couldn't load your campaigns just now — trying again shortly.</p>
          ) : (
            <p className="muted">Loading…</p>
          )
        ) : (
          <>
            {actErr && <p className="form-error">{actErr}</p>}
            <div className="camp-list">
              {data.campaigns.map((c) => (
                <CampaignRow
                  key={c.id}
                  c={c}
                  busy={pending === c.id}
                  canUp={!c.isMain && nonMain.length > 1 && nonMain[0].id !== c.id}
                  canDown={!c.isMain && nonMain.length > 1 && nonMain[nonMain.length - 1].id !== c.id}
                  onEdit={() => setEditor(c)}
                  onMakeMain={() => void runAction(c.id, () => setMainCampaign(c.id))}
                  onMoveUp={() => move(c.id, -1)}
                  onMoveDown={() => move(c.id, 1)}
                  onDelete={() => void runAction(c.id, () => deleteCampaign(c.id))}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {editor !== undefined && data && (
        <CampaignEditor
          key={editor ? editor.id : 'new'}
          campaign={editor}
          currency={data.currency}
          accounts={data.accounts}
          devices={data.devices}
          primaryAccountId={data.primaryAccountId}
          hasLocal={data.hasLocal}
          footerText={data.footerText}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            void reload();
          }}
        />
      )}
    </>
  );
}

// ── Kiosk-wide settings (shared by every campaign) ────────────────────────────────
function GlobalSettingsCard() {
  const [loaded, setLoaded] = useState<GivingSettings | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [masjidName, setMasjidName] = useState('');
  const [namePolicy, setNamePolicy] = useState<PromptPolicy>('optional');
  const [emailPolicy, setEmailPolicy] = useState<PromptPolicy>('optional');
  const [maxBrightness, setMaxBrightness] = useState(true);
  const [footerText, setFooterText] = useState('OpenMasjid Solutions');
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
      .catch((e) => alive && setLoadErr(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [hydrate]);

  const save = async () => {
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
        largeAmountThresholdMinor: toMinor(largeThreshold, currency), // 0 when blank = off
        largeAmountNote: largeNote,
        largeAmountImage: largeImage.trim(),
        celebrateEnabled,
        celebrateThresholdMinor: toMinor(celebrateThreshold, currency), // 0 when blank = every gift
      });
      hydrate(fresh);
      setSaved(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <SlidersHorizontal size={18} className="panel-ico" aria-hidden="true" />
        <div className="card-head__main">
          <h2 className="section-title-inline">Kiosk settings</h2>
          <p className="muted">Shared by every campaign. Changes reach your kiosks within a few seconds.</p>
        </div>
      </div>

      {!loaded ? (
        loadErr ? (
          <p className="hint">Couldn't load these settings just now — try again shortly.</p>
        ) : (
          <p className="muted">Loading…</p>
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

          <p className="hint" style={{ marginTop: '0.25rem' }}>
            Donors can always tap “Enter card details” to pay by typing their card — with or without a
            reader connected. (Your Stripe account must have online card payments enabled.)
          </p>

          <div className="row" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
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
            <div className="row" style={{ gap: '0.8rem', flexWrap: 'wrap', marginBlockStart: '0.4rem' }}>
              <div className="field" style={{ flex: 1, minWidth: '10rem' }}>
                <label className="label" htmlFor="g-large">Show it at or above <span className="faint">({currency})</span></label>
                <div className="preset-input">
                  <span className="preset-sym" aria-hidden="true">{symbolFor(currency) || currency}</span>
                  <input
                    id="g-large"
                    className="input"
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
                <span className="preset-sym" aria-hidden="true">{symbolFor(currency) || currency}</span>
                <input
                  id="g-celebrate"
                  className="input"
                  value={celebrateThreshold}
                  inputMode="decimal"
                  placeholder="e.g. 100"
                  onChange={(e) => setCelebrateThreshold(e.target.value.replace(/[^\d.]/g, ''))}
                />
              </div>
              <span className="hint">Leave blank to celebrate every donation.</span>
            </div>
          )}

          {err && <p className="form-error">{err}</p>}
          <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap', marginBlockStart: '0.4rem' }}>
            <button className="btn btn--primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save & push to kiosks'}
            </button>
            {saved && (
              <span className="status-pill status-pill--ok">
                <CheckCircle2 size={14} /> Saved — kiosks update shortly
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ── One campaign in the list ──────────────────────────────────────────────────────
function CampaignRow({
  c,
  busy,
  canUp,
  canDown,
  onEdit,
  onMakeMain,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  c: Campaign;
  busy: boolean;
  canUp: boolean;
  canDown: boolean;
  onEdit: () => void;
  onMakeMain: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // An empty accent inherits the default — show the default swatch colour so the chip isn't blank.
  const swatch = c.accentColor || 'var(--color-primary)';

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
            <button className="icon-btn icon-btn--sm" onClick={onMoveUp} disabled={busy || !canUp} aria-label="Move up" title="Move up">
              <ChevronUp size={16} />
            </button>
            <button className="icon-btn icon-btn--sm" onClick={onMoveDown} disabled={busy || !canDown} aria-label="Move down" title="Move down">
              <ChevronDown size={16} />
            </button>
          </span>
        )}
        {!c.isMain && (
          <button className="btn btn--ghost btn--sm" onClick={onMakeMain} disabled={busy} title="Show this campaign first, always">
            <Star size={14} aria-hidden="true" /> Make main
          </button>
        )}
        <button className="btn btn--ghost btn--sm" onClick={onEdit}>
          <Pencil size={14} aria-hidden="true" /> Edit
        </button>
        {!c.isMain &&
          (confirming ? (
            <>
              <button className="btn btn--sm device-danger" onClick={onDelete} disabled={busy}>
                {busy ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn--ghost btn--sm device-remove-btn" onClick={() => setConfirming(true)}>
              <Trash2 size={14} aria-hidden="true" /> Delete
            </button>
          ))}
      </div>
    </div>
  );
}

// ── The campaign editor (modal with a live preview) ───────────────────────────────
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

  // Close on Escape (matches the Devices logs modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setPreset = (i: number, v: string) => setPresets((ps) => ps.map((p, j) => (j === i ? v.replace(/[^\d.]/g, '') : p)));
  const removePreset = (i: number) => setPresets((ps) => ps.filter((_, j) => j !== i));
  const addPreset = () => setPresets((ps) => (ps.length < MAX_PRESETS ? [...ps, ''] : ps));

  // Live preview amounts (drop blanks/invalid, cap at 6) — recomputed as you type.
  const previewPresets = useMemo(() => presets.map((p) => toMinor(p, currency)).filter((n) => n > 0).slice(0, MAX_PRESETS), [presets, currency]);

  // A non-primary account can't use the reader (it's registered to the primary account), so that
  // appeal is taken by keyed card entry. `hasLocal` still lets the picker mean "the reader account".
  const crossAccount = !!stripeAccountId && stripeAccountId !== primaryAccountId;
  const showAccountPicker = accounts.length > 0 || hasLocal;

  const save = async () => {
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
    const min = toMinor(customMin, currency) || 100;
    const max = toMinor(customMax, currency) || 1_000_000;
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
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!campaign) return;
    setErr('');
    setDel(true);
    try {
      await deleteCampaign(campaign.id);
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
      setDel(false);
      setConfirmingDel(false);
    }
  };

  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={editing ? 'Edit campaign' : 'New campaign'} onClick={onClose}>
      <div className="modal modal--form glass-raised" onClick={(e) => e.stopPropagation()}>
        <div className="tl-bar">
          <button className="tl tl--red" onClick={onClose} aria-label="Close">
            <X size={9} strokeWidth={3} />
          </button>
          <span className="tl tl--amber" aria-hidden="true" />
        </div>
        <div className="modal-head">
          <div className="card-head__main">
            <h3 className="section-title-inline">{editing ? 'Edit campaign' : 'New campaign'}</h3>
            <p className="muted">A live preview of the giving screen your kiosks will show.</p>
          </div>
        </div>

        <div className="modal-body">
          <div className="ce-grid">
            <aside className="ce-preview">
              <p className="hint" style={{ marginBlockEnd: '0.6rem', textAlign: 'center' }}>Live preview — what your kiosks show</p>
              {type === 'tuition' ? (
                <div className="tuition-preview-note">
                  <p className="tuition-preview-title">Tuition appeal</p>
                  <p>
                    On the kiosk this tab shows a <strong>name + PIN</strong> lookup, then the family's balance and
                    invoices to pay — the school details, balances and receipts are managed by <strong>OpenMasjid
                    Students</strong>, not here. There are no preset amounts to design.
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
                <span className={title.length > TITLE_MAX ? 'form-error' : 'hint'} style={{ textAlign: 'end' }}>{title.length}/{TITLE_MAX} — this is the tab name, so keep it short.</span>
              </div>

              <div className="ce-tabs" role="tablist" aria-label="Campaign settings">
                {CAMPAIGN_TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    className={`ce-tab${tab === t.id ? ' ce-tab--on' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="ce-panel" role="tabpanel">
                {tab === 'design' && (
                  <>
                    <div className="field">
                      <span className="label">Colour theme <span className="faint">(presets)</span></span>
                      <div className="theme-presets">
                        {THEME_PRESETS.map((p) => (
                          <button
                            key={p.name}
                            type="button"
                            className={`theme-preset${primaryColor === p.primary && accentColor === p.accent ? ' theme-preset--on' : ''}`}
                            title={`${p.name} — sets the colours below (still editable)`}
                            onClick={() => {
                              setPrimaryColor(p.primary);
                              setAccentColor(p.accent);
                            }}
                          >
                            <span className="theme-preset-sw" style={{ background: p.primary }} />
                            <span className="theme-preset-sw" style={{ background: p.accent }} />
                            <span className="theme-preset-name">{p.name}</span>
                          </button>
                        ))}
                      </div>
                      <p className="hint">Pick a preset to fill the two colours below — you can still fine-tune either one.</p>
                    </div>

                    <div className="field">
                      <span className="label">Primary colour <span className="faint">(background)</span></span>
                      <div className="accent-row">
                        <input type="color" className="accent-swatch-input" aria-label="Primary colour" value={primaryColor || DEFAULT_PRIMARY} onChange={(e) => setPrimaryColor(e.target.value)} />
                        <span className="hint" style={{ margin: 0 }}>{primaryColor ? primaryColor : 'Using the default background'}</span>
                        {primaryColor && (
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPrimaryColor('')}>
                            Reset to default
                          </button>
                        )}
                      </div>
                      <p className="hint">Tints the giving screen's background — a soft wash of this colour behind the amount tiles.</p>
                    </div>

                    <div className="field">
                      <span className="label">Accent colour <span className="faint">(buttons)</span></span>
                      <div className="accent-row">
                        <input type="color" className="accent-swatch-input" aria-label="Accent colour" value={accentColor || DEFAULT_ACCENT} onChange={(e) => setAccentColor(e.target.value)} />
                        <span className="hint" style={{ margin: 0 }}>{accentColor ? accentColor : 'Using your default accent'}</span>
                        {accentColor && (
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAccentColor('')}>
                            Reset to default
                          </button>
                        )}
                      </div>
                      <p className="hint">The colour of the “Donate” band on each amount tile, and the buttons.</p>
                    </div>

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
                    <ImageField id="c-logo" label="Campaign logo (optional)" hint="Shown at the top of this campaign. Leave empty to use your masjid logo." value={logo} onChange={setLogo} />
                  </>
                )}

                {tab === 'amounts' && (type === 'tuition' ? (
                  <div className="field">
                    <span className="label">Amounts</span>
                    <p className="hint" style={{ lineHeight: 1.55 }}>
                      Tuition amounts come from <strong>OpenMasjid Students</strong> — a parent looks up their child
                      by name + PIN and pays the balance (or picks specific months). There are no preset amounts to
                      set here.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <span className="label">Suggested amounts <span className="faint">({currency})</span></span>
                      <div className="preset-grid">
                        {presets.map((p, i) => (
                          <div className="preset-input" key={i}>
                            <span className="preset-sym" aria-hidden="true">{symbolFor(currency) || currency}</span>
                            <input className="input" value={p} inputMode="decimal" aria-label={`Suggested amount ${i + 1}`} onChange={(e) => setPreset(i, e.target.value)} />
                            <button className="preset-rm" onClick={() => removePreset(i)} aria-label="Remove amount" title="Remove">
                              <X size={13} strokeWidth={3} />
                            </button>
                          </div>
                        ))}
                      </div>
                      {presets.length < MAX_PRESETS && (
                        <button className="btn btn--ghost btn--sm" onClick={addPreset} style={{ marginBlockStart: '0.5rem' }}>
                          <Plus size={14} /> Add amount
                        </button>
                      )}
                    </div>

                    <Toggle label="Allow donors to enter their own amount" hint="Shows a “Choose your own amount” number pad on the kiosk." checked={allowCustom} onChange={setAllowCustom} />
                    {allowCustom && (
                      <div className="row" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
                        <div className="field" style={{ flex: 1, minWidth: '8rem' }}>
                          <label className="label" htmlFor="c-min">Minimum custom amount</label>
                          <input id="c-min" className="input" value={customMin} inputMode="decimal" onChange={(e) => setCustomMin(e.target.value.replace(/[^\d.]/g, ''))} />
                        </div>
                        <div className="field" style={{ flex: 1, minWidth: '8rem' }}>
                          <label className="label" htmlFor="c-max">Maximum custom amount</label>
                          <input id="c-max" className="input" value={customMax} inputMode="decimal" onChange={(e) => setCustomMax(e.target.value.replace(/[^\d.]/g, ''))} />
                        </div>
                      </div>
                    )}

                    <Toggle
                      label="Offer a monthly (recurring) option"
                      hint="Monthly giving is taken on the card reader, so it isn't available on keyed-only or cross-account campaigns."
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
                        child's name + PIN and pays the balance on the card reader. Turn it on in OpenMasjidOS and in
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
                          <p className="note-amber">
                            This appeal uses a different Stripe account, so donations are taken by keyed card entry (typed card), not the reader. The reader only works
                            for your primary account.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="hint">
                        No Stripe account is linked yet. Add one in <strong>OpenMasjidOS → Settings → Payments</strong>, then
                        choose it here.
                      </p>
                    )}
                    <p className="hint">
                      Stripe accounts and secret keys are managed in <strong>OpenMasjidOS → Settings → Payments</strong> — they
                      never live in this app. Here you just choose which linked account this campaign settles to.
                    </p>
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
                      <span className={description.length > DESC_MAX ? 'form-error' : 'hint'} style={{ textAlign: 'end' }}>{description.length}/{DESC_MAX} — keep it brief so it fits the kiosk screen without being cut off.</span>
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

              {err && <p className="form-error">{err}</p>}

              <div className="row-between" style={{ marginBlockStart: '0.6rem' }}>
                {editing && !isMain ? (
                  confirmingDel ? (
                    <div className="row" style={{ gap: '0.4rem' }}>
                      <button className="btn btn--sm device-danger" onClick={() => void remove()} disabled={del}>
                        {del ? 'Deleting…' : 'Confirm delete'}
                      </button>
                      <button className="btn btn--ghost btn--sm" onClick={() => setConfirmingDel(false)} disabled={del}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn--ghost btn--sm device-remove-btn" onClick={() => setConfirmingDel(true)}>
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
                  <button className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy || del}>
                    {busy ? 'Saving…' : editing ? 'Save campaign' : 'Create campaign'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────────────
function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`switch${checked ? ' switch--on' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </label>
  );
}

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
 *  uploads are sanitised before they're shown as an <img>/CSS background. */
function ImageField({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = safeImageUrl(value);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!f) return;
    setBusy(true);
    setErr('');
    try {
      onChange(await uploadImage(f));
    } catch (x) {
      setErr(errMsg(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="img-field">
        {preview && <img className="img-preview" src={preview} alt="" />}
        <input id={id} className="input" value={value} placeholder="https://…  — or upload a file" onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? (
            'Uploading…'
          ) : (
            <>
              <Upload size={14} /> Upload
            </>
          )}
        </button>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={onFile} />
      </div>
      {err ? <span className="form-error" style={{ margin: 0 }}>{err}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

// ── Faithful giving-screen preview (mirrors the Android kiosk exactly) ─────────────
// These are the kiosk's own colours (android/.../GivingHome.kt `sceneStyleFor` + AmountTile), kept in
// sync so the admin sees the real thing: white glassy tiles with big BLACK numbers on a bright primary
// wash, or a calm dark scene with elevated tiles when the campaign is Dark / has a background image.
const INK_BLACK = '#0a0f14';
const INK_LIGHT = '#0c4a6e'; // dark ink for text on a LIGHT accent
const INK_MUTED_LIGHT = '#2f3742'; // darker slate — secondary text stays clearly readable on a bright wash
const INK_DARK = '#f4f7fb'; // near-white
const INK_MUTED_DARK = '#aebacd';
const SURFACE_OVERLAY_DARK = '#0f2040';
const SCENE_DARK = 'linear-gradient(155deg, #0c3a4d, #082230 60%, #020a12)';

type Scene = {
  accent: string;
  onAccent: string;
  onScene: string;
  onSceneMuted: string;
  tile: string;
  tileInk: string;
  tileBorder: string;
  tileShadow: string;
  background: string;
  bgCover: boolean;
};

/** Resolve the giving-screen colour set from the campaign, exactly as the tablet does (bright primary
 *  wash with white tiles + black numbers, or the calm dark scene with elevated tiles). */
function computeScene(primaryColor: string, accentColor: string, theme: CampaignTheme, bgUrl: string): Scene {
  const accent = accentColor || DEFAULT_ACCENT;
  const onAccent = relLuminance(accent) > 0.4 ? INK_LIGHT : '#ffffff';
  const bright = !bgUrl && theme !== 'dark';
  if (!bright) {
    // Dark theme, or a background image → the calm dark scene, light text on solid elevated tiles.
    return {
      accent,
      onAccent,
      onScene: INK_DARK,
      onSceneMuted: INK_MUTED_DARK,
      tile: SURFACE_OVERLAY_DARK,
      tileInk: INK_DARK,
      tileBorder: 'rgba(255,255,255,0.08)',
      tileShadow: 'none',
      background: bgUrl ? `linear-gradient(rgba(4,14,20,0.5), rgba(4,14,20,0.68)), url("${bgUrl}")` : SCENE_DARK,
      bgCover: !!bgUrl,
    };
  }
  // Bright: a soft PRIMARY-colour wash. A light base → dark text; a dark base → a deepened wash + white
  // text (so headings stay readable). Tiles are white with big black numbers either way.
  const sceneBase = primaryColor || mixHex(accent, '#ffffff', 0.35);
  const lightScene = relLuminance(sceneBase) > 0.35;
  return {
    accent,
    onAccent,
    onScene: lightScene ? INK_BLACK : '#ffffff',
    onSceneMuted: lightScene ? INK_MUTED_LIGHT : 'rgba(255,255,255,0.85)',
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

/** One orientation of the kiosk giving screen, laid out and coloured like the tablet. Container queries
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

/** Both orientations side-by-side, coloured from the campaign — a true-to-device look at what each
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
