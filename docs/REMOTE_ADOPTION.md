<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remote kiosk adoption (over the OpenMasjidOS Cloudflare tunnel)

A kiosk tablet usually lives on the **same LAN** as the OpenMasjidOS box and pairs to its local
HTTPS address (self-signed cert, trust-on-first-use). **Remote adoption** lets a tablet at a
**different site** (a satellite prayer room, a partner venue, someone's home) pair and run over the
internet, via the masjid's OpenMasjidOS **Cloudflare tunnel** — no VPN, no port-forwarding, nothing
inbound on the kiosk's network.

It is **opt-in and off by default**, and it exposes **only the kiosk endpoints** — never the admin
panel.

## What has to be true

1. The admin turns on **Remote access** in **OpenMasjidOS → Settings** (a Cloudflare tunnel + domain)
   and **exposes OpenMasjid Kiosk** there. The manifest requests this with `domain: true` +
   `tunnel: true`; nothing is public until the admin confirms it.
2. The admin turns on **"Allow remote adoption"** in the kiosk admin → **Devices → Add a kiosk →
   Remote**. This is our own gate (stored server-side, off by default).

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
   pinning. The app auto-distinguishes the two by whether the cert chains to a public CA.

## Security posture

- **Base-path aware, kiosk-endpoints-only.** The OS forwards the full `/<basePath>` prefix without
  stripping it. Fastify `rewriteUrl` strips it before routing (so every route stays root-relative) and
  **flags the request as tunnel-origin** (a LAN-direct hit arrives at the root, with no prefix). An
  `onRequest` guard then **404s `/api/admin/*` and `/api/fabric/*` for tunnel-origin requests** — the
  admin panel and all Fabric calls stay LAN-only. Only `/new`, the APK (`/download`), the public
  bootstrap (`/api/app`, `/api/public/appearance`), and the device API (`/api/kiosk/*`) are reachable
  over the internet.
- **Remote pairing is gated.** Over the tunnel, `POST /api/kiosk/pair` is refused unless "Allow remote
  adoption" is on. LAN pairing is always allowed. The gate runs **before** a pairing code is consumed.
- **Pairing codes** are single-use, 10-minute TTL, and attempt-limited. Device tokens are 256-bit,
  hashed at rest (HMAC), scoped, and revocable — revoke a device to cut its remote access immediately.
- **Secrets never travel.** The Stripe secret key and the per-app `OPENMASJID_APP_SECRET` are never
  sent to the tablet/browser and are unreachable over the tunnel (`/api/fabric/*` is blocked). The
  tablet still only ever receives Stripe **connection tokens** + PaymentIntent client secrets, exactly
  as on the LAN. Card data never touches our code (reader/Stripe only).
- **Fail-soft.** If the platform is unreachable or remote access is off, `/api/fabric/site` returns
  "off", `basePath` is `""`, and the app behaves exactly as a LAN-only kiosk.

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

Flip "Allow remote adoption" off to stop **new** remote pairings. Existing remote devices keep working
via their device token until you **revoke** them (Devices → Remove) or the admin turns off Remote
access / un-exposes the app in OpenMasjidOS.
