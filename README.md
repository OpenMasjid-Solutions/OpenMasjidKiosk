<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->
<p align="center">
  <img src="assets/Kiosk - rounded corners (1).png" alt="OpenMasjid Kiosk" width="280"/>
</p>

<h1 align="center"><b>OpenMasjid Kiosk</b></h1>

<p align="center">
  <a href="#what-it-does">What it does</a> |
  <a href="#how-it-works">How it works</a> |
  <a href="#install">Install</a> |
  <a href="#card-data--security">Security</a> |
  <a href="#develop--build">Develop & build</a>
</p>

<div align="center">
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk/releases">
    <img src="https://img.shields.io/github/v/release/OpenMasjid-Solutions/OpenMasjidKiosk?style=flat-square&color=blue" alt="Latest Release" />
  </a>
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk">
    <img src="https://img.shields.io/github/stars/OpenMasjid-Solutions/OpenMasjidKiosk?style=flat-square&color=blue" alt="Stars" />
  </a>
  <a href="https://discord.gg/MpPDbyQfaF">
    <img src="https://img.shields.io/badge/Discord-Join-blue?style=flat-square&logo=discord" alt="Discord" />
  </a>
</div>

<h5 align="center">
Leave a star if you like the project! ⭐️
</h5>

---

**Turn an Android tablet and a [Stripe Reader M2](https://stripe.com/terminal) into a
beautiful tap-to-donate station for your masjid.** An app for
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS).

A passer-by taps an amount, taps their card, and is thanked — in under ten seconds, with no
instructions. Everything behind it is managed from one admin page on your OpenMasjidOS:
run several appeals at once, take monthly giving, email branded receipts, collect school
tuition, and manage a fleet of tablets. Pair a tablet by typing a **6-digit code** — no
camera, no QR. The tablet then locks into a full-screen giving station that can only be
exited with a PIN you set.

> **Status: v0.10.1 — running in masajid.** Actively developed. See
> [`CHANGELOG.md`](CHANGELOG.md) for what landed when, and
> [`CLAUDE.md`](CLAUDE.md) for the full engineering contract.

---

## What it does

### Giving

- **Multiple appeals, shown as tabs.** General Fund, Zakat, Building Fund — each with its own
  **amounts, colours, background image, logo, thank-you message**, monthly on/off and
  cover-fees option. The kiosk opens on your main appeal and returns to it automatically when
  a donor walks away.
- **Six one-tap amounts + "choose your own"**, with a min and max you set.
- **One-time or monthly.** A monthly donor taps once: that first month is charged on the
  reader and an ongoing subscription is created from the same card. Never double-charged.
- **Tap, or type the card.** The Stripe Reader M2 over **Bluetooth or USB**, with automatic
  reconnection. Keyed card entry works as a fallback beside the reader, or as the only method
  when a kiosk has no reader at all.
- **Cover the card fee (optional).** Donors can add the estimated fee so the masjid receives
  the full gift. Always enforced for Zakat appeals, so the full zakat arrives.
- **Receipts.** Branded, Stripe-style email receipts through your OpenMasjidOS email provider
  — your logo, your wording, the amount, date, card and fund. Until you set email up, Stripe's
  own receipt is used, so a donor is never left without one.

### Tuition payments

