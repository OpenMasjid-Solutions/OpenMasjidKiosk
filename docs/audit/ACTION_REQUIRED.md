<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Action required — things only you can do

From the 2026-08-04 security audit. Everything here is outside what I should decide or do on my own.

---

## 1. Decide whether KIOSK-001 was ever live, and for how long

**This is the only item with a clock on it.** [KIOSK-001](SECURITY_AUDIT.md#kiosk-001) meant that any masjid running **Remote access (OpenMasjidOS) + "Allow remote adoption" (kiosk admin → Devices)** has had its admin API — including `POST /api/login` — reachable from the internet at `https://omos.<their-domain>/<basePath>/%61pi/...`.

`requireAdmin` held throughout, so **no donor data, donation record or plan was readable without a valid session cookie**, and I found no evidence of exploitation (nor any way to look for it from here — there is no access log). What was exposed unauthenticated was the password login, the session document, and `/api/setup`.

What I need you to do, in order:

1. **Find out which masjids have remote adoption on.** Anyone with it *off* — the default — was never exposed and needs nothing. If nobody ever turned it on, this whole item closes here.
2. **For any masjid that did:** treat the admin password as potentially brute-forced and **rotate it**. It is the local-password fallback in the kiosk admin panel (Settings → the password you set at first run). If they only ever sign in through OpenMasjidOS SSO and never set a local password, there is nothing to rotate.
3. **Consider turning remote adoption off** on those installs until the fixed image is deployed. One toggle, and it only affects pairing a tablet at another site.
4. If any of them keep Cloudflare access logs, `%61pi` (or `a%70i`, `ap%69`) in a request path is the signature to grep for.

**No credential in this repository needs rotating.** The git-history scan came back clean — no key, keystore, certificate or `.env` has ever been committed. See "What I checked and found nothing" in the audit.

---

## 2. Merge the PR

Autonomous push was disabled — see the top of `REMEDIATION.md`. Everything is on **`audit/security-2026-08-04`** with a PR open. Nothing has been merged and nothing has been published.

Merging to `main` will trigger `build-image.yml`, which pushes a new multi-arch image to GHCR tagged **`0.10.0` and `latest`** — and that moves the `0.10.0` tag off the `@sha256:4c0c09e8…` digest currently pinned in `docker-compose.yml` and in the OpenMasjidAPPS registry. Masjids pull by digest, so nobody gets these fixes until you re-pin. The normal release flow applies:

1. Merge the PR.
2. Let `Build image` finish; take the printed `@sha256` digest.
3. Bump `VERSION`, `manifest.yaml`, both `package.json`s and `CHANGELOG.md` (I have deliberately **not** touched the version — picking a release number is yours).
4. Commit the digest pin, tag, and bump the OpenMasjidAPPS registry entry.

---

## 3. Cross-repo

**Nothing is required in any sibling repository.** I want to be explicit about this because five other repos are being audited in parallel:

- KIOSK-001 is entirely local to this repo's own `onRequest` hook. It changes no wire format and no shared schema.
- The `students/billing` Fabric contract is **untouched** — no request or response shape changed.
- The device-token, pairing and kiosk-config wire formats are **unchanged**, so no tablet needs updating to talk to a fixed server, and a tablet running the new APK talks to an old server unchanged.
- The `admin_audit` table is private to this app's SQLite file and is exposed only on `/api/admin/audit`, a new read-only route.

One thing worth passing to whoever is auditing the other apps, as a *class* rather than a required change: **if any sibling app enforces a route allowlist by string-matching a raw URL path, it has the same bug.** OpenMasjidDonations and OpenMasjidDisplay both use the same base-path/tunnel pattern this app copied. The test that proves it is one `curl`:

```
curl --path-as-is 'https://omos.<domain>/<basePath>/%61pi/admin/whatever'
```

If that returns anything other than 404, the guard is being walked past.

---

## 4. Confirm whether OpenMasjidOS iframes installed apps

I shipped `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` but **deliberately left out a framing header** (`X-Frame-Options` / CSP `frame-ancestors`), because I could not determine whether the dashboard's "Open" renders an app inside an iframe or navigates to it.

- If it **navigates** (which the `#omos=` fragment hand-off and `history.replaceState` strongly suggest), add this to the `onSend` hook in `server/src/index.ts` and the clickjacking gap closes:
  ```ts
  reply.header('content-security-policy', "frame-ancestors 'none'");
  ```
- If it **iframes**, use `frame-ancestors 'self' <the platform origin>` instead.

Low urgency: exploiting it needs an admin to be logged in and to visit a hostile page.

---

## 5. Container runs as root — needs a coordinated change

[KIOSK-012](SECURITY_AUDIT.md#kiosk-012). I did **not** ship this, and I want to be clear why, because it looks like a one-line fix and is not.

Adding `USER node` to the Dockerfile would break **every already-deployed masjid** on their next update. `/data` is a named volume created by a root process; `kiosk.db` inside it is root-owned at mode `0600`. A container running as uid 1000 cannot open it, so the app would fail at startup across the fleet. The usual escape — an entrypoint that chowns then drops privileges — is also unavailable, because `docker-compose.yml` sets `cap_drop: ALL`, which removes `CAP_CHOWN`, `CAP_SETUID` and `CAP_SETGID`.

The residual risk is genuinely low: the container already runs with **no Linux capabilities at all** plus `no-new-privileges:true`, so in-container root cannot chown, cannot override DAC, cannot bind privileged ports and cannot escalate.

If you want it done properly it needs all three, together, with a migration note:

1. Dockerfile: `RUN mkdir -p /data && chown node:node /data` before `VOLUME`, then `USER node`.
2. `docker-compose.yml`: `user: "1000:1000"`.
3. A documented one-time step for existing installs: `docker run --rm -v kiosk_data:/d alpine chown -R 1000:1000 /d`.

Worth coordinating across the other OpenMasjid apps, since they share this posture.

---

## 6. "Today's donations" resets at the wrong time

[KIOSK-013](SECURITY_AUDIT.md#kiosk-013). The container sets no `TZ`, so it is UTC, and `donationTotals()` treats UTC midnight as the start of "today". A masjid in California sees today's total reset at 5 pm local; one in Auckland at midday. "This week" and "this month" drift the same way. The conversion code itself is correct — it just has no idea where the masjid is.

Not a security issue, but it is the number a treasurer reads out, so it is worth deciding on. Two options:

- **Quick and partial:** set `TZ` in `docker-compose.yml` (e.g. `TZ: America/Los_Angeles`). Fixes it per install, but the compose file is shipped for everyone, so it would have to be an install setting — and the manifest is deliberately settings-free ("one-click install").
- **Proper:** a masjid timezone in Payments/Masjid settings (the platform injects no profile, which is why the address is already entered by hand), used by `donationTotals`. Ask the OpenMasjidOS maintainers whether the Fabric can expose the host's timezone — if it can, this becomes automatic and belongs in the platform, not here.

I did not guess at this because picking a masjid's timezone for them is exactly the kind of thing that produces quietly wrong numbers.

---

## 7. Two small product decisions I left alone

- **`consumeTuitionSession` is dead code** ([KIOSK-014](SECURITY_AUDIT.md#kiosk-014)) and its comment claims a single-use property the code does not have. Deleting it or wiring it up turns on "should a declined tuition card force the parent to look their balance up again?" — a product question. Not a vulnerability either way: every mint recomputes the amount server-side and re-checks the device binding.
- **Android has no unit tests at all.** `KioskViewModel.backoffUntil` and `ScryptPin.verify` are pure functions guarding a public terminal, and neither can be tested today. A `test/` source set with a handful of JVM tests would have caught KIOSK-002 outright. Worth an issue.

---

## 8. Assumptions I made

Stated so you can check them rather than inherit them:

1. **That percent-decoding is the only canonicalisation Fastify's router applies to static path segments.** I tested duplicate slashes, dot segments, encoded dot segments, encoded slashes, case, trailing slashes and null bytes (all correctly 404) alongside the encoding that worked. The fix does not depend on this being an exhaustive list — it fails closed on the raw form *and* the decoded forms — but the list itself came from probing, not from the router's source.
2. **That `kioskpay.html` is the only page ever loaded in the card WebView.** True in the current code; the KIOSK-005 allowlist would need widening if that changes.
3. **That the reusable `build-apk.yml` compiling successfully means the Kotlin changes are correct.** It means they *compile*. KIOSK-002 and KIOSK-015 are pure functions I reasoned about carefully; KIOSK-005 changes runtime navigation behaviour and **should get one real keyed-card payment as a smoke test** before you rely on it.
4. **That "50 wrong pairing codes in 10 minutes across the whole network" is comfortably above legitimate use.** A volunteer types one code, correctly or once wrong. If a masjid ever bulk-pairs a large fleet with a lot of mistyping, they would see a 429 and have to wait — recoverable, and the admin can re-issue codes.
5. **That the audit trail's `actor` is best-effort by necessity.** Our session cookie asserts that *someone* signed in, not who. When the platform can name the SSO user we record that; otherwise the row says so plainly. If you want reliable attribution, the session cookie needs to carry an identity — a bigger change than an audit run should make.
