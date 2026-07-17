// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Typed client for the OpenMasjid Kiosk API. Responses use a { data | error } envelope;
 *  this unwraps `data` and turns `error` into a thrown friendly message. Grows with each
 *  slice (auth/SSO now; devices, payments, donations later). */
import { withBase } from './base';

export interface AppInfo {
  name: string;
  version: string;
  /** True when running embedded under OpenMasjidOS (Fabric available). */
  embedded: boolean;
  /** Whether the Android kiosk app is bundled in this server image (false in dev / before
   *  the first CI build). */
  apkAvailable: boolean;
  /** Where /new links the download button. */
  apkDownloadPath: string;
  /** Suggested download filename (versioned). */
  apkFilename: string;
}

export interface Session {
  /** Standalone first-run: no admin password set yet (and not under SSO). */
  needsSetup: boolean;
  /** Signed in (via local password or a confirmed OpenMasjidOS SSO session). */
  authed: boolean;
  /** A local admin password exists. */
  hasPassword: boolean;
  /** SSO via OpenMasjidOS. `reachable` is false only when SSO is configured but the platform
   *  couldn't be contacted (down / migrated) — the UI then offers the local-password
   *  recovery instead of looping on "open from the dashboard". */
  sso: { enabled: boolean; reachable: boolean; username?: string };
}

export interface NotifyTestResult {
  baseUrlSet: boolean;
  hasSecret: boolean;
  baseUrlLoopback: boolean;
  appId: string;
  delivered: boolean;
  reason?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBase(path), {
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok || body.error) {
    throw new Error(body.error || 'Something went wrong. Please try again.');
  }
  return body.data as T;
}

export const getAppInfo = () => request<AppInfo>('/api/app');
export const getSession = () => request<Session>('/api/session');

export const setupAdmin = (password: string, name?: string) =>
  request<{ ok: true }>('/api/setup', { method: 'POST', body: JSON.stringify({ password, name }) });

export const login = (password: string) =>
  request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) });

export const logout = () => request<{ ok: true }>('/api/logout', { method: 'POST' });

export const sendTestNotification = () => request<NotifyTestResult>('/api/admin/notify-test', { method: 'POST' });

// ── Payments (in-app Stripe setup) ────────────────────────────────────────────
// The Stripe SECRET key never reaches the browser: the server holds it in memory (fetched
// from the OpenMasjidOS Fabric per process start) and only ever tells us *about* it
// (mode, whether it is set). These types mirror that server-side shape.

/** A masjid postal address (used to name/address the reader's Stripe Terminal Location). */
export interface MasjidAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/** The masjid details the platform injects no profile for — this app collects them itself. */
export interface Masjid {
  name: string;
  address: MasjidAddress;
}

/** Non-secret facts about a set of Stripe keys. `publishableKey` is safe to expose; the
 *  secret is represented only by `hasSecretKey`. `keysMismatch` flags a pk/sk from
 *  different accounts. */
export interface StripePublicStatus {
  publishableKey: string;
  hasSecretKey: boolean;
  mode: 'test' | 'live' | 'unknown';
  configured: boolean;
  keysMismatch: boolean;
}

/** A named Stripe account offered by the OpenMasjidOS Fabric (no keys, just id + label). */
export interface StripeAccountRef {
  id: string;
  label: string;
}

/** The keys actually in effect, plus where they came from. */
export interface ResolvedStripe extends StripePublicStatus {
  source: 'fabric' | 'local';
  label: string;
}

/** The Terminal Location currently registered for the readers. */
export interface TerminalLocationRef {
  id: string;
  name: string;
}

/** A Terminal Location as returned when listing/creating (fuller than the in-use ref). */
export interface TerminalLocation {
  id: string;
  displayName: string;
  address: string;
}

/** The address shape accepted when creating a Terminal Location. */
export interface CreateLocationAddress {
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country: string;
}

/** The full picture the Payments screen renders from. */
export interface PaymentsStatus {
  /** Running embedded under OpenMasjidOS (so the Fabric account picker is available). */
  embedded: boolean;
  fabric: {
    available: boolean;
    accounts: StripeAccountRef[];
    chosenId: string;
    status: StripePublicStatus | null;
  };
  local: StripePublicStatus;
  resolved: ResolvedStripe | null;
  currency: string;
  location: TerminalLocationRef | null;
  masjid: Masjid;
  /** True whenever the keys in effect are test keys — surfaces the TEST MODE badge. */
  testMode: boolean;
}