If you also run [OpenMasjid Students](https://github.com/OpenMasjid-Solutions/OpenMasjidStudents),
an appeal can be a **Tuition** tile. A parent types their child's **Student ID**, confirms
"is this your child?", and sees the family's balance — **per child**, with each child's own
bills. They can pay the **whole balance**, **tick individual bills** (or individual lines
within a bill, like a book fee), **type any amount**, or **pay ahead** when nothing is due.
It is recorded in the school's ledger as a **payment**, never as a donation, and is kept out
of donation totals, receipts and year-end letters.

### Managing it

The admin panel has **Dashboard · Devices · Campaigns · Donations · Recurring · Settings**.

- **Devices** — pair a tablet with a 6-digit code; see each kiosk live (online, battery,
  charging, reader status and battery, app version); rename, revoke, flash-to-identify, rotate
  the screen, read per-device logs, and set the kiosk exit PIN. Pairing a kiosk at **another
  site** over the Cloudflare tunnel is a tab on the same screen.
- **Campaigns** — a two-pane designer with a **live, true-to-device preview** of the portrait
  and landscape giving screens, per-campaign Stripe accounts, and per-kiosk targeting (which
  tablets show which appeal).
- **Donations** — every donation with amount, kiosk, time, one-time/monthly, donor and status;
  running totals for today / this week / this month / all time; a per-kiosk breakdown; and a
  **CSV export** that is safe to open in Excel.
- **Recurring** — every monthly plan read **live from Stripe**: donor, amount, frequency,
  campaign, total raised, started/last/next charge, card and last four, and status in plain
  words. Open one to **pause** (nothing is collected, and nothing piles up), **cancel** (at the
  end of the paid period or immediately), or give it an **end date or a number of remaining
  payments** — plus the full renewal history with the reason any payment failed.
- **Settings** — the Stripe account picker (accounts come from OpenMasjidOS; keys are never
  pasted here), Terminal location, currency, masjid name and address, and the email-receipt
  designer with a live preview and a send-me-a-test button.

The server also keeps an **activity record** of the actions that reach outside the app —
cancelling, pausing or rescheduling someone's monthly donation, removing a kiosk, changing the
exit PIN — so a shared admin login can still be held to account. It is currently readable via
`GET /api/admin/audit`; it has no screen in the panel yet.

### The tablet

- **A real kiosk.** The app is the tablet's Home launcher and starts on boot. On a tablet
  provisioned as *device owner* (a one-time ADB step) it uses **Lock Task Mode** — no
  notification shade, no recents, no Home escape. Without that it uses screen pinning plus a
  re-launch watchdog, and tells you honestly what that can and can't stop.
- **Getting out:** 10 rapid taps in the corner → your **exit PIN** → the maintenance screen
  (reader setup, diagnostics, re-pair, update the app, Android settings, exit kiosk). The PIN
  is verified offline, so it works when the network is down.
- **Updates from inside the app** — the tablet downloads the new version over its own pinned
  connection and hands it to the system installer, without ever leaving the lockdown.
- **Remote kiosks.** A tablet at another site can pair over your OpenMasjidOS **Cloudflare
  tunnel** — no VPN, no port-forwarding. Off by default, and only the kiosk surface is exposed:
  the admin panel stays on your own network.

### Deliberately not included

No webhooks, no inbound ports, no public exposure of the admin panel. Refunds are done in the
Stripe dashboard (so a kiosk can never issue one). No Gift Aid, donor accounts, printed
receipts, iOS app, or offline payments yet.

## How it works

```
 Android tablet (kiosk app) ──Bluetooth/USB──▶ Stripe Reader M2 ──▶ api.stripe.com
        │  pinned HTTPS (device token)
        ▼
 OpenMasjid Kiosk server (one container: API + admin web + SQLite + bundled APK)
        ├─ HTTPS (outbound) ──▶ api.stripe.com     (secret key: in memory only)
        └─ LAN ──▶ OpenMasjidOS Fabric             (SSO · Stripe account · email · alerts
                                                    · OpenMasjid Students, for tuition)
```

- **One container** serves the admin panel, the setup page (`/new`), the API, the SQLite
  store, and the Android APK it hands out — so the app a tablet installs always matches the
  server it pairs to.
- **The tablet** pairs over HTTPS and pins the server's certificate on that first successful
  pair (trust-on-first-use), then drives the reader with the Stripe Terminal SDK.
- **Nothing inbound, no webhooks.** The tablet and server both make *outbound* calls to
  Stripe. Because there are no webhooks, the Recurring page reads Stripe live rather than
  showing you a cached status that might be wrong.

## Install

Install it from the **App Store inside your OpenMasjidOS dashboard** — one click, nothing to
configure. When it's running, press **Open**, sign in with your dashboard account, then go to
**Devices → Add kiosk**: it shows the exact address to type on the tablet and a 6-digit
pairing code.

Runs on a Raspberry Pi or a mini-PC (arm64 or amd64). The container listens on `8080` and is
published on host port `7878` by default; OpenMasjidOS picks another free port if that one is
taken, and serves the app over HTTPS with its own certificate.

### Update channels

| Channel | What you get |
|---|---|
| **stable** (default) | Released versions, digest-pinned. This is what a masjid should run. |
| **dev** | The `dev` branch, rebuilt on every push. For testing only. |

Switch with the Update Channel toggle in OpenMasjidOS. Dev builds report their version with a
`-dev` suffix so a test tablet is never mistaken for a production one.

## Card data & security

**Card numbers never touch this app.** The Stripe Reader M2 and the Stripe Terminal SDK handle
card data end to end (P2PE-style); for keyed entry the card is typed into Stripe's own form and
tokenised on the device. Our code only ever sees connection tokens and PaymentIntent client
secrets.

The Stripe **secret key** is fetched from OpenMasjidOS at start-up and kept **in server memory
only** — never sent to the tablet or browser, never logged, never written to disk. Every
payment is verified server-side against Stripe before a donation is recorded, so a tablet's
word is never enough. Amounts are always recomputed on the server from your configured presets
and bounds.

A full security audit lives in [`docs/audit/`](docs/audit/); the standing checklist is
[`CLAUDE.md`](CLAUDE.md) §14.

## Develop & build

All development happens on the **`dev`** branch — see the Branching policy at the top of
[`CLAUDE.md`](CLAUDE.md).

```bash
# server (API + static host)
cd server && npm install && npm run build && npm test

# admin web (Vite dev server proxies /api + /healthz to the server on :8080)
cd web && npm install && npm run dev

# Android kiosk app (needs JDK 17+ and the Android SDK)
cd android && ./gradlew assembleDebug

# the whole app as the App Store runs it
docker compose up -d      # → http://localhost:7878
```

Local dev uses Stripe **test keys** and the Terminal **simulated reader**, so the whole flow
runs without hardware.

**Docs:** [tablet setup](docs/TABLET_SETUP.md) · [reader setup](docs/READER_SETUP.md) ·
[architecture](docs/ARCHITECTURE.md) · [remote adoption](docs/REMOTE_ADOPTION.md) ·
[Students integration](docs/STUDENTS_INTEGRATION.md)

---

## Acknowledgements

Created by **Hasan Ismail**, with immense help from **Qari Ijaz** and **Osman Sayed**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://github.com/hasan-ismail">
          <img src="https://github.com/hasan-ismail.png?size=100" width="100px;" alt="Hasan Ismail"/><br />
          <sub><b>Hasan Ismail</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/ijazshare">
          <img src="https://github.com/ijazshare.png?size=100" width="100px;" alt="Qari Ijaz"/><br />
          <sub><b>Qari Ijaz</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/osayed0001">
          <img src="https://github.com/osayed0001.png?size=100" width="100px;" alt="Osman Sayed"/><br />
          <sub><b>Osman Sayed</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

Resources for this project were generously sponsored by **[An-Noor Institute](https://www.annoorusa.org/)**, **[Rihlatul Ilm Foundation](https://rifusa.org/)**, and **[AsmaTec Inc.](https://asmatec.com/)**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://www.annoorusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/An-noor2.png" width="120px;" alt="An-Noor Institute"/><br />
          <sub><b>An-Noor Institute</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://rifusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/RIFbetter.png" width="120px;" alt="Rihlatul Ilm Foundation"/><br />
          <sub><b>Rihlatul Ilm Foundation</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://asmatec.com/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/Asmatec.png" width="120px;" alt="AsmaTec Inc."/><br />
          <sub><b>AsmaTec Inc.</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

May Allah reward everyone who made it possible.

---

## Source & license

Source code: <https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk>

**License: [AGPL-3.0-only](LICENSE).** © 2026 OpenMasjid-Solutions.
