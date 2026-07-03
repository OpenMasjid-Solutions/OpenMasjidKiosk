<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

## 0.3.1
- **Fix — pairing now works.** The tablet was reading responses at the top level but the
  server wraps them in a `{ data }` envelope, so pairing (and every kiosk call) failed with
  "something went wrong" even though the server had already created the device. The kiosk
  app now unwraps the envelope.
- **Fix — "Remove" hides a kiosk.** Revoked devices are excluded from the Devices list, so
  removing a kiosk makes it disappear (its token still dies, so the tablet returns to
  pairing on its next heartbeat).
- **HTTP → HTTPS.** Insecure browser visits are upgraded to HTTPS automatically (the app
  learns its HTTPS address from the platform proxy) so no one lands on a non-secure page.
  (The tablet already refuses anything but pinned HTTPS.)

## 0.3.0
- **Pair a tablet & manage your kiosks** (Admin → Devices): generate a single-use **6-digit
  pairing code** (no camera/QR) and type it into the kiosk app; then see each kiosk's live
  status (online, battery + a "not charging" warning, reader, app version), rename, identify
  (flash it), view its logs, and revoke it. Set the kiosk **exit PIN** here — staff type it
  to leave the giving screen; it's verified on the tablet even offline.
- **Android kiosk app:** pairs over **pinned HTTPS** with trust-on-first-use certificate
  pinning + a device token; runs as a Lock-Task launcher (device-owner) with a screen-
  pinning fallback and keep-awake; a hidden 5-tap corner gesture opens the PIN-protected
  maintenance screen (diagnostics, re-pair, exit); WorkManager + a foreground loop send
  heartbeats. (The card reader + the giving flow are the next updates.)
- Security: device tokens are HMAC-hashed at rest and revocable; pairing codes are single-
  use, 10-minute, and rate-limited; the exit PIN is a portable scrypt hash.

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
