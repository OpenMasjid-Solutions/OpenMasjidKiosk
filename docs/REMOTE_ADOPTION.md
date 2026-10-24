<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remote kiosk adoption (over the OpenMasjidOS Cloudflare tunnel)

A kiosk tablet usually lives on the **same LAN** as the OpenMasjidOS box and pairs to its local
HTTPS address (self-signed cert, trust-on-first-use). **Remote adoption** lets a tablet at a
**different site** (a satellite prayer room, a partner venue, someone's home) pair and run over the
internet, via the masjid's OpenMasjidOS **Cloudflare tunnel** — no VPN, no port-forwarding, nothing
inbound on the kiosk's network.

It is **opt-in and off by default**, and to anyone on the internet it exposes **only the kiosk
endpoints**. The admin panel answers over the tunnel only to an admin OpenMasjidOS vouches for —
someone who pressed **Open** on its remote dashboard after two-step sign-in — and its own password
works only on the masjid's network (see *Security posture*).

## What has to be true

1. The admin turns on **Remote access** in **OpenMasjidOS → Settings** (a Cloudflare tunnel + domain)
   and **exposes OpenMasjid Kiosk** there. The manifest requests this with `domain: true` +
   `tunnel: true`; nothing is public until the admin confirms it.
2. The admin turns on remote adoption — **"Let tablets at other sites pair"** in the kiosk admin →
   **Devices → Add a kiosk → Remote (another site)**. This is our own gate (stored server-side, off
   by default).

When both are true, the kiosk is reachable at `https://omos.<masjid-domain>/<basePath>/…`
(`basePath` defaults to `/kiosk`, admin-renamable). We read it from `GET /api/fabric/site`
(`{ enabled, domain, publicUrl, basePath }`) — cached ~60 s, fail-soft, **never persisted**.

## How a remote tablet is adopted

1. On the tablet, install the app from **`https://omos.<domain>/<basePath>/new`** (the setup page +
   APK, served over the tunnel).
2. Enter the **server address** `https://omos.<domain>/<basePath>` and a **6-digit pairing code**
   (from Devices → Add a kiosk → Remote). Same flow as LAN, just the public URL.
3. The tablet pairs over the **real Cloudflare certificate** (a public CA), so it uses **standard
   system TLS trust + hostname verification** — *not* the LAN self-signed + trust-on-first-use
   pinning.

   **It decides which of the two to use from the address the volunteer typed, before any handshake
   happens** — not from the certificate it is offered. `KioskRepository.isPrivateHost()` treats
   `localhost`, `*.local`, `*.lan`, and private/loopback/link-local IP literals (10/8, 127/8,
   192.168/16, 172.16–31/12, 169.254/16, `::1`, `fe80:`, `fc`/`fd`) as LAN → TOFU pinning; anything
   else, including any public hostname, gets system trust. (This section used to say the app
   "auto-distinguishes the two by whether the cert chains to a public CA", which is the wrong mental
   model in a way that matters: deciding from the presented chain would mean an attacker could
   choose which mode you got. Deciding from the typed address means they cannot.)

   The practical consequence: a LAN server reached by a **hostname** rather than an IP — say
   `kiosk.masjid.example` resolving to 192.168.1.20 — is treated as public and needs a
   publicly-valid certificate. Type the IP, or a `.local`/`.lan` name, for the pinned LAN path.

## Security posture

- **Base-path aware, kiosk-endpoints-only.** The OS forwards the full `/<basePath>` prefix without
  stripping it. Fastify `rewriteUrl` strips it before routing (so every route stays root-relative) and
  **flags the request as tunnel-origin** (a LAN-direct hit arrives at the root, with no prefix; one
  carrying `cf-ray` is flagged too). An `onRequest` guard then **404s every `/api` path not on its
  allowlist, and everything under `/fabric/*`, for tunnel-origin requests** — password login
  (`/api/login`), first-run setup (`/api/setup`), the Fabric relay and the WhatsApp admin-command
  handler all stay LAN-only, in every spelling (percent-encoded, double-encoded, dot segments). Open
  to anyone: `/new`, the APK (`/download`), the public bootstrap (`/api/app`,
  `/api/public/appearance`, `/api/public/logo`), the donor's monthly-cancel page (`/m/:token`,
  `/api/public/monthly/:token/cancel`), and the device API (`/api/kiosk/*`).
