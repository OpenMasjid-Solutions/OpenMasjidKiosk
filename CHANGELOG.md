<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

## 0.9.1
- **Fix — the app failed to start after updating to 0.9.0 on an existing install** (“no such column:
  campaign_id”, container restart-looping). The new donations “campaign” columns were being indexed
  before they’d been added to an already-existing database. Fixed the upgrade to add the columns
  first; upgrading now migrates cleanly and your existing donations are preserved.

## 0.9.0
- **Multiple giving campaigns, shown as tabs.** The kiosk no longer starts on a “Tap to donate”
  screen — it opens straight on your **main campaign’s** giving screen (amounts, one-time/monthly).
  Add more appeals (e.g. Zakat, Building Fund) in the new **Campaigns** admin tab; each becomes its
  own tab across the top of the kiosk, with **its own colour, background image, logo, amounts,
  monthly option, cover-fees option and thank-you message**. The first tab is your always-shown main
  campaign.
- **Auto-return to the main campaign.** When a donor opens another appeal and then walks away, the
  kiosk returns to the main campaign after 45 seconds of no touches — shown as a small, wordless
  countdown ring. Any touch resets it, and it never interrupts a donation in progress.
- **Per-campaign Stripe accounts.** A campaign can settle to a different Stripe account. Note: the
  physical card reader is tied to your primary account, so a campaign pointed at a *different* account
  is taken by **keyed (typed) card entry** rather than the reader — the admin panel says so clearly.
- **Cover the card fee (optional).** Turn this on for a campaign and donors can choose to add the
  estimated card fee so your masjid receives their full gift.
- **Manual card entry, improved.** When **no reader** is connected the kiosk now automatically takes
  cards by keyed entry; when a reader **is** connected, an admin toggle decides whether the “Enter
  card details” button appears on the card screen.
- **Bluetooth reader — connection hardened.** The app now fully stops scanning and binds to the
  freshest reader before connecting (the common cause of “Bluetooth unexpectedly disconnected during
  operation”), retries a transient drop with a clean re-scan, and logs the exact Stripe error **code**
  to Devices → Logs so a stubborn reader is finally diagnosable.
- Donations are now tagged by campaign in the log and CSV export.

## 0.8.2
- **Fix — “Exit kiosk” really leaves now, even when the kiosk is the tablet’s Home app.** On a
  locked-down (device-owner) tablet the kiosk *is* the launcher, so simply going Home came straight
  back to it. Exit kiosk now hands the Home role to the tablet’s **own** launcher, so it drops you out
  to the normal Android home screen. Re-opening the kiosk app makes it the launcher again.
- **New — “Open Android settings” in the maintenance screen.** After unlocking with the exit PIN you
  can jump straight to the tablet’s Android settings (Wi-Fi, launcher, etc.); the kiosk re-locks itself
  as soon as you come back.

