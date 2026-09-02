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

/**
 * Append the update-channel suffix to a version string.
 *
 * NOTE: no suffix is passed on either channel any more — dev builds carry a real `X.Y.Z-dev.N`
 * prerelease in VERSION itself. This function is kept for the invariant it encodes, which still
 * matters: a suffix applied to only one half is a permanent false "update available".
 *
 * Historically a dev image was built with `APP_VERSION_SUFFIX=-dev` (Dockerfile ARG → ENV), and
 * the kiosk APK bundled inside it with the SAME value as its Gradle `versionNameSuffix`. Both
 * halves matter, and this is why:
 *
 * `latestAppVersion` (this value) is what the heartbeat tells a tablet, and the tablet decides an
 * update is available by plain string inequality against its own versionName. Suffix only the APK
 * and a dev tablet running 0.10.1-dev would compare itself against a server saying 0.10.1 —
 * permanently "update available", including immediately after updating. Suffixing both keeps the
 * comparison honest in all four combinations:
 *
 *   dev server + dev tablet        0.10.1-dev vs 0.10.1-dev   equal    → no update offered
 *   stable server + stable tablet  0.10.1     vs 0.10.1       equal    → no update offered
 *   dev server + stable tablet     0.10.1-dev vs 0.10.1       differ   → offered (correct)
 *   stable server + dev tablet     0.10.1     vs 0.10.1-dev   differ   → offered (correct)
 *
 * Empty on the stable channel, so a release is byte-for-byte what it was before this existed.
 * Pure and exported so the rule is unit-tested rather than asserted in a comment.
 */
export function applyVersionSuffix(base: string, suffix: string): string {
  // Conservative charset: this ends up in a version string that is compared, displayed on the
  // Devices page and shown on the tablet. Anything unexpected is dropped rather than rendered.
  const s = (suffix ?? '').trim();
  if (!s || !/^-[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/.test(s)) return base;
  // A version that ALREADY carries a prerelease says which channel it is on by itself, so there
  // is nothing to add — and adding anyway would produce "0.11.0-dev.1-dev", which is not a
  // version anyone can compare. CI stopped passing a suffix when dev builds started carrying
  // real X.Y.Z-dev.N versions; this makes re-enabling it harmless rather than corrupting.
  if (base.includes('-')) return base;
  return base.endsWith(s) ? base : `${base}${s}`;
}

/** Where the shipped CHANGELOG.md lives — the source for the admin panel's "What's new".
 *  It is copied next to the runtime in the image (/app/CHANGELOG.md); in dev it sits at the
 *  repo root, two levels above the compiled server. Serving the file that shipped WITH this
 *  image (rather than fetching GitHub) is the point: it always describes the version running. */
function findChangelog(): string {
  const fromEnv = env('CHANGELOG_PATH');
  if (fromEnv) return fromEnv;
  const candidates = [
    path.join(process.cwd(), 'CHANGELOG.md'), // the image: WORKDIR /app
    path.resolve(__dirname, '..', '..', 'CHANGELOG.md'), // dev: server/dist → repo root
    path.resolve(process.cwd(), '..', 'CHANGELOG.md'), // dev: cwd = server/
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

export const config = {
  port: intEnv('PORT', 8080),
  /** Bind all interfaces so the LAN (and Docker port mapping) can reach us. */
  host: env('HOST', '0.0.0.0'),
  dataDir: env('DATA_DIR', path.resolve(process.cwd(), 'data')),
  publicDir: env('PUBLIC_DIR', path.resolve(__dirname, '..', 'public')),
  /** The bundled Android KIOSK apk, served from the setup page (/new). Copied into the image
   *  at /app/public/download/openmasjidkiosk.apk; absent in local dev (then /new shows a
   *  friendly "coming after the first build" note). */
  apkPath: env('APK_PATH', path.resolve(__dirname, '..', 'public', 'download', 'openmasjidkiosk.apk')),
  /**
   * The bundled **OpenMasjid Mobile Donations** apk — the handheld app a volunteer carries at a
   * fundraising event, as opposed to the locked-down wall kiosk.
   *
   * Served the same way and from the same folder, so the Dockerfile's existing `COPY apk/` picks
   * both up with no change. Its presence is checked independently of the kiosk's: /new only offers
   * an app it can actually hand over, which is the same rule that stops the kiosk button appearing
   * on a build that has no APK in it.
   */
  mobileApkPath: env('MOBILE_APK_PATH', path.resolve(__dirname, '..', 'public', 'download', 'openmasjidmobile.apk')),
  /** The release notes this build shipped with (admin panel → "What's new"). */
  changelogPath: findChangelog(),
  /** This build's version, read from the package.json shipped beside the runtime — "0.11.0" on a
   *  release, "0.11.0-dev.3" on a development build, because VERSION itself now carries the
   *  prerelease. The suffix pass is a no-op in practice (CI passes none on either channel); it is
   *  kept only so that re-enabling it could never corrupt a version. See [applyVersionSuffix]. */
  version: applyVersionSuffix(readVersion(), env('APP_VERSION_SUFFIX')),

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
  /** Our public URL when the platform exposes us over its Cloudflare tunnel (manifest
   *  `domain: true` + `tunnel: true`); empty otherwise. A convenience MIRROR of the intended
   *  exposure the platform injects immediately, used to seed the base path before the async
   *  /api/fabric/site fetch completes. NOT the live source of truth — that stays /api/fabric/site.
   *  Not a secret; not persisted. */
  omosPublicUrl: env('OPENMASJID_PUBLIC_URL', '').replace(/\/+$/, ''),
};

/** True when running embedded under OpenMasjidOS with the Fabric available. */
export function ssoConfigured(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

export type Config = typeof config;
