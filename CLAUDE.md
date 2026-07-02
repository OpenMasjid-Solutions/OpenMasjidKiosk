# CLAUDE.md — OpenMasjidKiosk

> This file is the single source of truth for the **OpenMasjidKiosk** app. Read it fully before writing any code. When in doubt, follow this document, then the references in §2, over your own assumptions. If something is ambiguous, ask before guessing.

---

## 1. What we are building (one paragraph)

**OpenMasjidKiosk** turns a wall-mounted Android tablet with a **Stripe Reader M2** into a beautiful tap-to-donate station for a masjid. It has **two parts in one repo**: (1) a **server** — a normal OpenMasjidOS app (one Docker container: Fastify API + admin web UI + SQLite) that holds all configuration, records donations, and talks to Stripe with the secret key it fetches from the **OpenMasjidOS Fabric**; and (2) an **Android app** — a Kotlin kiosk/launcher that a volunteer installs by browsing to the server's setup page (e.g. `http://192.168.1.x:7878/new`), downloading the APK, and scanning a pairing QR. The tablet shows a GiveALittle-style giving screen — **six preset amounts + a custom amount**, one-time or **monthly** — takes the card on the M2 reader (**Bluetooth or USB**), and shows a custom thank-you. The app is locked in kiosk mode and can only be exited with a **PIN set in the admin web UI**. Everything matches the OpenMasjidOS design language, is served over **HTTPS**, and is **AGPL-3.0-only**.

---

## 2. Prime directives — read the references first

This is an OpenMasjidOS app. The ecosystem lives in the **`OpenMasjid-Solutions`** GitHub org. Read these before and during the build; they are authoritative:

1. **`OpenMasjid-Solutions/OpenMasjidAPPS`** → **`docs/BUILDING_AN_APP.md`** — the hands-on app contract: repo layout, manifest/compose rules, security requirements (§2b), and the full **Fabric** spec (§7: appearance, `sso`, `notifications`, **`stripe`**, `https`, `domain`, and the **restore & migration resilience rules**). **`CLAUDE.md`** in that repo is the normative contract; **`docs/DESIGN.md`** is the design language (**Sakīna Glass** material, tokens, motion) every surface must match — including the Android app. **`docs/APP_LICENSING.md`**: official OpenMasjid apps are **AGPL-3.0-only**.
2. **`OpenMasjid-Solutions/OpenMasjidDonations`** — the Stripe reference. Mirror how it integrates the Fabric (`stripe: true`, the **in-app account picker** via `/api/fabric/stripe/accounts`, never persisting keys), its `server/` + `web/` shape, SSO with local-password fallback, and its donations log/CSV patterns.
3. **`OpenMasjid-Solutions/OpenMasjidDisplay`** — the structural template for repo layout, Dockerfile, CI to GHCR, and SSO/restore-resilience wiring.

**Hard rules (override everything except safety):**
- **License: AGPL-3.0-only.** Full LICENSE in the repo; a visible "Source code" link in the admin UI. Never copy umbrelOS/CasaOS code or definitions.
- **The Stripe secret key lives only in server memory**, fetched from the Fabric per process start. Never sent to the tablet or browser, never logged, **never persisted to the data volume** (Fabric rule). The tablet gets only **connection tokens** and **PaymentIntent client secrets**.
- **Card data is never touched by our code.** The M2 reader + Stripe Terminal SDK handle it end-to-end.
- **Never trust the tablet's word.** Every payment is verified server-side against Stripe before a donation is recorded.
- **Follow the current compose/security rules** in BUILDING_AN_APP.md §2/§2b — digest-pinned image, least privilege, **no discovery labels**, no host namespaces/sockets, settings single-line. These changed recently; when this file and those docs disagree, **those docs win** — flag it.

---

## 3. Repo & identity