## 0.8.1
- **Manual card entry: the real failure reason is now shown.** When a keyed payment can't even start,
  the exact Stripe reason is written to **Devices → Logs** (`payment_create_failed`) instead of a
  generic message. The most common cause is that **online card payments aren't switched on for your
  Stripe account** — being set up for the in-person reader (Terminal) is separate. Enable it in the
  Stripe Dashboard → **Settings → Payment methods → Cards**, then retry. (The keyed-payment setup was
  also aligned to Stripe's recommended configuration.)
- **Fix — “Exit kiosk” now actually leaves to the tablet’s normal launcher.** On a device-owner
  tablet it hands the Home role back to the device’s own launcher; otherwise it opens Android’s
  Home-app picker so you can switch. (Before, Home just reopened the kiosk.)

## 0.8.0
- **Donations log + totals + CSV export (new “Donations” tab).** See every donation your kiosks have
  taken — amount, kiosk, time, one-time vs monthly, donor (if given) and status — newest first, with
  running totals for **today / this week / this month / all time**, a **per-kiosk breakdown**, and a
  one-click **Export CSV**. The dashboard’s Donations tile now shows your real all-time total. (Only
  successful donations count toward totals; monthly *renewals* are charged by Stripe and shown in your
  Stripe dashboard, not here — these figures are what the kiosks collected directly.)
- The CSV is safe to open in Excel/Sheets: donor-supplied fields are escaped against spreadsheet
  formula injection, and the export (which contains donor details) requires an admin sign-in.

## 0.7.5
- **Fix — manual card entry now works** (it was showing “that didn’t go through”). Stripe’s card form
  wasn’t being set up in time; the tablet now initialises it up front (from the publishable key sent
  with your settings), so the form opens and takes the card. If a manual payment ever does fail, the
  exact reason is now written to **Devices → Logs** so it can be diagnosed.
- **Fix — updating the kiosk from the tablet now actually works.** Because the kiosk is the tablet’s
  Home app, it couldn’t reach the browser before. Now **7 taps → PIN → Update app** first **leaves
  kiosk mode**, then opens the new app in the browser to download and install; it relaunches into
  kiosk on the new version. The admin panel’s remote “Update” button (which couldn’t reliably work)
  is gone — the **Update available** note now shows these step-by-step tablet instructions instead.

## 0.7.4
- **Manual card entry (type the card, no reader needed).** Turn on **“Allow manual card entry”** in
  **Admin → Giving screen** and donors can pay by typing their card into Stripe’s secure form —
  either as a fallback beside the reader (an **“Enter card details”** option on the payment screen)
  or as the only way to pay when the kiosk has **no reader** at all. The card is entered into Stripe’s
  own form and tokenised on the device, so your server never sees the card number (same as the
  reader). Every payment is still verified with Stripe before it’s recorded. Manual entry is one-time
  only (monthly still needs the reader). *Note: keyed cards cost a little more and carry more fraud
  risk on an unattended kiosk, so it’s off by default.*
- **Reader setup: the “Test reader” option is gone**, and there’s clear guidance for running with **no
  reader** (use manual card entry). USB and Bluetooth readers are unchanged.

## 0.7.3
- **Bluetooth readers now stay connected on their own — just like USB.** Once you connect a
  Bluetooth M2 in the tablet's settings, the kiosk remembers it and **reconnects it automatically on
  boot and whenever it drops** (a Bluetooth blip, the reader sleeping, a reboot). No more re-pairing
  by hand each time.
- **Clearer help for the “Bluetooth unexpectedly disconnected” error.** This almost always has one of
  two simple causes, so the kiosk now says exactly what to do: (1) **don't** pair the reader in the
  tablet's own Bluetooth settings — if you did, tap **Forget** there — and connect it only from the
  app; (2) **charge the reader to at least 50%** (its first connection may install a required update).

## 0.7.2
- **Fix — the Giving-screen editor now actually reaches the tablets, and the Monthly option shows.**
  The kiosk was fetching your saved giving screen but then dropping the amounts, monthly setting,
  name/email choices and thank-you message before saving them locally — so edits never appeared and
  the One-time/Monthly toggle never showed. The tablet now stores and applies the whole giving
  screen, and pulls it fresh on every launch, so your changes show within seconds (and after an app
  update, right away).
- **Fix — pressing Home no longer lets someone leave or switch launcher.** The kiosk now asks to be
  the tablet’s default Home app (there’s also a **“Set as Home app”** button in the tablet’s
  settings), so Home returns straight to the giving screen with no chooser. On a **device-owner**
  tablet it’s fully locked — Home, recents and the notification shade are all disabled; you can’t
  even press Home.
- **Fix — a kiosk shows offline much faster.** Tablets now check in every ~10 seconds and are marked
  offline after ~35 seconds (about three missed check-ins), and the Devices page refreshes every ~10
  seconds — instead of taking a couple of minutes.

## 0.7.1
- **Fix — updating the app no longer says “App not installed”.** The app is now signed with a
  permanent key, so future updates install straight over the old app with nothing lost. (Until now
  each build was signed with a throwaway key, which Android refuses to update over.) **One-time step:**
  because the signing key has changed, *this* update needs the current app **uninstalled first**, then
  install v0.7.1 from the setup page and re-pair. Your donation history is safe — it lives on the
  server, not the tablet — so you won’t lose analytics. Every update after this one is seamless.
- **Fix — the kiosk can no longer be left by pressing Home or Recents.** It now works like a proper
  single-app kiosk: leaving instantly drops you back into the giving screen, and it reopens on boot.
  (It no longer uses Android’s escapable “screen pinning”.) For a *fully* locked tablet — with the
  notification shade blocked too — set the app as the default Home app and use the one-time
  device-owner setup in docs/TABLET_SETUP.md; the app tells you this in its settings.

## 0.7.0
- **Design your giving screen (new “Giving” tab).** Set the masjid name and headline, the six preset
  amounts, custom-amount on/off with a min & max, monthly on/off, whether to ask for a name/email
  (off / optional / required), and the thank-you message — with a **live preview** of the tablet as
  you type. Saving pushes the changes to every paired kiosk within a few seconds (no reinstall).
- **USB card readers connect on their own.** Plug a USB Stripe reader into the tablet and it pairs
  automatically on startup — no setup screen — and **reconnects itself the moment it drops** (a
  knocked cable, a power blip). Bluetooth readers are still set up by hand in the tablet’s settings.
- **A truly locked kiosk (on a device-owner tablet).** When the tablet is set up as *device owner*
  (one-time ADB step, see docs/TABLET_SETUP.md), the kiosk now blocks the **notification shade**, the
  navigation buttons and the Home escape, and re-opens itself if Home is pressed — it can only be
  left with the **exit PIN**. Screen-pinning (the non-device-owner fallback) can’t fully prevent
  those, and the app now says so clearly and points you to the device-owner setup.

## 0.6.0
- **Monthly donations!** The giving screen now has a **One-time / Monthly** toggle (when you enable
  monthly in the app). A monthly donor taps their amount, enters name + email (required), and taps
  their card once: that first month is charged on the reader, and an ongoing **monthly subscription**
  is set up from that same card — the next charge is a month later (never double-charged), and Stripe
  emails the receipts automatically. If a card can't be reused for recurring giving, the one-time gift
  still counts and the donor is told kindly. You can see active subscriptions in your Stripe dashboard.
- **The tablet now clearly confirms a donation.** After the card is read it shows a **"Processing…"**
  step, then a thank-you that names the **amount given** (and, for monthly, "set up") — so a
  successful tap is unmistakable. Payment success/failure is also logged more clearly (Devices → Logs).
- **Update a kiosk from the admin panel — for real this time.** When a kiosk is out of date, press
  **Update** on its card: the tablet opens the newest app in its own browser to download and install
  (the same way you first installed it). There's step-by-step help right on the card, and the same
  **Update app** button is in the tablet's 7-tap maintenance screen. (Android won't let an app update
  itself without a person tapping "Install", so this opens that install for them.)
