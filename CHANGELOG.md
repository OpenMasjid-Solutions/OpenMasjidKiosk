<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

## 0.9.22
- **Fixed the campaign live preview.** It now sits full-width at the top of the editor and reliably
  shows both the portrait and landscape giving screens (it was rendering broken before).
- **More readable giving screen** — larger text, and a darker, higher-contrast secondary text colour on
  the bright background (kiosk + preview).
- **Bigger "Choose your own amount" button** — a bold, filled pill instead of a thin outline.
- **Better on-screen keyboard** — the number row is now a compact strip (not a second bank of letter
  keys), and double-tapping ⇧ toggles CAPS LOCK (tap ⇧ again to turn it off).
- Kiosk-side changes (giving screen, keyboard) need a tablet app update; the preview fix is admin-only.

## 0.9.21
- **Remote adoption — completed on the tablet.** A tablet at another site can now finish pairing over
  your OpenMasjidOS Cloudflare tunnel: it validates the real (public) certificate with standard system
  trust + hostname checking, so there's no certificate warning to accept and the cert can renew freely.
  Kiosks on your own network keep the existing self-signed trust-on-first-use pinning. The tablet picks
  the right mode automatically from the address you enter. **(Requires updating the tablet app.)**

## 0.9.20
- **Remote kiosk adoption (server + admin half).** A tablet at another site can be paired over your
  masjid's OpenMasjidOS **Cloudflare tunnel** — no VPN or port-forwarding. In **Devices → Add a kiosk**
  there's a new **Remote (another site)** tab: turn on Remote access in OpenMasjidOS and expose the
  kiosk, then flip **Allow remote adoption** (off by default) and it shows the tablet's public address +
  a pairing code.
- **Only the kiosk surface is exposed.** The server is now base-path aware; over the tunnel it serves
  only the setup page, the app download, and the device connection — the **admin panel stays on your own
  network** (admin/login/session routes are refused on internet requests). Turning remote access on does
  not change anything on your LAN.
- *The tablet app update in the next release completes remote pairing end-to-end (pairing over the real
  Cloudflare certificate).* Admin-panel changes here need no tablet update.