- **Repo:** `OpenMasjid-Solutions/OpenMasjidKiosk` — a monorepo with three top-level parts:
  ```
  OpenMasjidKiosk/
  ├── manifest.yaml            # app manifest (repo root, per contract)
  ├── docker-compose.yml       # the stack OpenMasjidOS runs (repo root)
  ├── icon.svg                 # square, simple, legible small
  ├── screenshots/1.svg
  ├── Dockerfile               # builds web + server → one image; bundles the APK
  ├── LICENSE                  # AGPL-3.0-only
  ├── VERSION                  # single source of truth (server + APK versionName)
  ├── server/                  # Node 20 + TypeScript + Fastify + better-sqlite3
  ├── web/                     # React + Vite + Tailwind admin panel (+ /new page)
  ├── android/                 # Kotlin + Jetpack Compose kiosk app (Gradle)
  └── .github/workflows/       # build-image.yml (GHCR multi-arch) + build-apk.yml
  ```
  *(The building guide suggests repos named `openmasjid-<id>`; the shipped apps use the `OpenMasjidX` style. Keep `OpenMasjidKiosk` for consistency with Display/Donations — what must match is the **image name**: the compose references the lowercased repo, `ghcr.io/openmasjid-solutions/openmasjidkiosk`.)*
- **App `id`: `kiosk`** — same everywhere (manifest + registry entry). Category: `donations`.
- **Host port: `7878`** (container `8080`). The platform remaps conflicts and, because we set `https: true`, also serves us over **HTTPS on a dedicated port** with its own certificate — our container stays a plain HTTP server.
- **Image:** `ghcr.io/openmasjid-solutions/openmasjidkiosk:<version>@sha256:<digest>` — public, multi-arch (amd64 + arm64), **digest-pinned** in the compose.
- Registered by PR to OpenMasjidAPPS `registry.yaml`: `- id: kiosk / repo: OpenMasjid-Solutions/OpenMasjidKiosk / ref: v0.1.0` (ask the maintainer to pin an immutable `commit:` SHA per the guide).

---

## 4. Scope

### ✅ In scope (v1.0)
**Server (the OpenMasjidOS app)**
- One-click install (**no install settings** — everything is configured in-app, like Display).
- **Fabric:** `sso: true` (admin panel shares the dashboard login, with local-password fallback), `stripe: true` (**in-app Stripe account picker**), `https: true` (required for Stripe apps), `notifications: true` (best-effort "New donation" alerts — fail soft).
- **Admin panel:** Devices (kiosks), Giving-screen designer, Payments, Donations log, About.
- **`/new` onboarding page:** downloads the bundled APK + shows setup instructions and the pairing QR flow.
- **Device pairing & fleet management:** pairing codes/QR, per-device tokens, rename/revoke, heartbeats (online, battery, charging, reader status, app version), per-device logs, remote config push.
- **Payments engine:** Terminal **connection tokens**, Terminal **Location** management, PaymentIntent creation (card_present), server-side verification + capture, **monthly subscriptions** created from the reader's `generated_card`, Stripe email **receipts**, donations recorded in SQLite with totals + **CSV export**.
- Test-mode badge whenever a test key is in use.

**Android app (the kiosk)**
- Distributed via `/new` (sideload APK); on first run asks for / scans the **server address + pairing code** (QR carries URL, HTTPS cert fingerprint, and code).
- **Stripe Reader M2 over Bluetooth AND USB** — discovery, connect, battery level, required-update handling, auto-reconnect — all set up inside the app's (PIN-protected) settings.
- **GiveALittle-simple giving flow:** attract screen → 6 preset amounts + "Other" number pad → one-time / monthly → (optional) name & email, **both required for monthly** → tap/insert card → processing → **custom thank-you message** → auto-reset.
- **Kiosk mode:** the app is a HOME launcher, uses **Lock Task Mode** when provisioned as device owner (documented one-time ADB step), falls back to screen pinning; screen kept awake; auto-starts on boot; exit only via hidden gesture + **PIN set in the admin web UI**.
- Sends logs/heartbeats/status to the server; pulls theme + config (wallpaper, accent, amounts, messages) live.
- Matches the OpenMasjidOS design language (DESIGN.md) on Android: dark default, emerald/gold, spring motion, reduced-motion respect, RTL-ready.