- **The admin panel over the tunnel answers only to OpenMasjidOS** (OS 0.51.2+ remote
  administration). `/api/session`, `/api/logout` and `/api/admin/*` pass the guard, but there
  `requireAdmin` accepts nothing but the platform vouching for *this* request: OpenMasjidOS's
  **Open** gives the browser an access token for this app alone, which its ingress forwards only while
  the admin's two-step-verified remote session is alive, and which we check at `/api/auth/session`.
  We mint **no** session of our own over the tunnel and ignore ours there — every app shares that
  hostname, so a cookie of ours would reach the others' servers, and a LAN password session must never
  count from the internet. A non-GET admin call with a foreign `Origin` is refused there as well.
- **`/fabric/*` is a separate rule, not a special case of the `/api` one.** The allowlist in
  `tunnel.ts` only ever examined `/api` paths, so every path outside `/api` fell through as
  *allowed* — correct while that meant the SPA, its assets, `/new`, the APK and `/uploads`, and
  quietly wrong the moment this app served its first `/fabric/*` route (the WhatsApp command
  handler, which reports the masjid's takings). Adding any route outside `/api` means checking this
  guard again; `tunnel.test.ts` pins both halves.
- **Remote pairing is gated.** Over the tunnel, `POST /api/kiosk/pair` is refused unless remote
  adoption is on. LAN pairing is always allowed. The gate runs **before** a pairing code is consumed.
- **Pairing codes** are single-use, 10-minute TTL, and attempt-limited. Device tokens are 256-bit,
  hashed at rest (HMAC), scoped, and revocable — revoke a device to cut its remote access immediately.
- **Secrets never travel.** The Stripe secret key and the per-app `OPENMASJID_APP_SECRET` are never
  sent to the tablet/browser and are unreachable over the tunnel (`/api/fabric/*` is blocked). The
  tablet still only ever receives Stripe **connection tokens** + PaymentIntent client secrets, exactly
  as on the LAN. Card data never touches our code (reader/Stripe only).
- **Fail-soft.** If remote access is off, `/api/fabric/site` returns "off", `basePath` is `""`, and
  the app behaves exactly as a LAN-only kiosk. A refusal or an unreachable platform is *not* "off": the
  last known base path is kept. If none is known yet (we started while the platform was down), a
  tunnel request gets a fresh lookup and a 307 back to the same address, or a 503 — never the panel
  without its base path.

## Known limitations (by design, for now)

- **Shared rate-limit bucket over the tunnel.** The pairing/login limiters key on the TCP peer, which
  over the tunnel is always the OS reverse-proxy (one loopback address) — so all internet clients share
  one bucket. This still caps total attempts far below the 1e6 code space (single-use, 10-min codes), so
  it's not a brute-force risk, but a determined attacker who knows your domain could keep that bucket in
  backoff and *delay* a legitimate remote pairing (a one-time setup step; just retry). There's no
  trustworthy per-client identifier over the tunnel today; a global cap keyed on real client IP is a
  future improvement (needs the OS to forward `CF-Connecting-IP`).
- **Exit-PIN hash reaches remotely-adopted devices.** `/api/kiosk/config` ships the scrypt PIN hash so
  the tablet can verify the exit PIN offline. A holder of a valid (256-bit) device token could brute the
  4–8-digit PIN offline — but the PIN only unlocks kiosk mode **at the physical tablet**, so knowing it
  remotely achieves nothing without physical access.

## Turning it off

Turn "Let tablets at other sites pair" off to stop **new** remote pairings. Existing remote devices keep working
via their device token until you **revoke** them (Devices → Remove) or the admin turns off Remote
access / un-exposes the app in OpenMasjidOS.
