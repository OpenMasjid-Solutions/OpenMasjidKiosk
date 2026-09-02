<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjid Mobile Donations — a volunteer's phone at a fundraising event

The second Android app in this repo. The [kiosk](TABLET_SETUP.md) is a tablet bolted to a wall that
takes donations unattended; this is an ordinary phone in a volunteer's hand at a dinner, a bazaar or
a collection round.

They share almost everything underneath — the server client, pairing, the device token, the Stripe
Terminal driver, the design tokens all live in the `:core` Gradle module — and differ entirely in
the shell around it.

## What it is, and what it deliberately is not

| | Kiosk (`:app`) | Mobile Donations (`:mobile`) |
|---|---|---|
| Device | A tablet the masjid owns, mounted, always powered | A volunteer's **own** phone |
| Lockdown | HOME launcher, Lock Task, exit PIN, boot receiver, watchdogs | **None of it.** Home, Back and Recents all work |
| Who uses it | A stranger, unaided | A volunteer, fifty times an evening |
| Card reader | Stripe Reader M2 over Bluetooth or USB | The same |
| Monthly giving | Yes | **No** — see below |
| Distribution | Sideload from `/new` | The same |

**It never locks the phone down.** No `CATEGORY_HOME`, no Lock Task, no device-admin receiver, no
boot receiver, no `REQUEST_INSTALL_PACKAGES`, no keep-screen-on. Every one of those is right for a
wall tablet and wrong for a phone somebody puts back in their pocket and takes a call on.

**`applicationId` is `org.openmasjidos.mobile`.** Separate from the kiosk's, so both can be
installed on one device without either replacing the other.

**No monthly giving.** A standing order needs a name and an email address, and nobody fills in a
form at a fundraising table with a queue behind them. Monthly belongs on the kiosk or the website.

**No Google Play.** It is bundled into the server image and downloaded from the masjid's own server,
exactly like the kiosk app. Nothing to sign up for, and no store review between a fix and a
volunteer having it. (Play would also have forced a strictly increasing `versionCode` per upload,
which is the opposite of what a sideloaded app wants — see below.)

## Setting one up

1. On the phone, open the masjid's setup page: **`https://<your-server>/new`**.
2. Choose **Mobile donations**, download, and allow the install when Android asks.
3. In the admin panel, **Devices → Add** gives you a 6-digit code (single use, 10 minutes).
4. In the app, type the **same address** and the code. Give the phone a name the masjid will
   recognise — "Ahmad's phone" — because several people may be collecting at once.
5. Press **Find my reader**, allow Bluetooth and location, and pick the M2.

### Doing all of that from anywhere

This is the point of the app, so it is worth stating plainly: **none of the above needs the masjid's
Wi-Fi.** If the masjid has Remote access turned on in OpenMasjidOS and **Allow remote adoption**
enabled in this app's admin panel, a volunteer at a hotel forty miles away opens the masjid's public
address on their own phone and completes every step over it.

That works because `/new`, the APK download, pairing and the payment endpoints are all reachable
over the OS Cloudflare tunnel (`server/src/tunnel.ts` allow-lists `/api/kiosk/*`; `/download` is not
under `/api` and falls through). The admin panel is **not** reachable — that stays LAN-only.

The app picks its TLS mode from the address typed, not from a setting: a private-range address gets
self-signed trust-on-first-use pinning, and anything public gets ordinary system-CA validation with
hostname verification. There is no "remote?" switch for anyone to set wrong.

## Taking a donation

Pick the fund, tap a preset or type any amount, hand the reader over, next person.

**A donation is recorded only after the masjid's own server has confirmed it with Stripe.** The
phone reports what the reader did and is told the outcome; it never decides that money moved. That
is the same rule the kiosk follows and it is why a lost or stolen phone cannot invent a donation.

**If the card is read but the server cannot be reached**, the app says neither "failed" nor "thank
you" — it does not know. It tells the volunteer the card may have been charged and to check the
Donations page rather than take it again. Read that message literally if you ever see it.

## Things that will come up

**Location permission for a card reader.** Android asks, and it looks wrong. It is Stripe's Terminal
SDK requiring it before it will look for *any* reader — Bluetooth or USB. The app says so on screen.
It never uses location for anything else, and the Bluetooth scan is declared `neverForLocation`.

**"Don't ask again".** If a volunteer declines a permission permanently, Android will not show the
dialog again no matter what the app does. The reader screen offers a button straight to the phone's
permission settings, which is the only place it can be undone.

**USB on a phone** usually needs an OTG adapter, which nobody has in a hall. Bluetooth is the
practical choice for walking around; USB is there for a phone propped on a table.

**Backups are off** (`allowBackup="false"`), deliberately. The app holds a device token that can
create charges against the masjid's Stripe account; letting it ride out to a personal cloud backup
and restore onto a different phone would clone that authority silently. Re-pair instead — it takes
ten seconds.

**Battery.** A phone driving a Bluetooth reader all evening will drain. Bring a power bank.

## For maintainers

- `versionCode` is a hardcoded `1`, matching the kiosk and for the same reason: an equal
  `versionCode` is a permitted **reinstall**, so an APK can be swapped in either direction. Bumping
  it would make an older build a genuine downgrade that Android refuses to install, which is a trap
  on a volunteer's phone mid-event.
- `versionName` comes from the repo-root `VERSION`, so the app, the kiosk and the server always
  agree about which release they belong to.
- CI builds and signs both APKs in one Gradle invocation and publishes them as the `kiosk-apk` and
  `mobile-apk` artifacts; `build-image.yml` fetches both into `apk/` and the Dockerfile copies the
  folder wholesale. The server checks for each independently, so `/new` offers exactly the apps the
  image actually contains and never shows a dead button.
- Both apps are signed with the **same** key. Android identifies them separately by
  `applicationId`, so there is no reason to manage two.
