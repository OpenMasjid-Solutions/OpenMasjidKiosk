<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

## 0.4.5
- **Removed the "Restart" button.** Android doesn't let an app reboot the tablet unless the tablet
  is set up as a device owner, and the fallback (restarting just the app) was unreliable and looked
  like a crash. Rather than ship something that doesn't do what it says, it's gone. To restart a
  kiosk, power-cycle the tablet. (A proper device-owner-only reboot can return later if there's
  demand.)

## 0.4.4
- **Restart a kiosk remotely** (Admin → Devices → **Restart**): the tablet restarts on its next
  check-in — a full device reboot on tablets set up as device owner, or an app restart otherwise.
- **Removed the battery indicator** from the Devices page. Kiosk tablets are wall-powered, so the
  battery %/“not charging” line was just noise (and many tablets report “not charging” at 100%
  while plugged in). Reader status and app version remain.

## 0.4.3
- **Fix — the OpenMasjidOS theme AND wallpaper now reliably pass through.** The panel now always
  mirrors the dashboard's light/dark, accent and wallpaper on every open and refresh (it used to
  only sync when it *thought* it was running under the platform, and a light/dark toggle switched
  syncing off entirely — so a refresh fell back to defaults). A manual light/dark choice still
  holds for your current session. (Set an `https://` image URL in OpenMasjidOS → Settings.)
- The About/status now reports whether the app can see OpenMasjidOS, which makes "why isn't it
  inheriting?" easy to diagnose (it means the platform's address reached the app).

## 0.4.2
- **Fix — the OpenMasjidOS wallpaper now really inherits.** Choosing light/dark in the panel used
  to quietly switch off *all* appearance syncing, so after a refresh the panel fell back to the
  default background. Now the wallpaper and accent always follow OpenMasjidOS while the app is
  opened through it; only the light/dark choice stays as you set it. (Set an `https://` image URL
  in OpenMasjidOS → Settings.)

## 0.4.1
- **Fix — the OpenMasjidOS wallpaper now shows in the admin panel.** It now inherits the
  dashboard's custom wallpaper image exactly the way the other OpenMasjid apps do — the image URL
  you set in OpenMasjidOS is used directly (make sure it's an `https://` link). This also removes
  the internal image-proxy entirely, so the previous proxy's security hardening is no longer
  needed. (Named preset wallpapers + accent colour already inherited.)
- **Fix — "Identify" (flash to locate a kiosk) now actually stands out.** Tapping *Identify* in
  Admin → Devices makes the tablet pulse a bold gold wash for several seconds — easy to spot on a
  wall. Kiosks also now check in every 15s (was 45s), so Identify, config changes and online
  status show up much faster. (Devices with animations turned off get a strong steady wash.)

## 0.4.0
- **Card reader (Stripe Reader M2).** Set up and manage the reader from the kiosk's PIN-protected
  maintenance screen: choose **Bluetooth**, **USB**, or the built-in **Test reader**, find it,
  connect it to your card-reader location, and it handles firmware updates automatically. The
  reader auto-reconnects if it briefly drops, and its status, serial and battery now show on the
  **Devices** page so you can spot a flat or unplugged reader remotely.
- The reader talks to Stripe with a short-lived **connection token** the server mints on demand —
  the tablet never holds your Stripe secret key, and card data goes reader → Stripe only.
- New guide: **docs/READER_SETUP.md** (charging, Bluetooth vs USB, permissions, troubleshooting).
- Reader polish: denying a Bluetooth/Location permission now explains how to fix it (instead of the
  Find button doing nothing); scanning can't collide with an in-progress connection; and leaving
  kiosk mode now always requires a verified exit PIN (it can't be bypassed in the brief window
  after you set a PIN but before it reaches the tablet).
- **Security hardening of the wallpaper proxy** (also fixes the same issue introduced in 0.3.2):
  the server only fetches images from your OpenMasjidOS or a public address — never loopback,
  private, or cloud-metadata addresses, even via redirects — caps and times out the download so a
  bad image host can't wedge it, and refuses SVG (so a wallpaper can never run code on the admin
  page).
- Taking donations with the reader arrives in the next update.

## 0.3.2
- **Fix — the OpenMasjidOS wallpaper now shows even when the image URL is "unusual".** The
  proxy that brings your OS wallpaper onto the kiosk's secure page used to require the image
  host to label the file as an image; many hosts (and uploaded files) serve images as a
  generic download type, so the wallpaper silently failed. It now identifies the image from
  its actual contents (and, if needed, the file extension), sends a browser-like request so
  picky hosts don't refuse it, resolves uploaded/relative image paths against your OS, and
  waits a little longer for large images.

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
