<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjid Kiosk

**Turn an Android tablet and a [Stripe Reader M2](https://stripe.com/terminal) into a
beautiful tap-to-donate station for your masjid.** An app for
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS).

Six one-tap amounts, custom amounts, monthly giving and email receipts — a passer-by
donates in under ten seconds. Everything is managed from a simple admin page on your
OpenMasjidOS: choose your Stripe account, design the giving screen, and pair a tablet by
scanning a QR code. The tablet locks into a full-screen giving station that can only be
exited with a PIN you set.

> **Status: v0.1.0 — in active development.** This repo is being built in vertical
> slices (see [`CLAUDE.md`](CLAUDE.md) §17). Slice 1 is the scaffold: the container
> boots, serves the themed admin shell, a health check, and the `/new` setup page.

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
the on-screen setup at `http://<your-server>:7878/new` to set up a tablet.

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