/** Outcome of a live key check (returned by saving keys and by the test button). */
export interface VerifyResult {
  ok: boolean;
  mode?: string;
  message?: string;
}

/** Saving local keys returns the fresh status plus a verification of what was entered. */
export type SetLocalKeysResult = PaymentsStatus & { verify?: VerifyResult };

/** Outcome of the "test connection" probe (mints a Terminal connection token server-side). */
export interface TestPaymentsResult {
  ok: boolean;
  mode?: string;
  source?: string;
  message?: string;
}

export const getPayments = () => request<PaymentsStatus>('/api/admin/payments');

export const setStripeAccount = (accountId: string) =>
  request<PaymentsStatus>('/api/admin/payments/account', { method: 'PUT', body: JSON.stringify({ accountId }) });

export const setLocalKeys = (body: { publishableKey?: string; secretKey?: string }) =>
  request<SetLocalKeysResult>('/api/admin/payments/local', { method: 'PUT', body: JSON.stringify(body) });

export const setCurrency = (currency: string) =>
  request<PaymentsStatus>('/api/admin/payments/currency', { method: 'PUT', body: JSON.stringify({ currency }) });

export const saveMasjid = (body: { name?: string; address?: Partial<MasjidAddress> }) =>
  request<Masjid>('/api/admin/masjid', { method: 'PUT', body: JSON.stringify(body) });

export const listLocations = () => request<{ locations: TerminalLocation[] }>('/api/admin/payments/locations');

export const createLocation = (body: { displayName?: string; address: CreateLocationAddress }) =>
  request<{ location: TerminalLocation }>('/api/admin/payments/location', { method: 'POST', body: JSON.stringify(body) });

export const chooseLocation = (id: string) =>
  request<{ location: TerminalLocation }>('/api/admin/payments/location', { method: 'PUT', body: JSON.stringify({ id }) });

export const testPayments = () => request<TestPaymentsResult>('/api/admin/payments/test', { method: 'POST' });

// ── Devices (fleet management) ─────────────────────────────────────────────────
// The Devices page pairs, renames, and manages the tablets running the giving screen.
// The server owns the truth (heartbeats, revocation, PIN hash); the browser just renders.

/** A paired kiosk tablet as the Devices page renders it. `createdAt`/`lastSeen` are ISO
 *  strings; `battery`/`readerBattery` are 0–100 (or -1 when unknown). `online` is derived
 *  server-side from the last heartbeat. */
export interface Device {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeen: string;
  /** 0–100, or -1 when the tablet hasn't reported a battery level. */
  battery: number;
  charging: boolean;
  readerStatus: string;
  readerSerial: string;
  readerBattery: number;
  appVersion: string;
  configVersion: number;
  /** True while the kiosk has been asked to flash (identify). */
  identify: boolean;
  revoked: boolean;
  online: boolean;
  /** Forced screen orientation set from here (not the tablet's auto-rotate). */
  orientation: DeviceOrientation;
}

/** Forced kiosk screen orientation. 'auto' = follow the tablet's own sensor. */
export type DeviceOrientation = 'auto' | 'landscape' | 'portrait' | 'landscapeReverse' | 'portraitReverse';

/** One structured log line from a kiosk (payments, reader events, errors). */
export interface DeviceLog {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail: string;
}

/** A single-use pairing code the volunteer types into the tablet app (TTL ~10 min). */
export interface PairCode {
  /** Six digits. */
  code: string;
  /** Epoch milliseconds when the code stops working. */
  expiresAt: number;
}

export const getDevices = () => request<{ devices: Device[] }>('/api/admin/devices');

export const createPairCode = () => request<PairCode>('/api/admin/devices/pair-code', { method: 'POST' });

export const renameDevice = (id: string, name: string) =>
  request<Device>(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name }) });

/** Set a kiosk's forced screen orientation (delivered to the tablet on its next check-in). */
export const setDeviceOrientation = (id: string, orientation: DeviceOrientation) =>
  request<Device>(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ orientation }) });