### ❌ Out of scope (v1.0)
- Any handling of card numbers by our code (reader + Stripe only).
- Public/internet exposure, `domain: true`, or webhooks — the kiosk is a LAN device; **everything is outbound**. (Tablet + server both need outbound internet to Stripe; nothing inbound.)
- Gift Aid, refunds in-app (point admins at the Stripe dashboard), donor accounts, printed receipts, iOS, non-Stripe processors, offline payments (Terminal offline mode is a later feature).
- Play Store distribution (sideload via `/new` is the model; Play listing is a later decision).

### 🔭 Later (design for, don't build)
- Per-device amount presets & campaigns; Gift Aid; `domain: true` public giving links from the kiosk QR; Terminal offline mode; Play Store / managed provisioning (QR device-owner enrolment); WisePOS-style internet readers.

---

## 5. Architecture

```
   Android tablet (Kotlin kiosk app) ── Bluetooth / USB ──▶ Stripe Reader M2
        │        ▲                                              │ (encrypted card data)
        │        └── Stripe Terminal SDK ── HTTPS ──▶ api.stripe.com
        │ pinned HTTPS (device token)
        ▼
   OpenMasjidKiosk server (one container: Fastify + admin web + SQLite)
        │  • /new (APK + onboarding)      • pairing, devices, heartbeats, logs
        │  • connection tokens            • PaymentIntents + verify/capture
        │  • subscriptions (monthly)      • config push (theme, amounts, messages, PIN hash)
        │  • donations log + CSV          • admin panel (SSO via Fabric)
        ├── HTTPS (outbound) ──▶ api.stripe.com        (secret key, in memory only)
        └── LAN  ──▶ OpenMasjidOS Fabric  (${OPENMASJID_BASE_URL})
                     • /api/auth/session            (SSO check, X-OpenMasjid-App-Secret)
                     • /api/fabric/stripe/accounts  (list, no keys — in-app picker)
                     • /api/fabric/stripe?account=  (keys — per process start, memory only)
                     • /api/fabric/notify           (best-effort donation alerts)
                     • /api/public/appearance       (live theme)
```

Payment truth lives at Stripe; the donation record is written **only after the server retrieves the PaymentIntent from Stripe and confirms it succeeded** (and captures it if it is `requires_capture`). The tablet is a display + card-collection surface, never a source of truth.

---

## 6. Fabric integration (server)

Follow BUILDING_AN_APP.md §7 exactly; Donations is the working example.

- **Manifest flags:** `sso: true`, `stripe: true`, `https: true`, `notifications: true`.
- **Compose must reference** `${OPENMASJID_BASE_URL:-}`, `${OPENMASJID_APP_ID:-}`, `${OPENMASJID_APP_SECRET:-}` in `environment:` — without these lines the injected values never reach the container and the Fabric silently no-ops (the documented Display trap).
- **SSO:** on the request that loads the admin panel, forward the `omos_session` cookie (from the request only) server→server to `GET ${OPENMASJID_BASE_URL}/api/auth/session` with `X-OpenMasjid-App-Secret`. Identity assertion only; fail closed; cache ~45 s; mint our own session ≤ 1 h; **always** keep the local admin-password fallback so the panel works standalone and never bricks when the platform is unreachable (distinguish *SSO not configured* from *platform unreachable*).
- **Stripe account (this is "the Fabric gets the Stripe acc from the OS"):** the admin adds named Stripe accounts once in **OS Settings → Payments**. Our Payments screen lists them via `GET /api/fabric/stripe/accounts` (no keys) and stores only the chosen **account id**. On process start (and on account change) fetch keys via `GET /api/fabric/stripe?account=<id>` with the app secret; hold `publishableKey`/`secretKey` **in memory only**. Show a **TEST MODE** badge for `sk_test_`/`pk_test_`. Keep manual key entry as the **standalone fallback** only (platform absent), clearly labelled.
- **Restore resilience (required):** read `OPENMASJID_*` from env on every start; never persist them or fetched keys or a "linked" flag; all Fabric calls time out (~4 s) and fail soft to standalone.
- **Notifications:** after a successful donation, `POST /api/fabric/notify` (`"£20 donation received at the foyer kiosk"`, level `success`). Best-effort; never block or depend on it.

