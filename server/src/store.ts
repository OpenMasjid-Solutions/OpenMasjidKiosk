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
    `);
    // Tighten file perms where the OS supports it (the admin hash + signing secret live here).
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort (e.g. Windows dev) */
    }
    log.info(`data store ready at ${dbPath}`);
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

  /** The versioned config a paired kiosk pulls. Amounts/messages/wallpaper arrive with the
   *  giving-screen designer (later slice); slice 4 syncs the PIN, currency and location. */
  getKioskConfig(): { version: number; config: Record<string, unknown> } {
    return {
      version: this.getConfigVersion(),
      config: {
        pinHash: this.getPinHash(),
        currency: this.getCurrency(),
        locationId: this.getLocation()?.id ?? '',
        masjidName: this.getMasjid().name,
        attractTitle: this.getAttractTitle(),
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

  listDevices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as Record<string, unknown>[]).map((r) => this.rowToDevice(r));
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
