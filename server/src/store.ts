// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Durable store for all app state, kept in the data volume as a single SQLite file
 *  (better-sqlite3, WAL). Everything goes through this thin repository. Slice 2 persists
 *  the admin credential + the session-signing secret in a small key/value table; later
 *  slices add proper tables (Stripe account choice, devices, pairing codes, donations,
 *  config, device logs) alongside it.
 *
 *  RESTORE-RESILIENCE: nothing derived from the OpenMasjidOS Fabric (base URL, app secret,
 *  fetched Stripe keys, a "linked" flag) is EVER written here — those are read from the
 *  environment every process start. Persisting the admin-chosen Stripe account *id* and the
 *  cookie-signing secret is fine (they aren't platform credentials). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config';
import { makeLog } from './logger';
import type { Cred } from './auth';

const log = makeLog('store');

/** Drop undefined values so a partial update never overwrites a field with nothing. */
function clean<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface Admin extends Cred {
  name?: string;
  createdAt: string;
}

/** Standalone-fallback Stripe keys (used only when the Fabric is absent). The secret key is
 *  server-side only. */
export interface LocalStripe {
  publishableKey: string;
  secretKey: string;
}

/** The chosen Terminal Location (readers connect with its id). */
export interface TerminalLocationRef {
  id: string;
  name: string;
}

export interface MasjidAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2 (e.g. "US", "GB"). */
  country: string;
}

export interface MasjidInfo {
  name: string;
  address: MasjidAddress;
}

/** The giving screen the kiosk shows (designed in the admin panel; the designer UI is a later
 *  slice). Amounts are stored in integer MINOR units so no float rounding ever reaches Stripe. */
export interface GivingConfig {
  presetsMinor: number[];
  allowCustom: boolean;
  customMinMinor: number;
  customMaxMinor: number;
  monthlyEnabled: boolean;
  /** Allow keyed/manual card entry (Stripe's on-device card form) — as a fallback beside the reader,
   *  and the only way to pay in "No reader" mode. Off by default (reader-only is the safest posture). */
  manualEntryEnabled: boolean;
  namePolicy: 'off' | 'optional' | 'required';
  emailPolicy: 'off' | 'optional' | 'required';
  thankYouMessage: string;
  /** Force the tablet to maximum screen brightness (a wall kiosk should be as bright as possible). */
  maxBrightness: boolean;
  /** Small tagline shown at the bottom of the kiosk giving screen ('' hides it). */
  footerText: string;
  /** For a large donation the kiosk suggests a fee-free alternative (e.g. bank transfer). 0 = off. */
  largeAmountThresholdMinor: number;
  /** Message shown in the large-donation dialog (e.g. bank / Zelle transfer details). */
  largeAmountNote: string;
  /** Optional image (e.g. a Zelle/bank QR code) shown in the large-donation dialog. */
  largeAmountImage: string;
  /** Play a fireworks celebration on the thank-you screen after a successful donation. */
  celebrateEnabled: boolean;
  /** Only celebrate when the gift is at least this many MINOR units (0 = celebrate every gift). */
  celebrateThresholdMinor: number;
}

const GIVING_DEFAULTS: GivingConfig = {
  // 5 / 10 / 20 / 50 / 100 / 250 for a 2-decimal currency (sensible starting points; editable).
  presetsMinor: [500, 1000, 2000, 5000, 10000, 25000],
  allowCustom: true,
  customMinMinor: 100,
  customMaxMinor: 1_000_000,
  monthlyEnabled: true,
  manualEntryEnabled: false,
  namePolicy: 'optional',
  emailPolicy: 'optional',
  thankYouMessage: 'JazākAllāhu khayran — thank you for your generous donation.',
  maxBrightness: true,
  footerText: 'OpenMasjid Solutions',
  largeAmountThresholdMinor: 0,
  largeAmountNote: '',
  largeAmountImage: '',
  celebrateEnabled: false,
  celebrateThresholdMinor: 0,
};

/** A giving campaign (an "appeal") the kiosk shows as a tab — its own amounts, colour,
 *  background, thank-you, monthly/cover-fees options and (optionally) its own Stripe account.
 *  Exactly one campaign is the **main** one (the always-present first tab). Amounts are integer
 *  MINOR units. Colours are '#rrggbb' or '' (inherit the default). Images are URLs (an uploaded
 *  '/uploads/…' path, or an external https URL) or '' (use the default look / masjid logo). */
/** Every campaign has a type, which drives the card-fee rule (see deriveFees): a **Donation** lets the
 *  admin offer fee-covering; **Zakat** always enforces it (so the full Zakat reaches the masjid);
 *  **Tuition** lets the admin choose whether to require it. (Mirrors OpenMasjidDonations.) */
export type CampaignType = 'donation' | 'zakat' | 'tuition';

export interface Campaign {
  id: string;
  title: string;
  /** Required campaign type — drives the fee rule (see coverFees/forceCoverFees + deriveFees). */
  type: CampaignType;
  description: string;
  /** Primary colour hex ('#rrggbb') — drives the giving screen's background gradient. '' inherits
   *  the accent (or the kiosk default). Think of it as the campaign's "wallpaper" colour. */
  primaryColor: string;
  /** Accent colour hex ('#rrggbb') or '' to inherit the kiosk default (cyan). Drives the tiles'
   *  "Donate" band, pills and buttons. */
  accentColor: string;
  /** Full-screen background image URL for this campaign's tab, or '' for the default scene. */
  backgroundImage: string;
  /** Optional banner image shown on the giving card, or ''. */
  coverImage: string;
  /** Per-campaign logo URL shown at the top, or '' to use the masjid logo/emblem. */
  logo: string;
  presetsMinor: number[];
  allowCustom: boolean;
  customMinMinor: number;
  customMaxMinor: number;
  monthlyEnabled: boolean;
  /** Offer donors the option to add an estimated card fee so the masjid nets the full amount. */
  coverFees: boolean;
  /** REQUIRE donors to cover the card fee (they can't opt out). Intended for Zakat, so the full
   *  zakat amount reaches the masjid. Implies cover-fees is offered. */
  forceCoverFees: boolean;
  /** Per-campaign thank-you; '' inherits the global default message. */
  thankYouMessage: string;
  /** Kiosk appearance for this campaign's tab: 'light' (bright), 'dark', or 'auto' (bright unless a
   *  dark background image is set). Drives the vibrant bright look the giving screen defaults to. */
  theme: string;
  /** Which Stripe account this campaign settles to. '' = the kiosk's primary account (the one the
   *  reader connects to). A different id routes the money elsewhere — but the physical reader is
   *  locked to the primary account, so a cross-account campaign is taken by keyed entry. */
  stripeAccountId: string;
  /** Visible to donors (shown as a tab). The main campaign is always shown regardless. */
  live: boolean;
  /** The main campaign: the always-present first tab the kiosk idles on. Exactly one is main. */
  isMain: boolean;
  sortOrder: number;
  createdAt: string;
}