---

## 7. Devices: `/new`, pairing, and transport security

- **`/new`** (public route on the app's port): a friendly one-page setup guide — big "Download the kiosk app" button serving the **APK bundled into the server image at build time** (so the app version always matches the server), sideload instructions ("allow installs from your browser"), and "then scan the pairing code from **Admin → Devices**."
- **Pairing:** Admin → Devices → **Add kiosk** generates a **single-use pairing code (TTL 10 min)** and shows a **QR** whose payload is `{ v, httpsUrl, certSha256, code }` — the platform-served **HTTPS** URL and the SHA-256 fingerprint of its certificate. The app scans it (or the volunteer types the address + code), calls `POST /api/kiosk/pair` over HTTPS, and receives a long-lived **device token** (random 256-bit, hashed at rest server-side, shown never again).
- **Transport:** the tablet **only ever talks HTTPS** to the server, with the certificate **pinned to the fingerprint from pairing** (custom trust evaluation accepting exactly that cert/public key — correct for the platform's self-signed LAN certificate; never fall back to plain HTTP; re-pair if the fingerprint changes, with a clear admin-facing explanation). All kiosk API calls carry the device token; the server scopes every route to that device and rate-limits.
- **Fleet management:** heartbeat every ~45 s (`battery`, `charging`, `readerStatus`, `readerSerial`, `readerBattery`, `appVersion`, `configVersion`) → Devices page shows live status, flags "not charging" (a wall kiosk should always be on power) and "offline". Actions: rename, **revoke** (kills the token; kiosk returns to pairing), show QR again, *identify* (kiosk flashes), push config now. Structured device **logs** (payments, reader events, errors) viewable per device.
- **Config:** one versioned JSON (amounts, currency symbol, monthly on/off, name/email prompt policy, thank-you message, wallpaper, accent, theme, **kiosk-PIN hash**). Kiosks fetch on heartbeat when the version bumps; applied live with a gentle transition.

---

## 8. Payments (Stripe Terminal — the core)

Use the official **Stripe Terminal Android SDK** on the tablet and the **`stripe`** Node SDK on the server (pinned versions, fixed API version). The M2 is a Bluetooth-LE reader that on Android also supports **USB** — support **both**, selectable in the app's reader settings.

- **Connection tokens:** the app's `ConnectionTokenProvider` calls `POST /api/kiosk/connection-token` (device token auth); the server mints it via Stripe with the secret key. This is the only credential the tablet ever gets, and it's short-lived by design.
- **Location:** Terminal readers must connect with a `locationId`. On first Payments setup the server ensures a Terminal **Location** exists (named after the masjid, address entered by the admin — remember: the platform injects no profile) and hands its id to kiosks. Admin can pick an existing Location instead.
- **One-time donation flow:**
  1. Kiosk → `POST /api/kiosk/payment-intents` `{amountMinor, oneTime, donorName?, donorEmail?}` (server validates against the configured presets/min/max — never trust client amounts, integer minor units only, currency from Payments settings, idempotency key per attempt, metadata: device id, preset vs custom).
  2. Server creates the PaymentIntent with `payment_method_types: ['card_present']` and returns the client secret.
  3. App: `retrievePaymentIntent` → `collectPaymentMethod` (reader prompts tap/insert/swipe) → `confirmPaymentIntent`.
  4. App → `POST /api/kiosk/payment-intents/:id/complete`; **server retrieves the PI from Stripe**, captures it if `requires_capture`, verifies `succeeded`, records the donation, fires the notification, and returns the outcome the kiosk displays. Failures/cancellations are recorded as such and shown kindly ("Card didn't read — let's try again").
- **Monthly donations:** require **name + email** (enforced app **and** server). Flow: take the first payment on the reader as above; from the succeeded charge read `payment_method_details.card_present.generated_card` (the reusable card PaymentMethod Stripe derives from a card-present payment); create a **Customer** (name/email), attach it, and create a **Subscription** (monthly `price_data` for the chosen amount, e.g. product "Monthly donation — <Masjid>"). If `generated_card` is absent (some cards/networks can't be reused), the first donation still stands — tell the donor warmly that monthly couldn't be set up with this card and record the attempt. Ongoing renewals are charged by Stripe automatically; we do **not** track renewal events in v1 (no webhooks, LAN-only) — the admin sees subscriptions in Stripe.
- **Receipts:** set `receipt_email` on the PaymentIntent when the donor gave an email (Stripe emails the receipt for successful payments — note in docs the admin must have receipts enabled in Stripe settings); subscriptions get Stripe invoice receipts automatically. That satisfies "send receipts" with zero mail infrastructure.
- **Internet reality:** the Terminal SDK on the tablet talks to Stripe directly during collect/confirm, so **the tablet's Wi-Fi needs outbound internet**, as does the server. Nothing inbound, no webhooks, no public exposure. If the internet is down, the kiosk shows a friendly "Donations are taking a short break" screen and logs it.

---

## 9. The giving experience (Android UI)

GiveALittle-grade simplicity — a passer-by donates in under 10 seconds without instructions.

- **Attract screen:** the admin's wallpaper/design, masjid name, gentle motion, "**Tap to donate**".
- **Amounts:** a grid of **six admin-configured preset tiles** + "**Other amount**" (big custom number pad, min/max enforced). Huge type, thumb-size targets, currency from config.
- **Frequency:** One-time (default) / **Monthly** toggle. Monthly explains itself in one sentence and requires name + email.
- **Details step:** optional **name & email** for one-time donations (admin can set: off / optional / required; email enables a receipt) — skippable in one tap when optional. **Required for monthly, always.**
- **Card step:** "Tap, insert or swipe" with a calm reader animation; clear cancel; sensible timeouts back to attract.
- **Success:** the **custom thank-you message** from the admin (e.g. "JazākAllāhu khayran — your donation supports Al-Noor Masjid"), an understated celebratory moment, auto-return after ~8 s.
- **Errors:** one friendly line + retry ("That didn't go through — no charge was made. Try again?"). Never a raw error. Declines are worded neutrally.
- Portrait **and** landscape; high contrast on both themes; reduced-motion respected; RTL-ready; no sacred text in decorative chrome.

---

## 10. Kiosk mode, PIN & the launcher (Android)

- **Launcher:** the app declares `CATEGORY_HOME` + `CATEGORY_DEFAULT`, so the tablet boots straight into it and Home goes nowhere else.
- **Lock Task Mode:** when the app is **device owner**, use `startLockTask()` for true kiosk (no status bar pulldown, no recents/home escape). Document the one-time provisioning in `docs/TABLET_SETUP.md`: factory-reset tablet, skip accounts, `adb shell dpm set-device-owner com.openmasjid.kiosk/.KioskAdminReceiver`. **Fallback** without device owner: screen pinning (one-time confirm) + immersive-sticky; be honest in docs about its limits.
- **Stay awake:** keep-screen-on flag while in kiosk; recommend "always plugged in" mounts; report charging state so the admin sees a fallen cable.
- **Unlock:** hidden gesture (5 taps in the top-left corner within 3 s) → PIN pad → verifies against the **PIN set in Admin → Devices** (synced as an argon2 hash in config so unlock works offline; rate-limited with backoff; server-side verify when online). Unlock opens the maintenance screen: reader setup (BT/USB discovery, connect, update, battery), server address/re-pair, diagnostics, app version, **Exit kiosk** and **Return to kiosk**.
- **Boot & recovery:** BOOT_COMPLETED brings the app up even if not device owner; the app self-heals into the attract screen after crashes (foreground watchdog) and reconnects the reader automatically.
- **Permissions:** request-and-explain only what Terminal needs — Bluetooth scan/connect (API 31+) or location (older), USB host access — inside the PIN-protected settings, never in the donor flow.

---

## 11. The admin panel (web/)

Same SSO + design language as Donations. Sections:
- **Devices** — the fleet (§7): status cards, pairing, rename/revoke/identify, logs, the kiosk **exit PIN** (set/rotate here).
- **Giving screen** — the designer: 6 preset amounts (+ currency display), custom-amount on/off + min/max, monthly on/off, name/email prompt policy, **custom thank-you message**, **wallpapers/designs** (curated set + upload, like the OS), **accent colour**, dark/light, with a **live preview** of the kiosk screen.
- **Payments** — Fabric **Stripe account picker** (§6), Terminal **Location**, currency, test-mode badge; standalone key-entry fallback.
- **Donations** — log (amount, kiosk, time, one-time/monthly, donor if given, status), totals for today/this week/this month and by device, **CSV export**.
- **About** — version, docs links, **AGPL "Source code"** link.

---

## 12. `manifest.yaml` & `docker-compose.yml` (current contract — note the new rules)

```yaml
# manifest.yaml (repo root)
id: kiosk
name: OpenMasjid Kiosk
tagline: Tap-to-donate kiosk for a wall-mounted tablet with a Stripe card reader
category: donations
version: 0.1.0
author: OpenMasjid Solutions
license: AGPL-3.0-only
icon: icon.svg
screenshots:
  - screenshots/1.svg
description: |
  Turn an Android tablet and a Stripe Reader M2 into a beautiful donation
  station. Six one-tap amounts, custom amounts, monthly giving, email
  receipts — managed from a simple admin page on your OpenMasjidOS.
sso: true
stripe: true
https: true          # required: this app uses Stripe (see BUILDING_AN_APP §2b.5)
notifications: true
ports:
  - container: 8080
    label: Kiosk admin & setup
# NO settings: install stays one-click; Stripe account is picked in-app (preferred pattern)
```

```yaml
# docker-compose.yml (repo root)
services:
  app:
    # tag for humans + digest for integrity — bump BOTH every release (§2b.1)
    image: ghcr.io/openmasjid-solutions/openmasjidkiosk:0.1.0@sha256:<64-hex-digest>
    restart: unless-stopped
    environment:
      # Fabric — REQUIRED references; without them SSO/Stripe/notify silently no-op:
      OPENMASJID_BASE_URL: ${OPENMASJID_BASE_URL:-}
      OPENMASJID_APP_ID: ${OPENMASJID_APP_ID:-}
      OPENMASJID_APP_SECRET: ${OPENMASJID_APP_SECRET:-}
    ports:
      - "7878:8080"
    volumes:
      - data:/data
volumes:
  data:
```
Least-privilege exactly per the contract: no labels, no `privileged`, no host namespaces, no `cap_add`/`devices`/socket/sensitive mounts, no `extends`/`include`. The container is a plain HTTP server; the platform provides the HTTPS endpoint.

---

## 13. Tech stack

- **server/** — Node 20+, TypeScript strict, **Fastify**, **better-sqlite3**, **stripe** SDK, **argon2** (fallback admin password + PIN hashes), **zod** at every boundary. No WebSocket needed in v1 (heartbeat polling is enough); add SSE for the Devices page if live feel demands it.
- **web/** — React + Vite + TypeScript + Tailwind, shadcn/ui, **Motion**, lucide-react; tokens + recipes from **DESIGN.md** (Sakīna Glass); inherits live appearance via the Fabric `#omos=` fragment + `/api/public/appearance` (treat the fragment as untrusted presentation input).
- **android/** — **Kotlin + Jetpack Compose**, minSdk 26 (Terminal SDK floor), **Stripe Terminal Android SDK** (Bluetooth + USB discovery/connect for the M2), CameraX/ML Kit for QR scanning, DataStore for device config, WorkManager for heartbeats. Recreate the design language natively: same palette tokens, spring motion (`animate*AsState`/`AnimatedContent`), dark default, RTL, reduced-motion.
- **One container** serves API + admin + `/new` + the bundled APK. Multi-stage Dockerfile; CI: `build-apk.yml` builds + signs the APK (keystore in GH secrets, versionName from `VERSION`), `build-image.yml` builds web+server, **copies the freshly built APK into the image**, pushes multi-arch to GHCR, prints the digest to pin.

---

## 14. Security checklist (all mandatory)

- Secret key: Fabric → memory only; never to tablet/browser/logs/volume. Publishable key + connection tokens + PI client secrets are the only Stripe material the tablet sees.
- Tablet↔server: **HTTPS only, certificate pinned** from the pairing QR; never downgrade; re-pair on fingerprint change. Device tokens hashed at rest, revocable, scoped, rate-limited.
- Amounts validated server-side (presets/min/max, integer minor units); idempotency keys on all Stripe creates; donation recorded only after server-side Stripe verification (+ capture when `requires_capture`).
- Admin: Fabric SSO as identity assertion only (never call the platform as the admin); fail-closed session check; local-password fallback; signed HTTP-only SameSite cookies; restore-resilience rules (§6) observed to the letter.
- Kiosk PIN: argon2 hash in synced config; offline verify; exponential backoff on attempts; PIN rotation from admin invalidates old immediately on next heartbeat.
- Uploads (wallpapers) validated and size-capped; rich text sanitised; every kiosk route authenticated; `/new` and pairing endpoints rate-limited (pairing codes single-use, 10-min TTL).
- PCI posture: card data reader→Stripe only (P2PE-style); our code never sees a PAN — state this in the README.

---

## 15. Build & run

```bash
# server
cd server && npm install && npm run build && npm test
# admin web
cd web && npm install && npm run build
# android (debug apk)
cd android && ./gradlew assembleDebug
# everything the App Store runs
docker compose up -d
```
Local dev: Vite proxies `/api` to the server; use Stripe **test keys** + the Terminal **simulated reader** (`isSimulated`) so the whole flow runs without hardware; test on a real M2 before release. `docs/TABLET_SETUP.md` covers tablet provisioning; `docs/READER_SETUP.md` covers M2 pairing/USB cabling.

---

## 16. Definition of done (per feature)

Builds via the commands above and `docker compose up -d`; `tsc`/lint/ktlint clean; installs one-click on a real OpenMasjidOS and opens over the platform's HTTPS URL; SSO works with local fallback; Stripe account picked via the Fabric with **nothing persisted**; a simulated-reader donation completes end-to-end **with the donation recorded only after server verification**; monthly path creates a real Subscription in test mode; kiosk cannot be escaped without the admin PIN; light+dark, RTL, reduced-motion all pass on **both** web and Android; wording is plain and warm; no raw error ever reaches a donor.

---

## 17. Working agreement for Claude (the coding agent)

- **First**, read BUILDING_AN_APP.md (+ its CLAUDE.md and DESIGN.md), then the Donations and Display repos. They are the live contract and precedents; where this file lags them, follow them and flag it.
- Build in **vertical slices**, each end-to-end and demoable:
  1. Repo scaffold (all three parts) + Dockerfile + manifest/compose per §12; container boots, serves a themed admin shell, `/healthz`, and a stub `/new`.
  2. **Fabric:** SSO with local fallback + appearance inheritance + restore-resilience.
  3. **Payments setup:** Stripe account picker via Fabric, Location management, test-mode badge, connection-token endpoint.
  4. **Android shell:** Compose app, pairing (QR + cert pinning + device token), kiosk/launcher + PIN unlock + maintenance screen, heartbeats/logs → Devices page live.
  5. **Reader:** M2 discovery/connect over **Bluetooth and USB**, update handling, simulated-reader mode.
  6. **One-time donations** end-to-end (PI create → collect → confirm → server verify/capture → record → thank-you → notification), with the giving UI (6 presets + custom).
  7. **Monthly** (name/email gate, generated_card → Customer → Subscription, graceful non-reusable-card path) + receipts.
  8. **Giving-screen designer** (amounts, messages, wallpapers, accent, live preview) + live config push.
  9. Donations log + CSV; polish pass (motion, empty states, RTL, reduced-motion); docs; tag `v0.1.0`; APK bundling in CI; registry PR.
- Never put a Stripe secret anywhere the tablet or browser can see; never record a donation the server hasn't verified with Stripe; never let the kiosk be escapable without the PIN; ask before heavy dependencies or contract deviations.
