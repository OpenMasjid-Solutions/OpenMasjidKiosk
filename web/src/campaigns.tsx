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
  type GivingSettings,
  type PromptPolicy,
  type StripeAccountRef,
} from './api';
import { formatMoney, symbolFor, toMajorStr, toMinor } from './money';
import { safeImageUrl } from './ui';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

const MAX_PRESETS = 6;
/** Shown in the colour picker while a campaign inherits the default accent (it needs a value). */
const DEFAULT_ACCENT = '#22d3ee';
/** A friendly starting set for a brand-new campaign (major units; the admin edits them). */
const DEFAULT_NEW_PRESETS = ['5', '10', '25', '50', '100'];

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
          primaryAccountId={data.primaryAccountId}
          hasLocal={data.hasLocal}
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
      const fresh = await saveGiving({ masjidName, namePolicy, emailPolicy, maxBrightness, footerText });
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
  primaryAccountId,
  hasLocal,
  onClose,
  onSaved,
}: {
  campaign: Campaign | null;
  currency: string;
  accounts: StripeAccountRef[];
  primaryAccountId: string;
  hasLocal: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!campaign;
  const isMain = campaign?.isMain ?? false;

  const [title, setTitle] = useState(campaign?.title ?? '');
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [presets, setPresets] = useState<string[]>(campaign ? campaign.presetsMinor.map((m) => toMajorStr(m, currency)) : [...DEFAULT_NEW_PRESETS]);
  const [allowCustom, setAllowCustom] = useState(campaign?.allowCustom ?? true);
  const [customMin, setCustomMin] = useState(campaign ? toMajorStr(campaign.customMinMinor, currency) : '1');
  const [customMax, setCustomMax] = useState(campaign ? toMajorStr(campaign.customMaxMinor, currency) : '');
  const [accentColor, setAccentColor] = useState(campaign?.accentColor ?? '');
  const [theme, setTheme] = useState<CampaignTheme>(campaign?.theme ?? 'auto');
  const [backgroundImage, setBackgroundImage] = useState(campaign?.backgroundImage ?? '');
  const [coverImage, setCoverImage] = useState(campaign?.coverImage ?? '');
  const [logo, setLogo] = useState(campaign?.logo ?? '');
  const [stripeAccountId, setStripeAccountId] = useState(campaign?.stripeAccountId ?? '');
  const [coverFees, setCoverFees] = useState(campaign?.coverFees ?? false);
  const [monthlyEnabled, setMonthlyEnabled] = useState(campaign?.monthlyEnabled ?? true);
  const [thankYou, setThankYou] = useState(campaign?.thankYouMessage ?? '');
  const [live, setLive] = useState(campaign ? campaign.live : true);

  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [confirmingDel, setConfirmingDel] = useState(false);
  const [err, setErr] = useState('');

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
    if (presetsMinor.length === 0) {
      setErr('Add at least one suggested amount.');
      return;
    }
    const min = toMinor(customMin, currency) || 100;
    const max = toMinor(customMax, currency) || 1_000_000;
    if (allowCustom && max < min) {
      setErr('The maximum custom amount must be at least the minimum.');
      return;
    }
    const patch: CampaignPatch = {
      title: t,
      description: description.trim(),
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
      coverFees,
      thankYouMessage: thankYou,
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
          <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>Live preview</p>
          <KioskPreview
            title={title}
            presetsMinor={previewPresets}
            allowCustom={allowCustom}
            monthlyEnabled={monthlyEnabled}
            thankYou={thankYou}
            currency={currency}
            accentColor={accentColor}
            backgroundImage={backgroundImage}
            logo={logo}
          />

          <div className="field" style={{ marginBlockStart: '1rem' }}>
            <label className="label" htmlFor="c-title">Title</label>
            <input id="c-title" className="input" value={title} maxLength={120} placeholder="e.g. General fund, Zakat, Building fund" onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>

          <div className="field">
            <label className="label" htmlFor="c-desc">Description <span className="faint">(optional)</span></label>
            <textarea id="c-desc" className="input" rows={2} maxLength={1000} value={description} placeholder="A short line about this appeal." onChange={(e) => setDescription(e.target.value)} />
          </div>

          <ImageField id="c-cover" label="Cover image (optional)" hint="Shown on the giving card." value={coverImage} onChange={setCoverImage} />
          <ImageField id="c-bg" label="Background image (optional)" hint="This tab's full-screen background. Leave empty for the default look." value={backgroundImage} onChange={setBackgroundImage} />
          <ImageField id="c-logo" label="Campaign logo (optional)" hint="Shown at the top of this campaign. Leave empty to use your masjid logo." value={logo} onChange={setLogo} />

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

          <Toggle label="Allow donors to enter their own amount" hint="Shows an “Other amount” number pad on the kiosk." checked={allowCustom} onChange={setAllowCustom} />
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

          <div className="field">
            <span className="label">Accent colour</span>
            <div className="accent-row">
              <input type="color" className="accent-swatch-input" aria-label="Accent colour" value={accentColor || DEFAULT_ACCENT} onChange={(e) => setAccentColor(e.target.value)} />
              <span className="hint" style={{ margin: 0 }}>{accentColor ? accentColor : 'Using your default accent'}</span>
              {accentColor && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAccentColor('')}>
                  Reset to default
                </button>
              )}
            </div>
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

          {showAccountPicker && (
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
          )}

          <Toggle
            label="Offer donors the option to cover card fees"
            hint="Adds an estimated card fee (≈2.9% + a small fixed fee) so your masjid keeps the full amount. The donor chooses on the tablet."
            checked={coverFees}
            onChange={setCoverFees}
          />

          <Toggle
            label="Offer a monthly (recurring) option"
            hint="Monthly giving is taken on the card reader, so it isn't available on keyed-only or cross-account campaigns."
            checked={monthlyEnabled}
            onChange={setMonthlyEnabled}
          />

          <div className="field">
            <label className="label" htmlFor="c-thanks">Custom thank-you for this campaign <span className="faint">(optional)</span></label>
            <textarea id="c-thanks" className="input" rows={2} maxLength={500} value={thankYou} placeholder="Leave blank to use your default thank-you." onChange={(e) => setThankYou(e.target.value)} />
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

