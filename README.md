<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->
<p align="center">
  <img src="assets/Kiosk - rounded corners (1).png" alt="OpenMasjid Kiosk" width="280"/>
</p>

<h1 align="center"><b>OpenMasjid Kiosk</b></h1>

<p align="center">
  <a href="#how-it-works">How it works</a> |
  <a href="#install">Install Guide</a> |
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

Six one-tap amounts, custom amounts, monthly giving and email receipts — a passer-by
donates in under ten seconds. Everything is managed from a simple admin page on your
OpenMasjidOS: choose your Stripe account, design the giving screen, and pair a tablet by
typing a 6-digit code (no camera needed). The tablet locks into a full-screen giving station that can only be
exited with a PIN you set.

> **Status: v0.1.0 — in active development.** This repo is being built in vertical
> slices (see [`CLAUDE.md`](CLAUDE.md) §17). Slice 1 is the scaffold: the container
> boots, serves the themed admin shell, a health check, and the `/new` setup page.
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
## How it works

```
 Android tablet (kiosk app) ──Bluetooth/USB──▶ Stripe Reader M2 ──▶ api.stripe.com
        │  pinned HTTPS (device token)
        ▼
 OpenMasjid Kiosk server (one container: API + admin web + SQLite + bundled APK)
        ├─ HTTPS (outbound) ──▶ api.stripe.com        (secret key: in memory only)
        └─ LAN ──▶ OpenMasjidOS Fabric                (SSO, Stripe account, alerts)
```

- **One container** serves the admin panel, the setup page (`/new`), the API, the SQLite
  store, and the Android APK it hands out.
- **The tablet** pairs over pinned HTTPS, drives the reader with the Stripe Terminal SDK,
  and shows a GiveALittle-simple giving flow.
- **Nothing inbound, no webhooks.** The tablet and server both make *outbound* calls to
  Stripe; that's all. It's a LAN device.

## Install

Install it from the **App Store inside your OpenMasjidOS dashboard** — one click, nothing
to configure. When it's running, press **Open**, then follow **Devices → Add kiosk** and
the on-screen setup at `http://<your-server>:8445/new` to set up a tablet.

(Runs on a Raspberry Pi or mini-PC, amd64 or arm64.)

## Card data & security

**Card numbers never touch this app.** The Stripe Reader M2 and the Stripe Terminal SDK
handle card data end to end (P2PE-style); our code only ever sees connection tokens and
PaymentIntent client secrets. The Stripe **secret key** is fetched from OpenMasjidOS and
kept **in server memory only** — never sent to the tablet or browser, never logged, never
written to disk. Every payment is verified server-side against Stripe before a donation is
recorded. See [`CLAUDE.md`](CLAUDE.md) §14 for the full security checklist.

## Develop & build

```bash
# server (API + static host)
cd server && npm install && npm run build && npm start

# admin web (Vite dev server proxies /api + /healthz to the server on :8080)
cd web && npm install && npm run dev

# Android kiosk app (needs JDK 17+ and the Android SDK)
cd android && ./gradlew assembleDebug

# the whole app as the App Store runs it
docker compose up -d      # → http://localhost:7878
```

Local dev uses Stripe **test keys** and the Terminal **simulated reader**, so the whole
flow runs without hardware. See [`docs/`](docs/) for tablet + reader setup.

## Source & license

Source code: <https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk>

**License: [AGPL-3.0-only](LICENSE).** © 2026 OpenMasjid-Solutions.


live. laugh. coffee.