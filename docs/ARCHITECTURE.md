<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Architecture & decisions — OpenMasjid Kiosk

This file records non-trivial architectural / naming decisions as the app is built in
vertical slices (see [`../CLAUDE.md`](../CLAUDE.md) §17). It is the running log the
working agreement asks for.

## Shape

One Docker image (multi-stage, multi-arch amd64 + arm64) runs everything:

- **`server/`** — Node 22 + TypeScript + **Fastify** + **better-sqlite3**. Serves the
  JSON API (`{ data | error }` envelope), the built admin SPA, the `/new` setup page, and
  the bundled Android APK. Talks to Stripe (secret key in memory only) and to the
  OpenMasjidOS **Fabric** (SSO, Stripe account, notifications).
- **`web/`** — React + Vite + Tailwind (preflight off; **Sakīna Glass** tokens). The
  admin panel + the public `/new` page. Inherits the dashboard's live appearance.
- **`android/`** — Kotlin + Jetpack Compose kiosk app, applicationId/namespace
  **`org.openmasjidos.kiosk`** (reverse-domain of the maintainer-owned openmasjidos.org).
  Pairs over pinned HTTPS, drives the Stripe Reader M2 (Bluetooth + USB) via the Terminal
  SDK, runs as a Lock-Task launcher.

Host port **7878 → container 8080**. `https: true` → the platform terminates TLS on a
dedicated port with the dashboard cert; our container stays a plain HTTP server.

## Decisions where the live contract/reference repos differ from `CLAUDE.md`

`CLAUDE.md` §2 says: where it disagrees with the live `BUILDING_AN_APP.md` / `DESIGN.md` /
reference repos, **those win — and flag it.** Resolutions:

