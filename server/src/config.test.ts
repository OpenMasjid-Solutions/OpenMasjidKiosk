// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVersionSuffix } from './config';

// The update-channel suffix. This value is what the heartbeat reports as `latestAppVersion`, and
// the tablet decides an update is available by plain string inequality against its own APK
// versionName — which CI stamps with the SAME suffix. These tests pin the arithmetic of that
// comparison, because getting it wrong is silent: a dev tablet would either nag forever or never
// be offered anything at all.

test('the stable channel is untouched — no suffix, byte-for-byte the package version', () => {
  assert.equal(applyVersionSuffix('0.10.1', ''), '0.10.1');
  assert.equal(applyVersionSuffix('0.10.1', '   '), '0.10.1');
  // An absent env var arrives as '' from config's env() helper; undefined is defended anyway.
  assert.equal(applyVersionSuffix('0.10.1', undefined as unknown as string), '0.10.1');
});

test('the dev channel appends its suffix', () => {
  assert.equal(applyVersionSuffix('0.10.1', '-dev'), '0.10.1-dev');
  assert.equal(applyVersionSuffix('1.0.0', '-dev'), '1.0.0-dev');
  // Surrounding whitespace is trimmed, not rejected: a trailing newline out of a shell variable
  // is a normal accident, and "-dev\n" plainly means "-dev". The Gradle side trims identically
  // before its own regex, so both halves agree on what a suffix is.
  assert.equal(applyVersionSuffix('0.10.1', ' -dev '), '0.10.1-dev');
  assert.equal(applyVersionSuffix('0.10.1', '-dev\n'), '0.10.1-dev');
});

test('all four server/tablet combinations compare the way the update check needs', () => {
  // The tablet's rule, verbatim from MaintenanceScreen.kt:
  //   updateAvailable = latestAppVersion != appVersion
  const offered = (server: string, tablet: string) => server !== tablet;
  const V = '0.10.1';
  const stableServer = applyVersionSuffix(V, '');
  const devServer = applyVersionSuffix(V, '-dev');
  const stableApk = V; // Gradle: no versionNameSuffix
  const devApk = `${V}-dev`; // Gradle: versionNameSuffix = "-dev"

  assert.equal(offered(devServer, devApk), false, 'a current dev tablet must NOT be nagged');
  assert.equal(offered(stableServer, stableApk), false, 'a current stable tablet must NOT be nagged');
  assert.equal(offered(devServer, stableApk), true, 'a stable tablet on a dev server should be offered the dev APK');
  assert.equal(offered(stableServer, devApk), true, 'a dev tablet on a stable server should be offered the stable APK');
});

test('this is the bug the pairing exists to avoid: suffixing only the APK nags forever', () => {
  // If the server did NOT carry the suffix, a correctly-updated dev tablet would compare
  // "0.10.1" against "0.10.1-dev" and report an update that installing can never resolve.
  const serverWithoutFix = '0.10.1';
  const devApk = '0.10.1-dev';
  assert.equal(serverWithoutFix !== devApk, true, 'demonstrates the permanent false positive');
  // With the fix both sides move together, so the same tablet is quiet.
  assert.equal(applyVersionSuffix('0.10.1', '-dev') !== devApk, false);
});

test('a nonsense suffix is dropped rather than rendered into the version', () => {
  // This string reaches the Devices page and the tablet's maintenance screen. It comes from our
  // own CI, but a typo in a build-arg should degrade to "stable-looking", never to garbage.
  for (const bad of ['dev', '--dev', '-', '-dev!', '-dev spaces', '-<script>', '-' + 'x'.repeat(40), '-dev/../x']) {
    assert.equal(applyVersionSuffix('0.10.1', bad), '0.10.1', `"${bad}" must be ignored`);
  }
});

test('a version that already carries a prerelease is left alone', () => {
  // Dev builds now ship a real prerelease version (X.Y.Z-dev.N) so the platform can DETECT and
  // notify about them — OpenMasjidOS compares the catalog's version with the installed one, and
  // the old scheme (stable version + moving :dev tag) changed nothing observable per build.
  // CI therefore stopped passing a suffix. If it is ever passed again, it must not corrupt the
  // version into something no comparison can order.
  assert.equal(applyVersionSuffix('0.11.0-dev.1', '-dev'), '0.11.0-dev.1');
  assert.equal(applyVersionSuffix('0.11.0-dev.12', '-dev'), '0.11.0-dev.12');
  assert.equal(applyVersionSuffix('0.11.0-rc.1', '-dev'), '0.11.0-rc.1');
  // A plain release version still takes one, so the old behaviour is intact where it applied.
  assert.equal(applyVersionSuffix('0.11.0', '-dev'), '0.11.0-dev');
});

test('the versioned dev scheme orders the way the platform needs', () => {
  // OpenMasjidOS compares dotted-numeric parts (util/version.ts), so X.Y.Z-dev.N puts N in the
  // fourth slot and increments compare correctly. The SHAPE is load-bearing: "0.11.0-dev1" would
  // collapse to [0,11,0] and never register as an update. Pinned here because this repo chooses
  // the version string that the platform then has to order.
  const cmp = (current: string, latest: string): boolean => {
    const a = current.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const b = latest.split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (y > x) return true;
      if (y < x) return false;
    }
    return false;
  };
  assert.equal(cmp('0.10.2', '0.11.0-dev.1'), true, 'stable → first dev build is an update');
  assert.equal(cmp('0.11.0-dev.1', '0.11.0-dev.2'), true, 'each dev build is an update');
  assert.equal(cmp('0.11.0-dev.9', '0.11.0-dev.10'), true, 'no lexical trap at 10');
  assert.equal(cmp('0.11.0-dev.2', '0.11.0-dev.1'), false, 'never offers a downgrade');
  assert.equal(cmp('0.11.0-dev.1', '0.11.0-dev.1'), false, 'same build is not an update');
  // The shape that would silently break it, kept as the contrast.
  assert.equal(cmp('0.11.0-dev1', '0.11.0-dev2'), false, 'X.Y.Z-devN does NOT work — needs the dot');
});

test('applying the suffix twice is a no-op (idempotent)', () => {
  // Defends against a rebuild that somehow passes an already-suffixed base through again.
  const once = applyVersionSuffix('0.10.1', '-dev');
  assert.equal(applyVersionSuffix(once, '-dev'), '0.10.1-dev');
});
