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

test('applying the suffix twice is a no-op (idempotent)', () => {
  // Defends against a rebuild that somehow passes an already-suffixed base through again.
  const once = applyVersionSuffix('0.10.1', '-dev');
  assert.equal(applyVersionSuffix(once, '-dev'), '0.10.1-dev');
});