export const revokeDevice = (id: string) =>
  request<{ ok: true }>(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const identifyDevice = (id: string) =>
  request<{ ok: true }>(`/api/admin/devices/${encodeURIComponent(id)}/identify`, { method: 'POST' });

export const getDeviceLogs = (id: string) =>
  request<{ logs: DeviceLog[] }>(`/api/admin/devices/${encodeURIComponent(id)}/logs`);

/** Set (4–8 digits) or clear (empty string) the kiosk exit PIN. The server hashes it and
 *  syncs it to every kiosk; a non-empty, non-4–8-digit value 400s. */
export const setKioskPin = (pin: string) =>
  request<{ set: boolean }>('/api/admin/pin', { method: 'PUT', body: JSON.stringify({ pin }) });

// ── Giving-screen designer ──────────────────────────────────────────────────────
// The amounts/messages the kiosk shows. Amounts are integer MINOR units (no float ever reaches
// Stripe). Saving pushes live: kiosks pick up the change on their next heartbeat.
export type PromptPolicy = 'off' | 'optional' | 'required';

export interface GivingConfig {
  presetsMinor: number[];
  allowCustom: boolean;
  customMinMinor: number;
  customMaxMinor: number;
  monthlyEnabled: boolean;
  /** Allow keyed/manual card entry (Stripe's on-device card form) as well as / instead of the reader. */
  manualEntryEnabled: boolean;
  namePolicy: PromptPolicy;
  emailPolicy: PromptPolicy;
  thankYouMessage: string;
  /** Force the tablet to maximum screen brightness (a wall kiosk should be as bright as possible). */
  maxBrightness: boolean;
  /** Small tagline shown at the bottom of the kiosk giving screen ('' hides it). */
  footerText: string;
  /** When a donation is at/above this many MINOR units, the kiosk gently suggests a cheaper
   *  alternative (bank transfer / Zelle QR) before the card. 0 disables the prompt. */
  largeAmountThresholdMinor: number;
  /** The note shown on that large-amount screen (bank details / instructions). */
  largeAmountNote: string;
  /** '/uploads/…' | 'https://…' | '' — an optional QR/image on the large-amount screen. */
  largeAmountImage: string;
  /** Play a fireworks celebration on the thank-you screen after a successful donation. */
  celebrateEnabled: boolean;
  /** Only celebrate when the gift is at least this many MINOR units (0 = celebrate every gift). */
  celebrateThresholdMinor: number;
}

/** Per-campaign kiosk appearance: 'light' (bright), 'dark', or 'auto' (bright unless a dark bg image). */
export type CampaignTheme = 'auto' | 'light' | 'dark';

/** Campaign type — required; drives the card-fee rule. Donation: admin may offer fee-covering.
 *  Zakat: fee always covered by the donor. Tuition: admin chooses whether to require it. */
export type CampaignType = 'donation' | 'zakat' | 'tuition';

/** The full giving-designer state: the giving config + the currency, masjid name and attract
 *  headline that share the same live-push mechanism. */
export interface GivingSettings {
  giving: GivingConfig;
  currency: string;
  masjidName: string;
  attractTitle: string;
}

/** Fields the designer can save (all optional — send only what changed). */
export type GivingPatch = Partial<GivingConfig> & { attractTitle?: string; masjidName?: string };

export const getGiving = () => request<GivingSettings>('/api/admin/giving');

export const saveGiving = (body: GivingPatch) =>
  request<GivingSettings>('/api/admin/giving', { method: 'PUT', body: JSON.stringify(body) });

// ── Campaigns (giving appeals shown as kiosk tabs) ────────────────────────────────
// Each appeal is its own giving screen: its amounts, colour, images, thank-you, monthly /
// cover-fees, and (optionally) its own Stripe account. The MAIN campaign is always shown on
// the kiosk (even when `live` is off) and can't be deleted. Amounts are integer MINOR units.
export interface Campaign {
  id: string;
  title: string;
  /** Required campaign type — drives the card-fee rule (see coverFees/forceCoverFees). */
  type: CampaignType;
  description: string;
  /** '#rrggbb' background colour for this tab, or '' to inherit. Drives the giving-screen gradient. */
  primaryColor: string;
  /** '#rrggbb', or '' to inherit the default accent. Drives the tiles' "Donate" band + buttons. */
  accentColor: string;
  /** '/uploads/…' | 'https://…' | '' — this tab's full-screen background. */
  backgroundImage: string;
  coverImage: string;
  logo: string;
  presetsMinor: number[];
  allowCustom: boolean;
  customMinMinor: number;
  customMaxMinor: number;
  monthlyEnabled: boolean;
  coverFees: boolean;
  /** Zakat-only: forces every donation on this campaign to cover the card fee (the donor is
   *  told fees must be covered because it's Zakat). Implies coverFees. */
  forceCoverFees: boolean;
  /** '' inherits the global default thank-you. */
  thankYouMessage: string;
  /** Kiosk appearance for this tab. */
  theme: CampaignTheme;
  /** Which kiosks show this campaign. Empty = all kiosks; otherwise only these device ids. */
  deviceIds: string[];
  /** '' = the primary (reader) Stripe account. */
  stripeAccountId: string;
  live: boolean;
  isMain: boolean;
  sortOrder: number;
  createdAt: string;
}

/** The editable subset sent when creating/updating a campaign (title required on create). */
export type CampaignPatch = Partial<
  Pick<
    Campaign,
    | 'title'
    | 'type'
    | 'description'
    | 'primaryColor'
    | 'accentColor'
    | 'backgroundImage'
    | 'coverImage'
    | 'logo'
    | 'presetsMinor'
    | 'allowCustom'
    | 'customMinMinor'
    | 'customMaxMinor'
    | 'monthlyEnabled'
    | 'coverFees'
    | 'forceCoverFees'
    | 'thankYouMessage'
    | 'theme'
    | 'deviceIds'
    | 'stripeAccountId'
    | 'live'
  >
>;

/** Everything the Campaigns editor renders from: the campaigns (already sorted main first), the
 *  currency, and the Stripe accounts a campaign can settle to (empty when standalone). */
export interface CampaignsData {
  campaigns: Campaign[];
  currency: string;
  /** The paired kiosks a campaign can be targeted at ("show on which kiosk"). */
  devices: { id: string; name: string }[];
  accounts: StripeAccountRef[];
  /** The reader (primary) account id; a campaign on a different account is keyed-entry only. */
  primaryAccountId: string;
  /** A Stripe account is configured on this device (the standalone fallback). */
  hasLocal: boolean;
}

export const getCampaigns = () => request<CampaignsData>('/api/admin/campaigns');

export const createCampaign = (patch: CampaignPatch) =>
  request<{ campaign: Campaign }>('/api/admin/campaigns', { method: 'POST', body: JSON.stringify(patch) });

export const updateCampaign = (id: string, patch: CampaignPatch) =>
  request<{ campaign: Campaign }>(`/api/admin/campaigns/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });

export const deleteCampaign = (id: string) =>
  request<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const reorderCampaigns = (ids: string[]) =>
  request<{ campaigns: Campaign[] }>('/api/admin/campaigns/reorder', { method: 'POST', body: JSON.stringify({ ids }) });

export const setMainCampaign = (id: string) =>
  request<{ campaigns: Campaign[] }>(`/api/admin/campaigns/${encodeURIComponent(id)}/main`, { method: 'POST' });

/** Upload ONE image (background / cover / logo) and get back its '/uploads/…' URL. Uses fetch +
 *  FormData (the server wants multipart, not JSON) and unwraps { data: { url } }, throwing the
 *  friendly { error } on failure (too big, wrong type, or an expired session). */
export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(withBase('/api/admin/upload'), { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as { data?: { url: string }; error?: string };
  if (!res.ok || body.error || !body.data) {
    throw new Error(body.error || 'That image couldn’t be uploaded — please try another.');
  }
  return body.data.url;
}

// ── Donations log + totals + CSV ────────────────────────────────────────────────
/** A recorded donation (recorded only after the server verified it with Stripe). Amounts are
 *  integer MINOR units; `createdAt` is ISO; `deviceName` is '' if that kiosk was removed. */
export interface Donation {
  id: string;
  paymentIntentId: string;
  deviceId: string;
  deviceName: string;
  campaignId: string;
  campaignTitle: string;
  amountMinor: number;
  currency: string;
  kind: string; // 'one_time' | 'monthly'
  status: string; // 'succeeded' | other
  donorName: string;
  donorEmail: string;
  chargeId: string;
  createdAt: string;
}

/** Succeeded-donation totals (integer minor units) + a per-kiosk breakdown. */
export interface DonationTotals {
  today: number;
  thisWeek: number;
  thisMonth: number;
  allTime: number;
  count: number;
  average: number;
  byDevice: { deviceId: string; deviceName: string; amountMinor: number; count: number }[];
}

export interface DonationsData {
  donations: Donation[];
  totals: DonationTotals;
  currency: string;
}

export const getDonations = () => request<DonationsData>('/api/admin/donations');

/** Fetch the donations CSV as a Blob. Uses fetch (not a plain <a download>) so an expired session
 *  surfaces an error instead of silently saving the 401 JSON body as "donations.csv". */
export async function fetchDonationsCsv(): Promise<Blob> {
  const res = await fetch(withBase('/api/admin/donations.csv'), { headers: { accept: 'text/csv' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || 'Couldn’t export — please sign in again and retry.');
  }
  return res.blob();
}
