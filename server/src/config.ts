// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Environment configuration, read on EVERY process start. The OpenMasjidOS Fabric
 *  values (OPENMASJID_*) are injected by the platform at install and are empty on a
 *  standalone install; per the Fabric restore-resilience rules they must be read fresh
 *  each start and NEVER persisted (the platform rewrites the base URL on a restore-to-
 *  new-machine and may rotate the secret). Secrets read here are server-side only and
 *  must never be logged or sent to the browser/tablet. */
import fs from 'node:fs';
import path from 'node:path';

function env(name: string, def = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? def : v;
}
function intEnv(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

/** Read this app's version from the package.json shipped next to the runtime
 *  (copied to /app/package.json in the image). Falls back gracefully in dev. */
function readVersion(): string {
  for (const p of [path.join(process.cwd(), 'package.json'), path.join(__dirname, '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return '0.1.0';
}

export const config = {
  port: intEnv('PORT', 8080),
  /** Bind all interfaces so the LAN (and Docker port mapping) can reach us. */
  host: env('HOST', '0.0.0.0'),
  dataDir: env('DATA_DIR', path.resolve(process.cwd(), 'data')),
  publicDir: env('PUBLIC_DIR', path.resolve(__dirname, '..', 'public')),
  /** The bundled Android APK, served from the setup page (/new). Copied into the image
   *  at /app/public/download/openmasjidkiosk.apk; absent in local dev (then /new shows a
   *  friendly "coming after the first build" note). */
  apkPath: env('APK_PATH', path.resolve(__dirname, '..', 'public', 'download', 'openmasjidkiosk.apk')),
  version: readVersion(),

  /** OpenMasjidOS Fabric (the platform↔app SSO + appearance + Stripe + notifications
   *  layer). Injected by the platform at install; empty on a standalone install, where
   *  the app uses its own login + own appearance. The wire identifiers (env var names,
   *  header, cookie, endpoints) are the shared Fabric contract and must stay byte-for-
   *  byte. See docs/ARCHITECTURE.md. Used from slice 2 onward. */
  omosBaseUrl: env('OPENMASJID_BASE_URL', '').replace(/\/+$/, ''),
  omosAppId: env('OPENMASJID_APP_ID', ''),
  /** Per-app secret issued by the platform to `sso: true` apps. SSO is identity-bound:
   *  we must present this on Fabric calls or the platform fails closed. It is a
   *  CREDENTIAL — never log or expose it. */
  omosAppSecret: env('OPENMASJID_APP_SECRET', ''),
};

/** True when running embedded under OpenMasjidOS with the Fabric available. */
export function ssoConfigured(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

export type Config = typeof config;