| # | Topic | `CLAUDE.md` says | We do (and why) |
|---|-------|------------------|-----------------|
| 1 | **Design accent** | "emerald/gold" | **Cyan `#22D3EE` + amber `#F59E0B`** — the shipped `DESIGN.md` / Donations `tokens.css` are cyan (they "mirror the OpenMasjidOS palette"). Emerald is only a selectable accent. `tokens.css` + `glass.css` are copied verbatim from Donations. |
| 2 | **Node version** | "Node 20+" | **`node:22-slim`** everywhere — matches every shipped app's Docker build + runtime. |
| 3 | **Password/PIN hashing** | argon2 (§13/§14) | **scrypt** (chosen by maintainer, 2026-07-02) — `node:crypto` `scryptSync` on the server (mirrors Donations `auth.ts`), and **BouncyCastle** `org.bouncycastle.crypto.generators.SCrypt` (lightweight API, no JCE provider registration) offline on Android for the kiosk PIN, over the shared wire format `scrypt$N$r$p$saltB64$hashB64`. Zero extra native deps, Pi-friendly. Applied in slice 2; `CLAUDE.md` §13/§14 have since been corrected to say scrypt. |
| 4 | **Compose hardening** | example omits it | Added `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `tmpfs: [/tmp]` — matches Donations; the catalog validator permits it; least-privilege is a hard rule. |
| 5 | **`domain:` / `tunnel:`** | (Kiosk forbade it) | **Set (v0.9.20+)** for opt-in REMOTE adoption. The server is base-path aware (mirrors Donations: `fetchFabricSite()` → `cachedFabricSite().basePath` drives Fastify `rewriteUrl` + `<base href>`/`window.__OMOS_BASE__` injection; `web/base.ts` is now LIVE, no longer a no-op). Kiosk-endpoints-only over the tunnel: an onRequest guard 404s `/api/admin` + `/api/fabric` on tunnel-origin requests (flagged in `rewriteUrl` when the URL arrives with the prefix). See `REMOTE_ADOPTION.md`. |
| 6 | **Webhooks** | (Kiosk has none) | No raw-body JSON parser; default JSON parsing. Payment truth is confirmed by *retrieving* the PaymentIntent from Stripe, not by webhook. |
| 7 | **Cookie Secure** | — | `COOKIE_SECURE=1` in the image (we're always behind the platform's TLS). |
| 8 | **Stripe Terminal** | Mirror Donations | Donations uses **web Elements / `automatic_payment_methods`**, NOT Terminal — so connection tokens, Terminal Locations, `card_present`, and `generated_card`→Subscription are **net-new** here, built from the Stripe Terminal SDK docs (slices 3, 6, 7). Only the Fabric/SSO/DB/CSV patterns are mirrored. |

### Decisions locked by the maintainer (2026-07-02)

- **Hashing = scrypt** (see row 3 above).
- **Stripe `apiVersion` = pinned explicitly** — the Node Stripe client will be constructed
  with a fixed `apiVersion` (not the SDK default), because Terminal features are
  version-sensitive and we want deterministic behaviour. Applied when the Stripe client is
  written in slice 3.
- **Android applicationId / namespace = `org.openmasjidos.kiosk`** — reverse-domain of the
  maintainer-owned openmasjidos.org. Permanent once released (a different id can't update
  an installed app), so it is fixed now. The `CLAUDE.md` §10 ADB example still shows the
  old default `com.openmasjid.kiosk` — the real command is
  `adb shell dpm set-device-owner org.openmasjidos.kiosk/.KioskAdminReceiver`.
- **Release signing keystore** — deferred to first release (slice 9); CI debug-signs until
  then. When ready: `keytool` → `.jks` → 4 GitHub secrets (`SIGNING_KEYSTORE_BASE64`,
  `SIGNING_KEYSTORE_PASSWORD`, `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`).
- **Pairing = typed 6-digit code, no QR/camera** (maintainer, 2026-07-02) — kiosk tablets
  usually have no camera, so the original QR-carried `{httpsUrl, certSha256, code}` is
  replaced by: the volunteer types the server address + a single-use **6-digit** code
  (10-min TTL, attempt-limited to resist brute-forcing the 1M space). The app **pins the
  server's HTTPS cert on the first successful pair (trust-on-first-use)** since the
  fingerprint can no longer travel in a QR; re-pair if it changes. No CameraX/ML Kit dep;
  `qrcode.react` dropped from the web. (Built in slice 4.)

## Fabric wire contract (never rename)

Env `OPENMASJID_BASE_URL` / `OPENMASJID_APP_ID` / `OPENMASJID_APP_SECRET`; header
`X-OpenMasjid-App-Secret`; cookie `omos_session`. Endpoints used: `/api/auth/session`
(SSO), `/api/public/appearance` (theme + reachability), `/api/fabric/stripe/accounts` +
`/api/fabric/stripe?account=<id>` (Stripe), `/api/fabric/notify`, and **`/api/fabric/site`**
(`domain:` — our public URL + base path for remote adoption; cached ~60s, fail-soft). Read the env
every process start; never persist the vars, fetched keys, the site/publicUrl, or a "linked" flag;
all calls time out (~4 s) and fail soft to standalone / LAN-only.

## Slice status

**All nine slices in `CLAUDE.md` §17 shipped across v0.1.0–v0.10.2.** The slice plan is history;
`CHANGELOG.md` is the record of what landed when, and `README.md` describes what the app does now.

Built since the slice plan ran out, each worth knowing about architecturally:

| Feature | Where it lives | The bit that isn't obvious |
|---|---|---|
| **Campaigns** | `store.ts` (`campaigns` table), `web/campaigns.tsx`, `CampaignJson.kt` | Each carries its own amounts, design, type and **Stripe account**. The campaign type — not a toggle — decides the fee rule, so a hand-crafted API body can't create a non-enforcing Zakat appeal. |
| **Tuition** | `students.ts`, `docs/STUDENTS_INTEGRATION.md` | Brokered app-to-app through the Fabric (`students/billing`). Recorded as a **payment, never a donation**, so it stays out of donation totals, receipts and CSV donation columns. Amount computation is pure and unit-tested — it is the security-critical part. |
| **Branded receipts** | `email.ts`, `fabric.ts` (`fabricEmail`) | The receipt strategy is decided **once**, at PaymentIntent creation, and carried in PI metadata, so `/complete` and the retry outbox agree about whether Stripe's own receipt was suppressed. That is what stops a donor getting two receipts, or none. |
| **Remote adoption** | `tunnel.ts`, `rewriteUrl` in `index.ts`, `docs/REMOTE_ADOPTION.md` | The tunnel allowlist judges the path the **router** will resolve, not the one that arrived — Fastify percent-decodes before matching, and the original raw `startsWith('/api/')` was walked past with `/%61pi/`. |
| **Recurring plans** | `index.ts` `/api/admin/plans*`, `plans` table | **Stripe is the source of truth** (no webhooks), read live on every open. The local table holds only what Stripe cannot know: the campaign, the account, and month one — which was card-present, so it is not an invoice. |
| **Refunds** | `/api/admin/donations/:id/refund`, `store.recordRefund` | Refund → record → notify, in that order. Totals are netted in SQL (`SUM(amount_minor - refunded_minor)`), so a headline figure can never overstate what the masjid kept. |
| **The donor's cancel link** | the encapsulated `donor` plugin in `index.ts` | The **only public route that changes anything**. The token is the credential: 256-bit, stored only as a hash, and able to do exactly one thing. Its urlencoded body parser is scoped to that plugin so no other POST route gains cross-origin form acceptance. |
| **Multi-account reader** | `ReaderManager.registerFor`, `locationForAccount` | A Terminal reader is bound to one account by its connection token. The tablet re-registers against the campaign's account just before collecting, and each account gets its own Location, created from the masjid address already on file. |
| **Payer-covered card fee** | `students.ts` (`grossUpForStudentsFee`, `kioskFeeRate`), `GivingStep.TuitionFeeConfirm` | students/billing 0.51.0, additive — contract still `v: 2`. The fee is a percentage of the **gross**, not the tuition, or the school lands a few cents short and the invoice never closes. Two things are kept deliberately apart: the PaymentIntent charges the gross, the Students ledger is sent the **tuition** (a gross in `amountCents` reads as an overpayment and compounds). The rate is pinned to the tuition SESSION at lookup, so a rate change mid-payment cannot alter a quoted total — and **no rate is ever sent to the tablet**, which renders the disclosure from the server's own reply so the total shown cannot differ from the total charged. |
| **Light mode** | `web/src/styles/tokens.css`, `server/src/theme-contrast.test.ts` | Ported from OpenMasjidStudents (2026-08-17). Light mode used to lighten only the glass and keep the dark backdrop — a workaround for the real cause, which is that every `[data-wallpaper]` block is a dark gradient at the SAME specificity as `[data-theme="light"]` but later in the file, so it overwrote the light scene. Fixed by giving each wallpaper a **light counterpart at two-attribute specificity** (hue kept, lightness inverted) and making on-scene ink follow **the scene, not the theme** — a custom image states its own tone, in both directions, so a dark photo under light theme still gets light ink. All 18 theme×wallpaper combinations are contrast-tested. |
| **WhatsApp admin commands** | `commands.ts`, `POST /fabric/commands/run`, `CLAUDE.md` §18 | The **first inbound Fabric route** — everything else in `fabric.ts` is us calling the platform. So it is the first place this app *checks* a credential rather than presenting one, and it authenticates on two independent facts: our own app secret, and a caller header (`omos:platform`) that no app id can hold because the colon is outside the app-id charset. LAN-only: `/fabric` is **not** covered by the `/api` tunnel allowlist and had to be added to it explicitly. |
| **Per-alert routing** | `alerts.ts`, `web/src/alerts.tsx`, `raiseAlert()` in `index.ts` | Three channels that are **additive and independently fail-soft** — the platform relay, a direct email, a WhatsApp. The defaults are the load-bearing part (`os: true` so an upgrade mutes nothing; `whatsapp: false` because the channel spends the masjid's own number's reputation). Everything raises through `raiseAlert`, **never `fabricAlert` directly**, or an admin's choices are bypassed — including the in-app "Send test", deliberately, since a test taking a different path would prove nothing. |
| **Partial refunds** | `web/src/donations.tsx`, `server/src/refund-amount.test.ts` | The refund box worked out minor units by **sniffing the formatted output** of the money helper for a decimal point. `formatMoney` drops the decimals on a whole number, so `money(0)` is `"£0"` in every currency and the sniff always answered zero: an admin refunding £50 gave back **50p**, and the placeholder told them to type `10000`. The scale must come from the currency **code** via `web/src/money.ts`. Fixed and pinned 2026-08-17. |

## What CI checks (and what it still cannot)

`.github/workflows/test.yml` runs the server suite (`tsc`, `tsc -p tsconfig.test.json`,
`node --test`) and the web build on every push to `dev`/`main` **and on every pull request**, and
`build-image.yml` will not publish an image unless it is green.

That gate is new as of 0.12.0, and its absence is worth recording rather than quietly fixing: for
the whole of 0.1.0–0.11.0 **CI never ran `npm test` at all.** The Dockerfile's `npm run build`
type-checked the shipping code and nothing else, so every test pinning an already-shipped bug — the
percent-encoded `/api` bypass, the WhatsApp handler's fail-closed auth, the version-suffix pairing —
could have gone red without stopping a release, and a contributor's pull request got no CI beyond
the CLA bot. Two type errors and one dead assertion were sitting in the suite when the gate went in,
because `tsconfig.json` excludes `*.test.ts` and tsx strips types without checking them
(`tsconfig.test.json` now closes that).

Still unverifiable here:

- **No Android SDK and no Docker on the dev machine.** `./gradlew assembleDebug` and
  `docker compose up` are proven by CI only — so **CI's `build-apk` job remains the only compile
  check the Kotlin gets**, and a Kotlin change is not proven until that job is green. There are no
  Android unit tests at all (`ACTION_REQUIRED.md` §7).
- Anything user-facing on the server should also be checked by **booting it and pressing the
  thing** — a `415` shipped to a donor's cancel button precisely because it was only reasoned about.
- **The admin panel has no test runner of its own.** Two server tests reach across into `web/` for
  the parts where being wrong costs real money or readability — `theme-contrast.test.ts` (design
  tokens) and `refund-amount.test.ts` (currency arithmetic). Everything else in `web/` is checked by
  `tsc` and by eye.
- Hardware paths — a real M2 reader, a real card, a real refund — can only be confirmed on a box.
