<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

## 0.2.1
- **Fix: the OpenMasjidOS wallpaper now shows in the kiosk.** Custom wallpaper *images* are
  proxied through the app's own HTTPS origin (`/api/public/wallpaper`) — the platform serves
  them over plain HTTP, which a secure page otherwise blocks as mixed content; this also
  fixes on-image text readability (canvas luminance). Named preset wallpapers + the accent
  colour already inherited. Note: the OS **"ambient" video** backdrop is a per-device local
  setting and is deliberately not shared over the Fabric, so it can't be inherited — pick a
  preset or a wallpaper image in OpenMasjidOS for the kiosk to match.

All notable changes to **OpenMasjid Kiosk**. The version here, `VERSION`, `manifest.yaml`,
the `server/`+`web/` `package.json`, and the git tag `vX.Y.Z` all move together — bump them
on every published build so OpenMasjidOS offers a normal **Update** (no reinstall).

## 0.2.0
- **Payments setup** (admin → Settings → Payments): pick your Stripe account from
  OpenMasjidOS via the Fabric (in-app account picker, no keys pasted), or enter keys
  manually when running standalone.
- **Stripe Terminal Location** management — create a location from your masjid address, or
  pick an existing one (readers must connect to a location).
- **Currency** selection, a **TEST MODE** badge whenever test keys are in use, and a
  **Test connection** button that mints a Terminal connection token to confirm Stripe +
  the reader path work end-to-end.
- Masjid name + address collected in-app (the platform injects no profile).
- Under the hood: Stripe Terminal server SDK (pinned API version), keys held in memory only
  (never sent to the tablet/browser, never persisted).

## 0.1.0
- Initial release. OpenMasjidOS app: one container (Fastify + SQLite + React admin),
  digest-pinned multi-arch image, AGPL-3.0.
- **OpenMasjidOS Fabric:** single sign-on with a local-password fallback, live
  theme/wallpaper inheritance (including custom wallpaper images), restore-resilience,
  best-effort notifications.
- **OpenMasjidOS-style admin shell:** bottom dock (Dashboard / Devices / Analytics /
  Settings), a profile menu (light-dark toggle, Settings, Sign out, version).
- **`/new` tablet setup page** serving the bundled Android APK; **6-digit** pairing model
  (no camera/QR).
- Android kiosk app shell (Kotlin + Compose), CI to GHCR + APK bundling.
