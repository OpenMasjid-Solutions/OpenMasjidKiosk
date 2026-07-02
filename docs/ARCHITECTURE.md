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
- **`android/`** — Kotlin + Jetpack Compose kiosk app. Pairs over pinned HTTPS, drives
  the Stripe Reader M2 (Bluetooth + USB) via the Terminal SDK, runs as a Lock-Task
  launcher.

Host port **7878 → container 8080**. `https: true` → the platform terminates TLS on a
dedicated port with the dashboard cert; our container stays a plain HTTP server.

## Decisions where the live contract/reference repos differ from `CLAUDE.md`

`CLAUDE.md` §2 says: where it disagrees with the live `BUILDING_AN_APP.md` / `DESIGN.md` /
reference repos, **those win — and flag it.** Resolutions:

| # | Topic | `CLAUDE.md` says | We do (and why) |
|---|-------|------------------|-----------------|
| 1 | **Design accent** | "emerald/gold" | **Cyan `#22D3EE` + amber `#F59E0B`** — the shipped `DESIGN.md` / Donations `tokens.css` are cyan (they "mirror the OpenMasjidOS palette"). Emerald is only a selectable accent. `tokens.css` + `glass.css` are copied verbatim from Donations. |
| 2 | **Node version** | "Node 20+" | **`node:22-slim`** everywhere — matches every shipped app's Docker build + runtime. |
| 3 | **Password/PIN hashing** | argon2 (§13/§14) | **DECISION PENDING** — the reference apps use `scrypt` (`node:crypto`, no external dep, Pi-friendly, also verifiable offline on Android). Slice 1 has no auth, so this is deferred to slice 2. Recommend scrypt for consistency + zero native deps unless argon2 is required. |
| 4 | **Compose hardening** | example omits it | Added `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `tmpfs: [/tmp]` — matches Donations; the catalog validator permits it; least-privilege is a hard rule. |
| 5 | **`domain:`** | (Kiosk forbids it) | **Not set** — LAN-only, everything outbound. So we drop the Cloudflare-tunnel / base-path (`fabric/site`) machinery Donations carries. `web/base.ts` is kept but no-ops. |
| 6 | **Webhooks** | (Kiosk has none) | No raw-body JSON parser; default JSON parsing. Payment truth is confirmed by *retrieving* the PaymentIntent from Stripe, not by webhook. |
| 7 | **Cookie Secure** | — | `COOKIE_SECURE=1` in the image (we're always behind the platform's TLS). |
| 8 | **Stripe Terminal** | Mirror Donations | Donations uses **web Elements / `automatic_payment_methods`**, NOT Terminal — so connection tokens, Terminal Locations, `card_present`, and `generated_card`→Subscription are **net-new** here, built from the Stripe Terminal SDK docs (slices 3, 6, 7). Only the Fabric/SSO/DB/CSV patterns are mirrored. |

## Fabric wire contract (never rename)

Env `OPENMASJID_BASE_URL` / `OPENMASJID_APP_ID` / `OPENMASJID_APP_SECRET`; header
`X-OpenMasjid-App-Secret`; cookie `omos_session`. Endpoints used: `/api/auth/session`
(SSO), `/api/public/appearance` (theme + reachability), `/api/fabric/stripe/accounts` +
`/api/fabric/stripe?account=<id>` (Stripe), `/api/fabric/notify`. **Not** `/api/fabric/site`
(no `domain:`). Read the env every process start; never persist the vars, fetched keys, or
a "linked" flag; all calls time out (~4 s) and fail soft to standalone.

## Slice status

- **Slice 1 (this):** repo scaffold (server + web + android) + Dockerfile + manifest +
  compose + CI. Container boots, serves the themed admin shell, `GET /healthz`, and the
  `/new` setup page. ✅
- Slices 2–9: see `CLAUDE.md` §17.

## Dev-machine caveats (verification gaps for slice 1)

The machine this was scaffolded on has **no Docker** and **JDK 8 only** (Android needs
17+). So `docker compose up` and `./gradlew assembleDebug` could not be run here; they are
verified on a machine/CI with those tools. The server (`tsc`) and web (`vite build`)
builds were verified locally with Node.