/** Defaults for a freshly-created campaign (seeded from the global giving defaults). */
const CAMPAIGN_DEFAULTS: Omit<Campaign, 'id' | 'title' | 'sortOrder' | 'createdAt' | 'isMain'> = {
  type: 'donation',
  description: '',
  primaryColor: '',
  accentColor: '',
  backgroundImage: '',
  coverImage: '',
  logo: '',
  presetsMinor: [...GIVING_DEFAULTS.presetsMinor],
  allowCustom: true,
  customMinMinor: GIVING_DEFAULTS.customMinMinor,
  customMaxMinor: GIVING_DEFAULTS.customMaxMinor,
  monthlyEnabled: true,
  coverFees: false,
  forceCoverFees: false,
  thankYouMessage: '',
  theme: 'auto',
  stripeAccountId: '',
  live: true,
};

// Cover-fees is an ESTIMATE (real Stripe fees vary by country, account and card type). A generic
// online-card estimate: 2.9% + a small fixed fee, grossed up so the masjid nets roughly the base
// amount. The donor sees the computed total before paying; the server re-computes it authoritatively.
export const FEE_BPS = 290; // 2.9%
export const FEE_FIXED_MINOR = 30; // 30 minor units (≈ 30¢ / 30p)

/** Gross up a base amount so that, after the estimated card fee, the masjid nets ≈ the base. */
export function grossUpForFees(baseMinor: number): number {
  if (!Number.isInteger(baseMinor) || baseMinor <= 0) return baseMinor;
  const total = Math.ceil((baseMinor + FEE_FIXED_MINOR) / (1 - FEE_BPS / 10000));
  return Math.max(baseMinor, total);
}

/** A recorded donation as the admin views it (device + campaign names resolved). Amounts are
 *  integer minor units; `createdAt` is an ISO string. `deviceName` is '' if the kiosk was removed. */
export interface DonationRecord {
  id: string;
  paymentIntentId: string;
  deviceId: string;
  deviceName: string;
  campaignId: string;
  campaignTitle: string;
  amountMinor: number;
  currency: string;
  kind: string; // 'one_time' | 'monthly'
  status: string; // 'succeeded' | other Stripe status
  donorName: string;
  donorEmail: string;
  chargeId: string;
  createdAt: string;
}

/** A paired kiosk (tablet). `token_hash` (not the token) is stored. */
export interface Device {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeen: string;
  battery: number; // 0-100, -1 = unknown
  charging: boolean;
  readerStatus: string;
  readerSerial: string;
  readerBattery: number; // -1 = unknown
  appVersion: string;
  configVersion: number;
  identify: boolean;
  revoked: boolean;
}

