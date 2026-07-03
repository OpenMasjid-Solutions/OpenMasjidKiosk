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

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
