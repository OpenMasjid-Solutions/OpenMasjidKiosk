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
}

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