## 0.9.19
- **Clearer "Add a kiosk" screen.** It now shows the exact **server address** to type on the tablet
  (this admin page's own address) with a one-tap Copy button — and warns you if you're viewing it on
  localhost (which a tablet can't reach). The pairing code is now clearly labelled too, so it's obvious
  what goes in each field on the tablet. Admin-only; no tablet update needed.

## 0.9.18
- **Reimagined campaign designer.** The editor is now a roomy two-pane window: tabbed settings
  (Design · Amounts · Type & fees · Payments · Kiosks · Message) beside a **live, true-to-device
  preview of both the portrait and landscape giving screens**. The preview now mirrors the tablet
  exactly — real two-tone tiles, colours, per-orientation columns, and bright/dark scenes.
- **Per-kiosk campaign targeting, both ways.** Each campaign's new **Kiosks** tab sets exactly which
  kiosks show it (new campaigns go to **all kiosks** by default; turn that off to pick specific ones);
  the **Devices** page now lists which campaigns each kiosk is currently showing.
- Admin-panel only — no tablet app update is needed for this release.

## 0.9.17
- **Bigger, easier on-screen keyboard.** The kiosk keyboard now has taller, thumb-friendly keys and a
  **number row** across the top, so donors can type a name or email quickly. (Requires updating the
  tablet app.)

## 0.9.16
- **On-screen keyboard fixed for rotated kiosks.** When you rotate the screen, the donor name/email
  step now uses the kiosk's **own** on-screen keyboard, which rotates with the giving screen — the
  system keyboard used to appear sideways because it's a separate part of the tablet that doesn't
  rotate with the app. (Requires updating the tablet app.)

## 0.9.15
- **Screen rotation that actually works on any tablet.** The kiosk now **rotates its own UI** by the
  angle you choose, instead of asking the tablet to rotate — many tablets ignore that request, which is
  why the setting did nothing before. In **Admin → Devices**, “Rotate screen” now offers **0° / 90° /
  180° / 270°**; pick whichever makes the screen upright on your mount. (Requires updating the tablet
  app to this version.) The giving screen also re-flows to two columns when the rotated result is
  portrait.

## 0.9.14
- **Typed card entry is card-only now.** Entering a card by hand no longer shows the “Link” / bank-
  account (ACH) option — just the card number, expiry and CVC. (Requires updating the tablet app.)
- **More reliable web-set orientation.** The screen orientation you choose in Admin → Devices is now
  applied and re-asserted at the app level, so it takes hold and sticks. **Note:** orientation is a
  tablet-app feature — a kiosk must be updated to this version for the web control to move it.

## 0.9.13
- **Portrait-friendly kiosk.** The giving screen now adapts to a portrait tablet — the amount tiles
  re-flow into two tall columns and everything scales to fit (landscape still uses the wide layout).
- **Set the screen orientation from the web.** In **Admin → Devices**, each kiosk has an
  **Orientation** control (Auto / Landscape / Portrait / flipped 180°). The tablet is forced to that
  orientation regardless of its own auto-rotate, so a wall mount always sits upright.
- **Choose which kiosks show a campaign.** Each campaign can be set to show on **all kiosks** or only
  **specific** ones (Admin → Campaigns → “Show on which kiosks”). Your main campaign always shows
  everywhere.
- **Colour themes.** The campaign editor now has one-tap **colour presets** (a primary + accent that
  go well together). Picking one just fills the colour fields — you can still fine-tune either.

## 0.9.12
- **Campaign type (Donation / Zakat / Tuition).** Every campaign now has a required **Type** that sets
  the card-fee rule (matching OpenMasjid Donations):
  - **Donation** — you can *offer* donors the option to cover the card fee (their choice on the tablet).
  - **Zakat** — the fee is *always* covered by the donor, so the full Zakat reaches the masjid; the
    kiosk tells the donor it's added because it's Zakat.
  - **Tuition** — you choose whether to *require* the payer to cover the fee.

## 0.9.11
- **Much bigger, bolder amounts.** The donation numbers now fill the tile — large and heavy — so
  they're easy to read across the room, and the **“Donate”** button band is taller with bigger text
  so it's the obvious thing to tap.
- **Colour-coded, bigger tabs.** Each campaign tab is now tinted with that campaign's own colour and
  is larger and bolder, so it's clear which appeals you can switch between.
- **No more cut-off descriptions.** Campaign titles and descriptions now have a character limit (with
  a live counter in the editor), and the giving screen fits a fuller description without clipping.

## 0.9.10
- **Two colours: a primary and an accent.** Each campaign now has a **Primary colour** (a soft wash
  behind the giving screen) and an **Accent colour** (the “Donate” band on each amount tile and the
  buttons) — like the reference design. Set both in Admin → Campaigns.
- **Bigger, bolder amounts + a touch of glass.** The amount numbers are now large and heavy black on
  clean white tiles with a subtle glass sheen, so they read at a glance from across the room.
- **Fireworks on a gift.** Turn on **“Celebrate donations with fireworks”** in Kiosk settings and a
  short, joyful fireworks animation plays on the thank-you screen — for every gift, or only for gifts
  at or above an amount you choose. (Respects the tablet’s reduced-motion setting.)
- **Campaign logo now shows.** The logo you set on a campaign now appears at the top of that
  campaign’s giving screen.
- **Bluetooth reader:** longer auto-discovery window so a slow/asleep reader is found more reliably on
  each reconnect attempt (on top of the v0.9.9 background health checks).

## 0.9.9
- **Bigger, bolder amount buttons.** The six giving amounts are now much larger and use a two-tone
  design — a big amount on the tile with a solid coloured **“Donate”** band beneath — so they read
  instantly across a room.
- **Seamless “Enter card details”.** Tapping to type a card no longer flashes a “Sorry — that didn’t
  go through” message for a moment before the card form opens; it now goes straight to a calm
  “Opening card entry…” and then the card page.
- **More reliable card reader.** The kiosk now keeps the reader connected with regular background
  checks: if the reader ever drops silently (a cable knock, a Bluetooth blip, waking from sleep) the
  kiosk notices within seconds and reconnects on its own, and corrects its status display to match.

## 0.9.8
- **Zakat: require covering the card fee.** A new campaign switch, **“Require donors to cover card
  fees (only for Zakat)”** (Admin → Campaigns), always adds the card fee to a Zakat gift and tells the
  donor on the kiosk that the fee is added *because it’s Zakat*, so the full Zakat reaches the masjid.
- **A gentler option for large gifts.** In **Kiosk settings** you can set a **large-donation
  threshold** plus a note and an image (e.g. a Zelle/bank-transfer QR code). When someone chooses a
  gift at or above that amount, the kiosk first suggests the cheaper way to give — they can still tap
  **“Give by card”** and continue, knowing card fees are higher on large amounts.
- **Cleaner, flat giving screen.** Removed the glassy look — the amount buttons and the typed-card
  screen are now solid, flat and easy to read (GiveALittle-style), in both the bright and dark themes.

## 0.9.7
- **Fixed the typed-card screen.** The card form was overflowing off the top of the screen (only the
  Pay/Cancel buttons showed) and sat see-through over the giving screen — so a donor couldn’t actually
  enter a card. It’s now a clean, opaque, full-screen card page that scrolls if needed, with Stripe’s
  card fields clearly shown. This also fixes keyed payments failing because the card couldn’t be typed.
- **Countdown-to-menu during a donation.** Once a donation is started, the same small countdown ring
  appears in the corner and returns to the menu after inactivity (with a longer, patient window while
  the card form is open, so a slow typer is never cut off).
- Softer, cleaner glass on the amount buttons.

## 0.9.6
- **Nicer donation buttons.** The amount buttons now have a proper liquid-glass look — a soft
  rim-light edge and a gentle sheen instead of the flat, hard border.
- **Editable bottom tagline.** The small line at the bottom of the giving screen (previously always
  “OpenMasjid Solutions”) can now be changed — or hidden — in **Admin → Campaigns → Kiosk settings →
  Bottom tagline**.
- **Clearer “cover the fee” note.** When a donor is offered to cover the card fee, it now explains
  that this is the **Visa / Mastercard / Amex** card fee — not a platform fee — and that OpenMasjid
  Solutions is free, unlimited, forever.

## 0.9.5
- **Redesigned the giving screen to the full-screen layout you wanted.** The masjid name + tagline
  sit across the top, then a big, edge-to-edge grid of donation buttons (three across) — each with a
  large amount, a “Donate” label and an accent bar — a small “Choose your own amount”, and a subtle
  footer. The buttons have a touch of glass transparency. Replaces the cramped centred card.

## 0.9.4
- **Typed card entry rebuilt to actually work on a locked kiosk.** Keyed card payments now use
  Stripe’s own card form (Payment Element) inside the app — the same technology as OpenMasjidDonations
  — so the card’s security check happens *in the app* and never needs the external browser that a
  fully-locked (device-owner) tablet blocks. Enter the card, pay, done. (The card number goes straight
  into Stripe and is never seen by our app or server.)
- **Nicer giving screen.** A polished liquid-glass card with **six big, easy-to-read amount buttons**
  and a **small “Other amount”** — a blend of GiveALittle and the OpenMasjidDonations look.
- **“Cover the card fee” moved to the details step.** After you pick an amount, the option to cover
  card fees sits next to the name/email, and shows the **exact extra it adds** (e.g. “+$0.60”).
- Bigger campaign editor and click-through donation details from the previous update carry over.

## 0.9.3
- **Fix — typing a card now works on a locked-down kiosk.** Keyed card entry couldn’t complete on a
  device-owner (fully locked) tablet because the card’s security check (3-D Secure) needs to briefly
  open the browser, and lock-task mode was blocking it. The kiosk now allows that secure browser step
  (it has no address bar and returns automatically, so the kiosk stays locked), and keyed payments are
  card-only for a cleaner, more reliable form. Tap-to-pay was always fine.
- **Brighter, bolder giving screen.** The kiosk now shows big, full-screen, frosted-glass amount
  tiles (GiveALittle-style) on a vibrant, bright background, and the tablet is forced to **maximum
  brightness**. Each campaign’s **Appearance** (Bright / Dark / Auto) and the **Force maximum screen
  brightness** switch are configurable in the admin panel.
- **Bigger campaign editor.** The campaign editor is now a roomier, more spacious window.
- **Donation details.** Tap any donation in the Donations log to open a details window (amount, date
  & time, donor name & email, campaign, kiosk, payment id).

## 0.9.2
- **Manual (typed) card entry is now always available when paying.** Every card screen shows an
  **“Enter card details”** button — with or without a reader connected — so a donor can always pay
  even if the reader is being fussy. (It’s no longer hidden behind a setting; the old toggle is gone.)
  Note: your Stripe account must have **online card payments enabled** — being set up for the
  in-person reader isn’t enough. If keyed entry ever fails, the exact reason shows in Devices → Logs.
- **The hidden maintenance gesture (7 taps) works everywhere again.** Tap 7 times anywhere on the
  screen background — on any screen — to reach the PIN unlock. (Tapping amount buttons or the number
  pad won’t trigger it by accident.)
- **Removed the Cancel button from the main giving screen.** Cancel now only appears once a donation
  is under way (after you choose an amount).

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