/** A small, dark mock of the tablet's giving screen — reflects the campaign's title, logo,
 *  background, accent colour and amounts, so the admin can judge it at a glance. */
function KioskPreview({
  title,
  presetsMinor,
  allowCustom,
  monthlyEnabled,
  thankYou,
  currency,
  accentColor,
  backgroundImage,
  logo,
}: {
  title: string;
  presetsMinor: number[];
  allowCustom: boolean;
  monthlyEnabled: boolean;
  thankYou: string;
  currency: string;
  accentColor: string;
  backgroundImage: string;
  logo: string;
}) {
  const bg = safeImageUrl(backgroundImage);
  const safeLogo = safeImageUrl(logo);
  // A dark scrim over the background keeps the (light) preview text readable on any image.
  const screenStyle: CSSProperties | undefined = bg
    ? { backgroundImage: `linear-gradient(rgba(4,14,20,0.5), rgba(4,14,20,0.68)), url("${bg}")`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }
    : undefined;
  const accentBg: CSSProperties | undefined = accentColor ? { background: accentColor } : undefined;
  const accentOn: CSSProperties | undefined = accentColor ? { background: accentColor, color: '#04121a' } : undefined;

  return (
    <div className="kiosk-preview" aria-hidden="true">
      <div className="kp-screen" style={screenStyle}>
        {safeLogo && <img className="kp-logo" src={safeLogo} alt="" />}
        <div className="kp-title">{title.trim() || 'Support your masjid'}</div>
        <div className="kp-sub">Choose an amount to give</div>
        {monthlyEnabled && (
          <div className="kp-freq">
            <span className="kp-freq__seg kp-freq__seg--on" style={accentOn}>One-time</span>
            <span className="kp-freq__seg">Monthly</span>
          </div>
        )}
        <div className="kp-grid">
          {presetsMinor.length === 0 ? (
            <div className="kp-empty">Add a suggested amount to see it here.</div>
          ) : (
            presetsMinor.map((m, i) => (
              <div className="kp-tile" key={i}>
                {formatMoney(m, currency)}
              </div>
            ))
          )}
        </div>
        {allowCustom && (
          <div className="kp-other" style={accentBg}>
            Other amount
          </div>
        )}
      </div>
      <div className="kp-thanks">
        <span className="kp-check">✓</span> {thankYou.trim() || 'JazākAllāhu khayran — thank you for your generous donation.'}
      </div>
    </div>
  );
}