- **Light-mode tablets are readable again.** The kiosk is a dark-by-design giving station, so it now
  always renders dark — a tablet set to a light system theme no longer shows unreadable settings.
- **Fix — the activity-log window no longer overlaps the cards behind it.** It now floats above a
  properly dimmed page (it was being trapped inside a panel).

## 0.5.5
- **Removed the "push update to the tablet" button.** Android doesn't allow an app to update itself
  without a person tapping "Install", and inside kiosk mode even that is blocked — so a remote,
  hands-off update isn't possible on an ordinary tablet (only on ones provisioned as *device owner*).
  Rather than a button that can't deliver, the Devices page and the kiosk's own settings now just
  show **"Update available"** with clear instructions: download the latest app from your setup page
  and reinstall it on the tablet. (Automatic updates for device-owner tablets can come later.)

## 0.5.4
- **Open kiosk settings with 7 quick taps.** Tap the giving screen 7 times fast (anywhere) to bring
  up the exit-PIN, then the maintenance/settings screen — reader setup, install app updates, kiosk
  stats (now including **uptime**), and leaving kiosk mode. (Was a hidden corner tap; now it's
  anywhere on the screen.)
- **Reader firmware visibility.** When a reader needs a firmware update to connect, that's now
  logged (Devices → Logs) and shown on-screen with progress. A first connect after the reader was
  used elsewhere often triggers this — it needs the reader **charged to ≥50%** and can take a few
  minutes; keep it powered and nearby.

## 0.5.3
- **The activity log is now a proper draggable window** — bigger, centred on screen, and you can
  drag it around by its title bar. Removed the (non-functional) green "full-screen" light; the red
  light closes it.

## 0.5.2
- **Push app updates to a kiosk from the admin panel.** When a kiosk is running an older version
  than the server, an **Update to vX.Y.Z** button appears on its card (Devices). Tapping it tells
  the kiosk to download the new app and start installing on its next check-in. The kiosk also shows
  an **Install update** button in its maintenance screen when a newer version is available.
  Note: Android only lets an app update itself silently on tablets provisioned as **device owner**;
  otherwise a volunteer taps "Install" once on the tablet (same limitation as remote reboot).

## 0.5.1
- **Fix — the Dashboard now shows the real number of paired kiosks** (it was always showing 0).
- **Fix — a kiosk's activity log now opens as its own window** (dimmed backdrop, macOS-style
  traffic-light close) instead of overlapping the cards behind it.
- **Reader troubleshooting.** When a reader won't connect, the exact reason is now written to the
  kiosk's log (Devices → Logs) — most often "Payments aren't set up yet" (choose a Stripe account
  and create a card-reader location in Settings → Payments first) or the reader's own error. Scan,
  connect and connection-token steps are all logged.

## 0.5.0
- **Take donations!** The kiosk now runs the full giving flow on the tablet: tap **Tap to donate**,
  pick one of six amounts (or **Other** on a big number pad), optionally add a name/email for a
  receipt, then tap/insert/swipe on the reader. A warm thank-you shows and it resets for the next
  giver. Amounts are validated on the server and every payment is verified with Stripe before it's
  recorded — the tablet's word is never trusted, and card data goes reader → Stripe only.
- The giving screen (amounts, custom min/max, name/email prompts, thank-you message) is read from
  the app's settings; a visual designer for it comes next.

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