/** Short, URL-safe id with a kind prefix, e.g. "dev_a1b2c3d4". */
export function rid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export class Store {
  private readonly db: Database.Database;
  private cachedSecret: Buffer | null = null;

  constructor(dbPath = path.join(config.dataDir, 'kiosk.db')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // A small key/value table for singletons (admin credential, signing secret, and — in
    // later slices — the chosen Stripe account id, config version, kiosk PIN hash, Terminal
    // location id). Structured data gets its own tables as those slices land.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL DEFAULT '',
        battery INTEGER NOT NULL DEFAULT -1,
        charging INTEGER NOT NULL DEFAULT 0,
        reader_status TEXT NOT NULL DEFAULT '',
        reader_serial TEXT NOT NULL DEFAULT '',
        reader_battery INTEGER NOT NULL DEFAULT -1,
        app_version TEXT NOT NULL DEFAULT '',
        config_version INTEGER NOT NULL DEFAULT 0,
        identify INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);

      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS device_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        event TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_logs_device ON device_logs(device_id, id);

      CREATE TABLE IF NOT EXISTS donations (
        id TEXT PRIMARY KEY,
        payment_intent_id TEXT NOT NULL DEFAULT '',
        device_id TEXT NOT NULL DEFAULT '',
        campaign_id TEXT NOT NULL DEFAULT '',
        campaign_title TEXT NOT NULL DEFAULT '',
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'one_time',
        status TEXT NOT NULL DEFAULT '',
        donor_name TEXT NOT NULL DEFAULT '',
        donor_email TEXT NOT NULL DEFAULT '',
        charge_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_pi ON donations(payment_intent_id);
      CREATE INDEX IF NOT EXISTS idx_donations_created ON donations(created_at);

      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'donation',
        description TEXT NOT NULL DEFAULT '',
        primary_color TEXT NOT NULL DEFAULT '',
        accent_color TEXT NOT NULL DEFAULT '',
        background_image TEXT NOT NULL DEFAULT '',
        cover_image TEXT NOT NULL DEFAULT '',
        logo TEXT NOT NULL DEFAULT '',
        presets_minor TEXT NOT NULL DEFAULT '[]',
        allow_custom INTEGER NOT NULL DEFAULT 1,
        custom_min_minor INTEGER NOT NULL DEFAULT 100,
        custom_max_minor INTEGER NOT NULL DEFAULT 1000000,
        monthly_enabled INTEGER NOT NULL DEFAULT 1,
        cover_fees INTEGER NOT NULL DEFAULT 0,
        force_cover_fees INTEGER NOT NULL DEFAULT 0,
        thank_you_message TEXT NOT NULL DEFAULT '',
        theme TEXT NOT NULL DEFAULT 'auto',
        stripe_account_id TEXT NOT NULL DEFAULT '',
        live INTEGER NOT NULL DEFAULT 1,
        is_main INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaigns_sort ON campaigns(sort_order, created_at);

      CREATE TABLE IF NOT EXISTS pi_accounts (
        pi TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Migrate older donation rows (pre-campaigns) to carry the new columns. This MUST run before any
    // index on those columns — an existing `donations` table isn't recreated by CREATE TABLE IF NOT
    // EXISTS, so the columns don't exist yet on an upgrade (a fresh DB has them from the CREATE above).
    for (const col of ['campaign_id', 'campaign_title']) {
      const exists = (this.db.prepare(`PRAGMA table_info(donations)`).all() as { name: string }[]).some((c) => c.name === col);
      if (!exists) this.db.exec(`ALTER TABLE donations ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
    // Now that campaign_id is guaranteed to exist, its index is safe to create.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id)');
    // Add later per-campaign columns to an existing campaigns table.
    {
      const cols = (this.db.prepare('PRAGMA table_info(campaigns)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('theme')) this.db.exec("ALTER TABLE campaigns ADD COLUMN theme TEXT NOT NULL DEFAULT 'auto'");
      if (!cols.includes('force_cover_fees')) this.db.exec('ALTER TABLE campaigns ADD COLUMN force_cover_fees INTEGER NOT NULL DEFAULT 0');
      if (!cols.includes('primary_color')) this.db.exec("ALTER TABLE campaigns ADD COLUMN primary_color TEXT NOT NULL DEFAULT ''");
      // Legacy campaigns default to 'donation' (a valid required type) with fees not forced.
      if (!cols.includes('type')) this.db.exec("ALTER TABLE campaigns ADD COLUMN type TEXT NOT NULL DEFAULT 'donation'");
    }
    // Tighten file perms where the OS supports it (the admin hash + signing secret live here).
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort (e.g. Windows dev) */
    }
    log.info(`data store ready at ${dbPath}`);
    // Ensure a main campaign always exists (seeded from the giving defaults on first run, or
    // migrating an existing single-giving install into its first campaign).
    this.ensureMainCampaign();
  }

  private getRaw(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private setRaw(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** The HMAC secret that signs session cookies. Generated once and persisted, so sessions
   *  survive restarts but are invalidated if the data volume is wiped. Reused (later) to
   *  HMAC device tokens at rest. */
  get secret(): Buffer {
    if (this.cachedSecret) return this.cachedSecret;
    let hex = this.getRaw('session_secret');
    if (!hex) {
      hex = crypto.randomBytes(32).toString('hex');
      this.setRaw('session_secret', hex);
    }
    this.cachedSecret = Buffer.from(hex, 'hex');
    return this.cachedSecret;
  }

  getAdmin(): Admin | null {
    const raw = this.getRaw('admin');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Admin;
    } catch {
      return null;
    }
  }

  hasAdmin(): boolean {
    return this.getRaw('admin') !== null;
  }

  setAdmin(cred: Cred, name?: string): void {
    const admin: Admin = { ...cred, name: name || undefined, createdAt: new Date().toISOString() };
    this.setRaw('admin', JSON.stringify(admin));
  }

  private getJson<T>(key: string, fallback: T): T {
    const raw = this.getRaw(key);
    if (!raw) return fallback;
    try {
      return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
    } catch {
      return fallback;
    }
  }

  // ── Payments config (all non-secret except localStripe.secretKey) ──────────────
  /** The admin-chosen OpenMasjidOS-vault Stripe account id (picked in-app from
   *  GET /api/fabric/stripe/accounts). '' = the only/first vault account. Storing the id is
   *  fine (NOT a secret); the keys are always fetched fresh from the Fabric. */
  getFabricStripeChoice(): string {
    return this.getRaw('fabric_stripe_account') ?? '';
  }
  setFabricStripeChoice(id: string): void {
    this.setRaw('fabric_stripe_account', id);
  }

  /** Standalone fallback keys, entered in-app only when the platform/Fabric is absent. The
   *  secret key is server-side only (never returned to the browser/tablet). */
  getLocalStripe(): LocalStripe {
    return this.getJson<LocalStripe>('local_stripe', { publishableKey: '', secretKey: '' });
  }
  /** Partial update; an omitted key is left untouched (so the admin can update one field
   *  without resending the secret). A provided '' clears it. */
  setLocalStripe(patch: Partial<LocalStripe>): LocalStripe {
    const merged: LocalStripe = { ...this.getLocalStripe(), ...clean(patch) };
    this.setRaw('local_stripe', JSON.stringify(merged));
    return merged;
  }

  getCurrency(): string {
    return (this.getRaw('currency') || 'USD').toUpperCase();
  }
  setCurrency(currency: string): string {
    const c = currency.trim().toUpperCase().slice(0, 8) || 'USD';
    this.setRaw('currency', c);
    this.bumpConfigVersion(); // kiosks refetch config when currency changes
    return c;
  }

  /** The chosen Terminal Location (readers must connect with a locationId). */
  getLocation(): TerminalLocationRef | null {
    const raw = this.getRaw('terminal_location');
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as TerminalLocationRef;
      return o.id ? o : null;
    } catch {
      return null;
    }
  }
  setLocation(loc: TerminalLocationRef | null): void {
    if (!loc) this.setRaw('terminal_location', '');
    else this.setRaw('terminal_location', JSON.stringify({ id: loc.id, name: loc.name }));
    this.bumpConfigVersion(); // kiosks refetch config (locationId) when this changes
  }

  /** Masjid name + address — used to name/address the Terminal Location and on receipts. The
   *  platform injects no profile, so the admin enters these in-app. */
  getMasjid(): MasjidInfo {
    return this.getJson<MasjidInfo>('masjid', {
      name: '',
      address: { line1: '', line2: '', city: '', state: '', postalCode: '', country: '' },
    });
  }
  setMasjid(patch: { name?: string; address?: Partial<MasjidAddress> }): MasjidInfo {
    const cur = this.getMasjid();
    const merged: MasjidInfo = {
      name: patch.name ?? cur.name,
      address: { ...cur.address, ...clean(patch.address ?? {}) },
    };
    this.setRaw('masjid', JSON.stringify(merged));
    return merged;
  }

  // ── Kiosk config version (kiosks refetch config when this bumps) ────────────
  getConfigVersion(): number {
    return Number(this.getRaw('config_version') ?? '0') || 0;
  }
  bumpConfigVersion(): number {
    const v = this.getConfigVersion() + 1;
    this.setRaw('config_version', String(v));
    return v;
  }

  /** The kiosk exit-PIN hash (scrypt string; '' if unset). Verified offline on the tablet. */
  getPinHash(): string {
    return this.getRaw('kiosk_pin') ?? '';
  }
  setPinHash(hash: string): void {
    this.setRaw('kiosk_pin', hash);
    this.bumpConfigVersion();
  }

  getAttractTitle(): string {
    return this.getRaw('attract_title') ?? '';
  }
  /** The headline on the attract screen (kiosks refetch when the config version bumps). */
  setAttractTitle(title: string): void {
    this.setRaw('attract_title', title.slice(0, 120));
    this.bumpConfigVersion();
  }

  // ── Giving config (the amounts/messages the kiosk shows; designer UI is a later slice) ──
  getGiving(): GivingConfig {
    return this.getJson<GivingConfig>('giving', GIVING_DEFAULTS);
  }
  setGiving(patch: Partial<GivingConfig>): GivingConfig {
    const cur = this.getGiving();
    const merged: GivingConfig = { ...cur, ...clean(patch as Record<string, unknown>) } as GivingConfig;
    // Sanitise: at most 6 positive integer presets; sane custom bounds; known policies.
    merged.presetsMinor = (Array.isArray(merged.presetsMinor) ? merged.presetsMinor : [])
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 6);
    merged.customMinMinor = Math.max(1, Math.round(Number(merged.customMinMinor) || GIVING_DEFAULTS.customMinMinor));
    merged.customMaxMinor = Math.max(merged.customMinMinor, Math.round(Number(merged.customMaxMinor) || GIVING_DEFAULTS.customMaxMinor));
    const pol = (v: unknown): 'off' | 'optional' | 'required' => (v === 'off' || v === 'required' ? v : 'optional');
    merged.namePolicy = pol(merged.namePolicy);
    merged.emailPolicy = pol(merged.emailPolicy);
    merged.allowCustom = merged.allowCustom !== false;
    merged.monthlyEnabled = merged.monthlyEnabled !== false;
    merged.manualEntryEnabled = merged.manualEntryEnabled === true;
    merged.thankYouMessage = String(merged.thankYouMessage ?? GIVING_DEFAULTS.thankYouMessage).slice(0, 500);
    merged.maxBrightness = merged.maxBrightness !== false; // default ON — a wall kiosk wants max brightness
    merged.footerText = String(merged.footerText ?? GIVING_DEFAULTS.footerText).slice(0, 80);
    merged.largeAmountThresholdMinor = Math.max(0, Math.round(Number(merged.largeAmountThresholdMinor) || 0));
    merged.largeAmountNote = String(merged.largeAmountNote ?? '').slice(0, 600);
    {
      const s = String(merged.largeAmountImage ?? '').trim().slice(0, 500);
      merged.largeAmountImage = /^\/uploads\/[A-Za-z0-9._-]+$/.test(s) || /^https?:\/\/[^"'\\\s]+$/i.test(s) ? s : '';
    }
    merged.celebrateEnabled = merged.celebrateEnabled === true;
    merged.celebrateThresholdMinor = Math.max(0, Math.round(Number(merged.celebrateThresholdMinor) || 0));
    this.setRaw('giving', JSON.stringify(merged));
    this.bumpConfigVersion();
    return merged;
  }

  /** Server-side amount guard (never trust the tablet): an allowed amount is a configured
   *  preset, or — when custom is enabled — within [min,max]. Integer minor units only. */
  isAllowedAmount(amountMinor: number): boolean {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) return false;
    const g = this.getGiving();
    if (g.presetsMinor.includes(amountMinor)) return true;
    return g.allowCustom && amountMinor >= g.customMinMinor && amountMinor <= g.customMaxMinor;
  }

  // ── Campaigns (giving appeals, shown as kiosk tabs) ─────────────────────────
  private rowToCampaign(r: Record<string, unknown>): Campaign {
    let presets: number[] = [];
    try {
      const arr = JSON.parse(String(r.presets_minor ?? '[]'));
      if (Array.isArray(arr)) presets = arr.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      /* keep [] */
    }
    return {
      id: String(r.id),
      title: String(r.title),
      type: (['donation', 'zakat', 'tuition'] as const).includes(String(r.type) as CampaignType) ? (String(r.type) as CampaignType) : 'donation',
      description: String(r.description),
      primaryColor: String(r.primary_color ?? ''),
      accentColor: String(r.accent_color),
      backgroundImage: String(r.background_image),
      coverImage: String(r.cover_image),
      logo: String(r.logo),
      presetsMinor: presets,
      allowCustom: !!r.allow_custom,
      customMinMinor: Number(r.custom_min_minor),
      customMaxMinor: Number(r.custom_max_minor),
      monthlyEnabled: !!r.monthly_enabled,
      coverFees: !!r.cover_fees,
      forceCoverFees: !!r.force_cover_fees,
      thankYouMessage: String(r.thank_you_message),
      theme: String(r.theme || 'auto'),
      stripeAccountId: String(r.stripe_account_id),
      live: !!r.live,
      isMain: !!r.is_main,
      sortOrder: Number(r.sort_order),
      createdAt: String(r.created_at),
    };
  }

  /** Clamp/normalise campaign fields (server-authoritative — never trust the client). */
  private sanitizeCampaign(c: Campaign): Campaign {
    const hex = (v: string): string => (/^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '');
    const img = (v: string): string => {
      const s = String(v ?? '').trim().slice(0, 500);
      if (!s) return '';
      if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(s)) return s; // our own uploaded file
      if (/^https?:\/\/[^"'\\\s]+$/i.test(s)) return s; // external URL (no quotes/space)
      return '';
    };
    const presets = (Array.isArray(c.presetsMinor) ? c.presetsMinor : [])
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 6);
    const min = Math.max(1, Math.round(Number(c.customMinMinor) || GIVING_DEFAULTS.customMinMinor));
    const max = Math.max(min, Math.round(Number(c.customMaxMinor) || GIVING_DEFAULTS.customMaxMinor));
    // The campaign TYPE is the single source of truth for the fee rule (so a hand-crafted API body
    // can't create a non-enforcing Zakat campaign): Zakat always forces the fee (offering implied);
    // Donation never forces (coverFees stays the admin's optional offer); Tuition leaves it to the
    // admin's require toggle (offered iff required). Mirrors OpenMasjidDonations' deriveFees.
    const type: CampaignType = (['donation', 'zakat', 'tuition'] as const).includes(c.type as CampaignType) ? (c.type as CampaignType) : 'donation';
    let coverFees: boolean;
    let forceCoverFees: boolean;
    if (type === 'zakat') {
      forceCoverFees = true;
      coverFees = true;
    } else if (type === 'tuition') {
      forceCoverFees = c.forceCoverFees === true;
      coverFees = forceCoverFees;
    } else {
      forceCoverFees = false;
      coverFees = c.coverFees === true;
    }
    return {
      ...c,
      title: String(c.title ?? '').trim().slice(0, 120) || 'Donations',
      type,
      description: String(c.description ?? '').slice(0, 1000),
      primaryColor: hex(String(c.primaryColor ?? '')),
      accentColor: hex(String(c.accentColor ?? '')),
      backgroundImage: img(String(c.backgroundImage ?? '')),
      coverImage: img(String(c.coverImage ?? '')),
      logo: img(String(c.logo ?? '')),
      presetsMinor: presets,
      allowCustom: c.allowCustom !== false,
      customMinMinor: min,
      customMaxMinor: max,
      monthlyEnabled: c.monthlyEnabled !== false,
      coverFees,
      forceCoverFees,
      thankYouMessage: String(c.thankYouMessage ?? '').slice(0, 500),
      theme: (['auto', 'light', 'dark'] as const).includes(c.theme as 'auto' | 'light' | 'dark') ? c.theme : 'auto',
      stripeAccountId: String(c.stripeAccountId ?? '').trim().slice(0, 120),
      live: c.live !== false,
    };
  }

  private writeCampaign(c: Campaign): void {
    this.db
      .prepare(
        `INSERT INTO campaigns (id, title, type, description, primary_color, accent_color, background_image, cover_image, logo,
           presets_minor, allow_custom, custom_min_minor, custom_max_minor, monthly_enabled, cover_fees,
           force_cover_fees, thank_you_message, theme, stripe_account_id, live, is_main, sort_order, created_at)
         VALUES (@id, @title, @type, @description, @primaryColor, @accentColor, @backgroundImage, @coverImage, @logo,
           @presetsJson, @allowCustom, @customMinMinor, @customMaxMinor, @monthlyEnabled, @coverFees,
           @forceCoverFees, @thankYouMessage, @theme, @stripeAccountId, @live, @isMain, @sortOrder, @createdAt)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, description=excluded.description,
           primary_color=excluded.primary_color,
           accent_color=excluded.accent_color, background_image=excluded.background_image,
           cover_image=excluded.cover_image, logo=excluded.logo, presets_minor=excluded.presets_minor,
           allow_custom=excluded.allow_custom, custom_min_minor=excluded.custom_min_minor,
           custom_max_minor=excluded.custom_max_minor, monthly_enabled=excluded.monthly_enabled,
           cover_fees=excluded.cover_fees, force_cover_fees=excluded.force_cover_fees,
           thank_you_message=excluded.thank_you_message,
           theme=excluded.theme, stripe_account_id=excluded.stripe_account_id, live=excluded.live,
           is_main=excluded.is_main, sort_order=excluded.sort_order`,
      )
      .run({
        id: c.id,
        title: c.title,
        type: c.type,
        description: c.description,
        primaryColor: c.primaryColor,
        accentColor: c.accentColor,
        backgroundImage: c.backgroundImage,
        coverImage: c.coverImage,
        logo: c.logo,
        presetsJson: JSON.stringify(c.presetsMinor),
        allowCustom: c.allowCustom ? 1 : 0,
        customMinMinor: c.customMinMinor,
        customMaxMinor: c.customMaxMinor,
        monthlyEnabled: c.monthlyEnabled ? 1 : 0,
        coverFees: c.coverFees ? 1 : 0,
        forceCoverFees: c.forceCoverFees ? 1 : 0,
        thankYouMessage: c.thankYouMessage,
        theme: c.theme,
        stripeAccountId: c.stripeAccountId,
        live: c.live ? 1 : 0,
        isMain: c.isMain ? 1 : 0,
        sortOrder: c.sortOrder,
        createdAt: c.createdAt,
      });
  }

  /** All campaigns, MAIN first, then by sort order (created_at breaks ties). */
  listCampaigns(): Campaign[] {
    return (
      this.db.prepare('SELECT * FROM campaigns ORDER BY is_main DESC, sort_order ASC, created_at ASC').all() as Record<string, unknown>[]
    ).map((r) => this.rowToCampaign(r));
  }

  getCampaign(id: string): Campaign | null {
    const r = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToCampaign(r) : null;
  }

  getMainCampaign(): Campaign | null {
    const r = this.db.prepare('SELECT * FROM campaigns WHERE is_main = 1 LIMIT 1').get() as Record<string, unknown> | undefined;
    return r ? this.rowToCampaign(r) : null;
  }

  /** Ensure exactly one main campaign exists. On first run (no campaigns) seed one from the
   *  global giving defaults so an existing install keeps its single giving screen seamlessly. */
  ensureMainCampaign(): Campaign {
    const existing = this.getMainCampaign();
    if (existing) return existing;
    const any = this.db.prepare('SELECT COUNT(*) AS n FROM campaigns').get() as { n: number };
    if (any.n > 0) {
      // Campaigns exist but none is main (shouldn't happen) — promote the first.
      const first = this.listCampaigns()[0];
      this.db.prepare('UPDATE campaigns SET is_main = 1 WHERE id = ?').run(first.id);
      return this.getCampaign(first.id)!;
    }
    const g = this.getGiving();
    const seeded: Campaign = this.sanitizeCampaign({
      ...CAMPAIGN_DEFAULTS,
      id: rid('cmp'),
      title: this.getMasjid().name || 'General Fund',
      presetsMinor: g.presetsMinor,
      allowCustom: g.allowCustom,
      customMinMinor: g.customMinMinor,
      customMaxMinor: g.customMaxMinor,
      monthlyEnabled: g.monthlyEnabled,
      thankYouMessage: '',
      isMain: true,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
    });
    this.writeCampaign(seeded);
    this.bumpConfigVersion();
    return seeded;
  }

  createCampaign(input: Partial<Campaign>): Campaign {
    const maxSort = (this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM campaigns').get() as { m: number }).m;
    const c = this.sanitizeCampaign({
      ...CAMPAIGN_DEFAULTS,
      ...clean(input as Record<string, unknown>),
      id: rid('cmp'),
      isMain: false, // only the seed/main-switch sets this
      sortOrder: maxSort + 1,
      createdAt: new Date().toISOString(),
    } as Campaign);
    this.writeCampaign(c);
    this.bumpConfigVersion();
    return c;
  }

  updateCampaign(id: string, patch: Partial<Campaign>): Campaign | null {
    const cur = this.getCampaign(id);
    if (!cur) return null;
    // id / isMain / sortOrder / createdAt are not editable via a field patch.
    const { id: _i, isMain: _m, sortOrder: _s, createdAt: _c, ...editable } = patch;
    void _i; void _m; void _s; void _c;
    const merged = this.sanitizeCampaign({ ...cur, ...clean(editable as Record<string, unknown>) } as Campaign);
    merged.isMain = cur.isMain; // preserve
    merged.sortOrder = cur.sortOrder;
    merged.createdAt = cur.createdAt;
    this.writeCampaign(merged);
    this.bumpConfigVersion();
    return merged;
  }

  /** Delete a campaign. The main campaign can never be deleted (returns false). */
  deleteCampaign(id: string): boolean {
    const c = this.getCampaign(id);
    if (!c || c.isMain) return false;
    this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
    this.bumpConfigVersion();
    return true;
  }

  /** Reorder campaigns by the given id order (the main campaign stays first regardless). */
  reorderCampaigns(ids: string[]): void {
    const tx = this.db.transaction((order: string[]) => {
      order.forEach((id, i) => this.db.prepare('UPDATE campaigns SET sort_order = ? WHERE id = ? AND is_main = 0').run(i + 1, id));
    });
    tx(ids);
    this.bumpConfigVersion();
  }

  /** Make `id` the main campaign (the always-shown first tab). The previous main becomes a normal
   *  live campaign. */
  setMainCampaign(id: string): boolean {
    const c = this.getCampaign(id);
    if (!c) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE campaigns SET is_main = 0').run();
      this.db.prepare('UPDATE campaigns SET is_main = 1, live = 1 WHERE id = ?').run(id);
    });
    tx();
    this.bumpConfigVersion();
    return true;
  }

  /** Server-side amount guard for a specific campaign (never trust the tablet): an allowed amount
   *  is one of the campaign's presets, or — when custom is enabled — within its [min,max]. */
  isAllowedAmountForCampaign(c: Campaign, amountMinor: number): boolean {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) return false;
    if (c.presetsMinor.includes(amountMinor)) return true;
    return c.allowCustom && amountMinor >= c.customMinMinor && amountMinor <= c.customMaxMinor;
  }

  /** Remember which Stripe account a PaymentIntent was created on, so /complete verifies it with
   *  the SAME account's key (campaigns can settle to different accounts). Best-effort: prunes old
   *  rows; if lost (e.g. a restart between create and complete), the caller falls back to primary. */
  rememberPiAccount(pi: string, account: string): void {
    this.db.prepare('INSERT OR REPLACE INTO pi_accounts (pi, account, created_at) VALUES (?, ?, ?)').run(pi, account, new Date().toISOString());
    // Keep the table small — a PI is completed within seconds, so 7 days is generous.
    this.db.prepare("DELETE FROM pi_accounts WHERE created_at < ?").run(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  }
  getPiAccount(pi: string): string {
    const r = this.db.prepare('SELECT account FROM pi_accounts WHERE pi = ?').get(pi) as { account?: string } | undefined;
    return r?.account ?? '';
  }

  // ── Donations (recorded ONLY after the server verifies the PI with Stripe) ──────
  recordDonation(d: {
    paymentIntentId: string;
    deviceId: string;
    campaignId?: string;
    campaignTitle?: string;
    amountMinor: number;
    currency: string;
    kind: string;
    status: string;
    donorName?: string;
    donorEmail?: string;
    chargeId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO donations (id, payment_intent_id, device_id, campaign_id, campaign_title, amount_minor, currency, kind, status, donor_name, donor_email, charge_id, created_at)
         VALUES (@id, @paymentIntentId, @deviceId, @campaignId, @campaignTitle, @amountMinor, @currency, @kind, @status, @donorName, @donorEmail, @chargeId, @createdAt)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, charge_id = excluded.charge_id`,
      )
      .run({
        id: d.paymentIntentId,
        paymentIntentId: d.paymentIntentId,
        deviceId: d.deviceId,
        campaignId: d.campaignId || '',
        campaignTitle: d.campaignTitle || '',
        amountMinor: d.amountMinor,
        currency: d.currency,
        kind: d.kind,
        status: d.status,
        donorName: d.donorName || '',
        donorEmail: d.donorEmail || '',
        chargeId: d.chargeId || '',
        createdAt: new Date().toISOString(),
      });
  }

  private rowToDonation(r: Record<string, unknown>): DonationRecord {
    return {
      id: String(r.id),
      paymentIntentId: String(r.payment_intent_id),
      deviceId: String(r.device_id),
      deviceName: String(r.device_name ?? ''),
      campaignId: String(r.campaign_id ?? ''),
      campaignTitle: String(r.campaign_title ?? ''),
      amountMinor: Number(r.amount_minor),
      currency: String(r.currency),
      kind: String(r.kind),
      status: String(r.status),
      donorName: String(r.donor_name),
      donorEmail: String(r.donor_email),
      chargeId: String(r.charge_id),
      createdAt: String(r.created_at),
    };
  }

  /** Recorded donations, newest first, with the kiosk name resolved (LEFT JOIN, so a removed
   *  kiosk's donations still appear). `limit` caps the on-screen log; pass -1 (SQLite = no limit)
   *  for the full CSV export. */
  listDonations(limit = 2000): DonationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, dev.name AS device_name
         FROM donations d LEFT JOIN devices dev ON dev.id = d.device_id
         ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDonation(r));
  }

  /** Succeeded-donation totals over the WHOLE table (SQL aggregates — NOT the capped log, so they
   *  never undercount). Restricted to the CURRENT currency, because summing amounts across different
   *  currencies would be meaningless; donations in other currencies stay in the log/CSV with their
   *  own currency but are excluded from these headline figures. All amounts are integer minor units. */
  donationTotals(): {
    today: number;
    thisWeek: number;
    thisMonth: number;
    allTime: number;
    count: number;
    average: number;
    byDevice: { deviceId: string; deviceName: string; amountMinor: number; count: number }[];
  } {
    const currency = this.getCurrency();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    // created_at is a UTC ISO string; ISO sorts lexicographically = chronologically, so a `>=` string
    // compare against a UTC-ISO cutoff gives correct local-day/week/month windows.
    const sumSince = (iso: string): number =>
      Number(
        (this.db
          .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s FROM donations WHERE status = 'succeeded' AND currency = ? AND created_at >= ?`)
          .get(currency, iso) as { s: number }).s,
      );
    const all = this.db
      .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s, COUNT(*) AS n FROM donations WHERE status = 'succeeded' AND currency = ?`)
      .get(currency) as { s: number; n: number };
    const rows = this.db
      .prepare(
        `SELECT d.device_id AS deviceId, COALESCE(dev.name, '') AS deviceName,
                COALESCE(SUM(d.amount_minor), 0) AS amountMinor, COUNT(*) AS count
         FROM donations d LEFT JOIN devices dev ON dev.id = d.device_id
         WHERE d.status = 'succeeded' AND d.currency = ?
         GROUP BY d.device_id ORDER BY amountMinor DESC`,
      )
      .all(currency) as { deviceId: string; deviceName: string; amountMinor: number; count: number }[];
    const count = Number(all.n);
    return {
      today: sumSince(startOfToday.toISOString()),
      thisWeek: sumSince(weekAgo.toISOString()),
      thisMonth: sumSince(startOfMonth.toISOString()),
      allTime: Number(all.s),
      count,
      average: count ? Math.round(Number(all.s) / count) : 0,
      byDevice: rows.map((r) => ({ deviceId: r.deviceId || 'unknown', deviceName: r.deviceName || 'Kiosk', amountMinor: Number(r.amountMinor), count: Number(r.count) })),
    };
  }

  /** The versioned config a paired kiosk pulls: the PIN, currency, location, masjid name, the
   *  global giving settings (manual-entry policy, name/email prompts, default thank-you, cover-fee
   *  estimate), and the ordered list of live CAMPAIGNS (main first) it shows as tabs. Each campaign
   *  carries `readerCapable` — whether the physical reader (locked to the primary account) can take
   *  it, or it must use keyed entry (a cross-account campaign). Pass the primary account id so this
   *  can be computed; '' treats every campaign as reader-capable (single-account kiosks). */
  getKioskConfig(primaryAccountId = ''): { version: number; config: Record<string, unknown> } {
    const g = this.getGiving();
    const main = this.getMainCampaign();
    const campaigns = this.listCampaigns()
      .filter((c) => c.live || c.isMain) // main is always shown; others only when live
      .map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        description: c.description,
        primaryColor: c.primaryColor,
        accentColor: c.accentColor,
        backgroundImage: c.backgroundImage,
        coverImage: c.coverImage,
        logo: c.logo,
        presetsMinor: c.presetsMinor,
        allowCustom: c.allowCustom,
        customMinMinor: c.customMinMinor,
        customMaxMinor: c.customMaxMinor,
        monthlyEnabled: c.monthlyEnabled,
        coverFees: c.coverFees,
        forceCoverFees: c.forceCoverFees,
        thankYouMessage: c.thankYouMessage || g.thankYouMessage,
        theme: c.theme || 'auto',
        isMain: c.isMain,
        // The reader is bound to the primary account; a campaign on another account is keyed-only.
        readerCapable: !c.stripeAccountId || c.stripeAccountId === primaryAccountId,
      }));
    return {
      version: this.getConfigVersion(),
      config: {
        pinHash: this.getPinHash(),
        currency: this.getCurrency(),
        locationId: this.getLocation()?.id ?? '',
        masjidName: this.getMasjid().name,
        // Global giving policy (per-campaign amounts/monthly/thank-you live on each campaign).
        manualEntryEnabled: g.manualEntryEnabled,
        namePolicy: g.namePolicy,
        emailPolicy: g.emailPolicy,
        maxBrightness: g.maxBrightness !== false,
        footerText: g.footerText,
        largeAmountThresholdMinor: g.largeAmountThresholdMinor,
        largeAmountNote: g.largeAmountNote,
        largeAmountImage: g.largeAmountImage,
        celebrateEnabled: g.celebrateEnabled === true,
        celebrateThresholdMinor: g.celebrateThresholdMinor,
        // Cover-fee estimate so the tablet can display the same total the server will charge.
        feeBps: FEE_BPS,
        feeFixedMinor: FEE_FIXED_MINOR,
        mainCampaignId: main?.id ?? '',
        campaigns,
      },
    };
  }

  // ── Device tokens ────────────────────────────────────────────────────────────
  /** HMAC of a device token, using the app's signing secret — only this is stored, so a
   *  DB leak can't reveal usable device tokens. */
  hashDeviceToken(token: string): string {
    return crypto.createHmac('sha256', this.secret).update(token).digest('hex');
  }

  // ── Pairing codes (single-use, short TTL) ───────────────────────────────────
  createPairingCode(code: string, ttlMs = 10 * 60_000): { code: string; expiresAt: number } {
    const expiresAt = Date.now() + ttlMs;
    // Best-effort cleanup of expired/used codes so the table stays tiny.
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? OR used = 1').run(Date.now());
    this.db.prepare('INSERT OR REPLACE INTO pairing_codes (code, expires_at, used, created_at) VALUES (?, ?, 0, ?)').run(code, expiresAt, new Date().toISOString());
    return { code, expiresAt };
  }
  /** Atomically validate + consume a pairing code (true only if valid, unused, unexpired). */
  consumePairingCode(code: string): boolean {
    const res = this.db.prepare('UPDATE pairing_codes SET used = 1 WHERE code = ? AND used = 0 AND expires_at > ?').run(code, Date.now());
    return res.changes > 0;
  }

  // ── Devices ─────────────────────────────────────────────────────────────────
  private rowToDevice(r: Record<string, unknown>): Device {
    return {
      id: String(r.id),
      name: String(r.name),
      platform: String(r.platform),
      createdAt: String(r.created_at),
      lastSeen: String(r.last_seen),
      battery: Number(r.battery),
      charging: !!r.charging,
      readerStatus: String(r.reader_status),
      readerSerial: String(r.reader_serial),
      readerBattery: Number(r.reader_battery),
      appVersion: String(r.app_version),
      configVersion: Number(r.config_version),
      identify: !!r.identify,
      revoked: !!r.revoked,
    };
  }

  createDevice(input: { name: string; platform: string; tokenHash: string }): Device {
    const id = rid('dev');
    this.db
      .prepare('INSERT INTO devices (id, name, token_hash, platform, created_at, config_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.name || 'Kiosk', input.tokenHash, input.platform || '', new Date().toISOString(), this.getConfigVersion());
    return this.getDevice(id)!;
  }

  getDevice(id: string): Device | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToDevice(r) : null;
  }

  /** Look up a device by its token hash (INCLUDING revoked ones — callers check `.revoked`).
   *  Heartbeat returns `revoked:true` so the tablet can re-pair cleanly; other routes 401. */
  getDeviceByTokenHash(hash: string): Device | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hash) as Record<string, unknown> | undefined;
    return r ? this.rowToDevice(r) : null;
  }

  /** The admin fleet list — excludes revoked devices so "Remove" makes a kiosk disappear.
   *  (The revoked row is kept for its token so heartbeat can still answer `revoked:true`.) */
  listDevices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices WHERE revoked = 0 ORDER BY created_at').all() as Record<string, unknown>[]).map((r) => this.rowToDevice(r));
  }

  renameDevice(id: string, name: string): Device | null {
    this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.slice(0, 80), id);
    return this.getDevice(id);
  }

  /** Revoke a device (kills its token; the kiosk returns to pairing on its next heartbeat). */
  revokeDevice(id: string): void {
    this.db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(id);
  }

  updateHeartbeat(
    id: string,
    hb: { battery?: number; charging?: boolean; readerStatus?: string; readerSerial?: string; readerBattery?: number; appVersion?: string; configVersion?: number },
  ): void {
    const cur = this.getDevice(id);
    if (!cur) return;
    this.db
      .prepare(
        `UPDATE devices SET last_seen = @lastSeen, battery = @battery, charging = @charging, reader_status = @readerStatus,
         reader_serial = @readerSerial, reader_battery = @readerBattery, app_version = @appVersion, config_version = @configVersion
         WHERE id = @id`,
      )
      .run({
        id,
        lastSeen: new Date().toISOString(),
        battery: hb.battery ?? cur.battery,
        charging: hb.charging === undefined ? (cur.charging ? 1 : 0) : hb.charging ? 1 : 0,
        readerStatus: hb.readerStatus ?? cur.readerStatus,
        readerSerial: hb.readerSerial ?? cur.readerSerial,
        readerBattery: hb.readerBattery ?? cur.readerBattery,
        appVersion: hb.appVersion ?? cur.appVersion,
        configVersion: hb.configVersion ?? cur.configVersion,
      });
  }

  setIdentify(id: string): void {
    this.db.prepare('UPDATE devices SET identify = 1 WHERE id = ?').run(id);
  }

  /** Read + clear the "identify" flag (the kiosk flashes once when it sees it). */
  consumeIdentify(id: string): boolean {
    const row = this.db.prepare('SELECT identify FROM devices WHERE id = ?').get(id) as { identify?: number } | undefined;
    if (row?.identify) {
      this.db.prepare('UPDATE devices SET identify = 0 WHERE id = ?').run(id);
      return true;
    }
    return false;
  }

  // ── Device logs ───────────────────────────────────────────────────────────
  addLogs(deviceId: string, entries: { level?: string; event?: string; detail?: string; ts?: number }[]): void {
    const stmt = this.db.prepare('INSERT INTO device_logs (device_id, ts, level, event, detail) VALUES (?, ?, ?, ?, ?)');
    const tx = this.db.transaction((rows: typeof entries) => {
      for (const e of rows.slice(0, 200)) {
        const ts = typeof e.ts === 'number' ? new Date(e.ts).toISOString() : new Date().toISOString();
        const level = ['info', 'warn', 'error'].includes(String(e.level)) ? String(e.level) : 'info';
        stmt.run(deviceId, ts, level, String(e.event ?? '').slice(0, 200), String(e.detail ?? '').slice(0, 2000));
      }
    });
    tx(entries);
    // Cap history per device (keep the latest ~1000 lines).
    this.db.prepare('DELETE FROM device_logs WHERE device_id = ? AND id NOT IN (SELECT id FROM device_logs WHERE device_id = ? ORDER BY id DESC LIMIT 1000)').run(deviceId, deviceId);
  }

  listLogs(deviceId: string, limit = 200): { ts: string; level: string; event: string; detail: string }[] {
    return (
      this.db.prepare('SELECT ts, level, event, detail FROM device_logs WHERE device_id = ? ORDER BY id DESC LIMIT ?').all(deviceId, limit) as {
        ts: string;
        level: string;
        event: string;
        detail: string;
      }[]
    );
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
