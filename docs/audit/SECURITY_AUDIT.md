<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Security & code-health audit — OpenMasjidKiosk

> ## Addendum — re-audit of 2026-08-13 (v0.11.0)
>
> The whole tree was re-read against the 2026-08-04 baseline, covering everything built since:
> refunds, the donor's public monthly-cancel link, the multi-account reader path, monthly
> subscription setup, and the campaign editor. **No new Medium or High finding.** The money path,
> the tunnel allowlist, the device-token model, the certificate pinning and the secret-key handling
> were all re-checked and are sound; every SQL statement is still parameterised; no secret, key or
> `.env` has entered the tree.
>
> Two items closed and two recorded. (**Numbering note, corrected 2026-08-17:** the cancel-page
> finding below was first written up as KIOSK-016, which the 2026-08-04 audit had already used for
> "no Android unit tests" — the base audit ran to KIOSK-016, so the two new ones should have started
> at 017. It is **KIOSK-018** here and everywhere. `ACTION_REQUIRED.md` links these ids as anchors,
> so a duplicate silently points at the wrong finding.)
>
> | | Item | Outcome |
> |---|---|---|
> | ✅ | **Clickjacking** (left open as [ACTION_REQUIRED §4](ACTION_REQUIRED.md)) | **Fixed.** The open question was whether OpenMasjidOS iframes apps. It does not — `openApp()` uses `window.open(…, '_blank')` and `iframe` appears nowhere in its source. `frame-ancestors 'none'` + `X-Frame-Options: DENY` now ship on every response, verified against a running server. |
> | ✅ | **KIOSK-014** `consumeTuitionSession` dead code | **Deleted**, along with the comment claiming a single-use property the code never had. |
> | 🆕 | **KIOSK-018 (Low)** — the donor cancel page could amplify to Stripe | `GET /m/:token` asks Stripe whether the plan is still live. A real token in the wrong hands (or a mailbox-scanning bot) turned unlimited page loads into unlimited Stripe API calls against the masjid's own rate limit. An unknown token was always a cheap hash lookup that 404s first, so only valid tokens were affected. **Fixed** with a 120/min global lookup budget that **fails open** — when spent, the page shows the button rather than refusing anyone, and the POST always checks properly. Pinned by two tests. |
> | 🆕 | **KIOSK-017 (Info)** — cover-fees applies to monthly on fee-forcing appeals | A Zakat appeal forces the fee, and nothing excludes monthly, so the recurring amount is the grossed-up one. The tablet **displays** the grossed-up figure correctly, so nobody is charged a surprise — but the details step only explains the fee for one-time gifts, so a monthly Zakat donor sees the higher number unexplained. Not a defect in the arithmetic and arguably correct for zakat (it must arrive whole). **Left as-is deliberately** — changing what donors are charged is not an audit's call. Documented in `README.md`. |
>
> Also swept: three more unused exports removed (`cachedFabricStripe`, `cachedStudentsInfo`,
> `ThemeToggle`), and every documentation claim re-checked against the code. `manualEntryEnabled`
> remains a stored-but-never-read setting — noted in the README's known gaps rather than removed,
> because it spans the DB, the wire format and Android DataStore, and the Android half cannot be
> compile-checked on the dev machine.
>
> Still open and unchanged, both needing a decision rather than a patch:
> **KIOSK-012** (container runs as root — needs a coordinated volume migration) and
> **KIOSK-013** (donation totals use UTC day boundaries). See `ACTION_REQUIRED.md` §5 and §6.

**Audit date:** 2026-08-04
**Baseline commit:** `b5df3612dd2e3f281deef5ad0b69c241fda01485` (tag `pre-audit-2026-08-04`, `main`, tree clean)
**Version audited:** 0.10.0
**Scope:** whole repo — `server/` (Fastify + SQLite), `web/` (React admin), `android/` (Kotlin kiosk), Docker, CI, git history.

---

## Executive summary

This is a well-built codebase. The money path is genuinely careful: amounts are recomputed server-side from held state on every path, a donation is written only after the server itself retrieves the PaymentIntent from Stripe, idempotency keys are used on every Stripe create, card data never touches this code, the Stripe secret key is never persisted or sent anywhere, and the tuition integration keeps the Student ID out of URLs, logs and Stripe metadata. Every SQL statement is parameterised. There are no secrets in the tree or in git history. The kiosk lockdown on Android is thoughtful and honest about its own limits. Most of what follows is hardening, not rescue.

**The single most important issue is KIOSK-001.** The rule that keeps the admin panel off the internet — "over the Cloudflare tunnel, only `/api/kiosk/*`, `/api/app` and `/api/public/*` are reachable" — is enforced by a string comparison on the raw URL path, but Fastify's router percent-decodes that path before matching. Encoding a single letter of the first path segment walks straight past the guard:

```
GET  /kiosk/api/admin/plans      -> 404   (guard works)
GET  /kiosk/%61pi/admin/plans    -> 401   (guard bypassed; the real route ran)
POST /kiosk/%61pi/login          -> 400 "This app hasn't been set up yet."   (the real login handler)
GET  /kiosk/%61pi/session        -> 200   (the real session document)
```

Confirmed by running the server locally and probing it. Any masjid that has turned on Remote access **and** "Allow remote adoption" has been exposing its admin API — including the password login — to the internet. `requireAdmin` still fails closed, so no donor data leaks without a valid session; that is what keeps this High rather than Critical.

Second is **KIOSK-003**, four high advisories on an outdated `@fastify/static` — two of which are the *same class of defect* as KIOSK-001, which is what moved it up.

**A correction to my own first read.** I initially rated KIOSK-002 (an integer-shift overflow in the Android exit-PIN lockout) as High, on the assumption that it collapsed the throttle entirely. Then I modelled the arithmetic properly: it allows 13.5 guesses/hour against an intended 12.0, and a 4-digit PIN still needs ~31 days of continuous attack instead of ~35. It is a real defect producing a negative duration and worth the free fix, but it is a degraded rate limiter, not a way past the PIN. **Re-rated Low.** The numbers are in the finding.

Nothing found suggests any donor has been mischarged or any amount miscounted. The payment arithmetic (presets, custom bounds, cover-fees gross-up, zero-decimal currencies, tuition line sums, recurring end-date maths) was reviewed specifically for that and is sound.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 4 |
| Low | 7 |
| Info | 3 |

16 findings; 11 fixed on the audit branch, 5 deferred with reasons.

---

## Phase 0 — What this is, and who would attack it

**The product.** A masjid installs one Docker container on its own OpenMasjidOS box. That container is a Fastify server holding a SQLite database; it serves an admin web panel, a public setup page (`/new`), the bundled Android APK, and a JSON API. A wall-mounted Android tablet running the Kotlin kiosk app pairs to it with a typed 6-digit code and then takes contactless donations through a Stripe Reader M2. Tuition payments are brokered through to a sibling app (OpenMasjid Students) over the platform's app-to-app Fabric.

**Runtimes.** Node 22 (`node:22-slim`), TypeScript strict, Fastify 5, better-sqlite3, Stripe SDK 17 pinned to API `2025-02-24.acacia`. Web: React 18 + Vite 6 + Tailwind. Android: Kotlin + Compose, minSdk 26, Stripe Terminal SDK, OkHttp.

**Entry points.**

| Surface | Auth | Notes |
|---|---|---|
| `GET /healthz`, `GET /api/app`, `GET /api/public/appearance` | none *by design* | no secrets |
| `GET /new`, `GET /download/openmasjidkiosk.apk`, `/uploads/*` | none *by design* | the setup page and its assets |
| `POST /api/setup`, `POST /api/login`, `POST /api/logout`, `GET /api/session` | none *by design* (they mint auth) | login is rate-limited on the TCP peer |
| `/api/admin/**` (~35 routes: devices, campaigns, payments, plans, donations, CSV, changelog, uploads) | signed HTTP-only cookie via `requireAdmin` | SSO through the Fabric, local password as fallback |
| `/api/kiosk/**` (pair, heartbeat, config, logs, connection-token, payment-intents, tuition) | 256-bit device token, HMAC-hashed at rest | every route re-scopes to that device |
| Android: HOME launcher, `BOOT_COMPLETED` receiver, opt-in accessibility service, `FileProvider` | n/a | no exported activity beyond the launcher |
| Background timers | n/a | Fabric site refresh, tuition outbox drain, receipt retry outbox |

There are no webhooks, no message consumers, no cron, no deep links.

**Trust boundaries.**

1. **Public terminal → tablet.** Anyone can touch the glass, with unlimited attempts and unlimited patience. Nothing on the tablet may be authoritative.
2. **Tablet → server.** HTTPS with the certificate pinned on first pair (trust-on-first-use); device token in a header. The tablet is treated as hostile input everywhere — amounts, family ids and invoice ids are all recomputed server-side from server-held session state.
3. **Internet → server (only when remote adoption is on).** Cloudflare tunnel. Intended to expose the kiosk surface only. **This is the boundary KIOSK-001 breaks.**
4. **LAN → server.** The admin panel and the platform Fabric.
5. **Server → Stripe / Fabric.** Outbound only, secret key in memory only.

**Sensitive data.** Donor names and emails; card brand and last four (never a PAN); Stripe customer and subscription ids; **children's first names, last initials and their families' tuition arrears** — minors' data, and financial-hardship-adjacent (bursary lines appear on bills). The Student ID is the whole credential for "see a balance and pay it". Admin password hash and the cookie-signing secret live in the SQLite file. Device tokens are stored HMAC'd.

**Threat model — who realistically attacks this.**

- **A member of the public standing at the kiosk.** Wants free access to the tablet, or to see whose children owe money. Unlimited attempts, no tooling. → *the exit PIN, session bleed between donors, idle timeouts.* (KIOSK-002, KIOSK-005)
- **Someone on the masjid Wi-Fi.** Guest networks are common. → *unauthenticated LAN endpoints, pairing brute force.* (KIOSK-006)
- **An internet attacker, once remote adoption is on.** → *anything reachable through the tunnel.* (KIOSK-001)
- **A curious or disgruntled volunteer with the admin password.** → *donor data export, cancelling standing orders with no trace.* (KIOSK-004)
- **A supply-chain attacker.** The APK signing keystore is the crown jewel; whoever holds it can push a signed update to every tablet. → *unpinned third-party GitHub Actions.* (KIOSK-007)

**Not in the model:** a compromised OpenMasjidOS host (game over regardless), and Stripe itself.

---

## Findings

| ID | Title | Severity | Confidence | Location | Status |
|---|---|---|---|---|---|
| KIOSK-001 | Tunnel guard bypassed by percent-encoding → admin API and login reachable from the internet | **High** | Confirmed | `server/src/index.ts:137-143` | Fixed |
| KIOSK-002 | Exit-PIN backoff overflows to a negative duration and restarts its ramp | Low | Confirmed | `android/…/KioskViewModel.kt:1324-1329` | Fixed |
| KIOSK-003 | `@fastify/static` 8.3.0 — 4 high advisories incl. authorization bypass on non-canonical paths | **High** | Confirmed | `server/package.json:12` | Fixed |
| KIOSK-004 | No audit trail for financial write actions on recurring plans | Medium | Confirmed | `server/src/index.ts:927-958` | Fixed |
| KIOSK-005 | Keyed-card WebView has no main-frame navigation allowlist | Medium | Likely | `android/…/ui/ManualCardWebView.kt:58-61` | Fixed |
| KIOSK-006 | Pairing-code brute force has no global budget, only per-peer | Medium | Confirmed | `server/src/index.ts:1010-1032` | Fixed |
| KIOSK-007 | GitHub Actions pinned to mutable tags in a job holding the APK signing keystore | Medium | Confirmed | `.github/workflows/*.yml` | Fixed |
| KIOSK-008 | Transitive dependency vulnerabilities (`fast-uri`, `find-my-way`, `brace-expansion`, `postcss`) | Low | Confirmed | lockfiles | Fixed |
| KIOSK-009 | `LoginLimiter` never evicts throttled keys — unbounded memory growth | Low | Confirmed | `server/src/rateLimit.ts:38-41` | Fixed |
| KIOSK-010 | Missing `X-Content-Type-Options` / `Referrer-Policy` | Low | Confirmed | `server/src/index.ts` | Fixed |
| KIOSK-011 | HTTPS-upgrade redirect port is influenced by an untrusted header | Low | Likely | `server/src/index.ts:112-127` | **Deferred** |
| KIOSK-012 | Container runs as root | Low | Confirmed | `Dockerfile:33` | **Deferred** |
| KIOSK-013 | "Today / this week / this month" totals use the container's timezone | Info | Confirmed | `server/src/store.ts:1422-1453` | **Deferred** |
| KIOSK-014 | `consumeTuitionSession` is dead code; its doc comment describes behaviour that does not happen | Info | Confirmed | `server/src/students.ts:536` | **Deferred** |
| KIOSK-015 | `ScryptPin` accepts an unbounded cost parameter | Low | Likely | `android/…/security/ScryptPin.kt:51` | Fixed |
| KIOSK-016 | No Android unit tests exist, so pure security-relevant functions can't be tested | Info | Confirmed | `android/app/build.gradle.kts` | **Deferred** |

---

### KIOSK-001 — Tunnel guard bypassed by percent-encoding — **High**, Confirmed

**Where:** [`server/src/index.ts:137-143`](../../server/src/index.ts#L137-L143)

```ts
app.addHook('onRequest', async (req, reply) => {
  if ((req.raw as unknown as { omosViaTunnel?: boolean }).omosViaTunnel !== true) return;
  const p = (req.raw.url ?? '/').split('?')[0];
  if (p.startsWith('/api/') && !(p === '/api/app' || p.startsWith('/api/public/') || p.startsWith('/api/kiosk/'))) {
    return reply.code(404).send({ error: 'Not found.' });
  }
});
```

**Impact.** The guard tests the **raw** path; Fastify's router (`find-my-way`) percent-decodes path segments **before** matching. Encoding any character of the first segment (`%61pi`, `a%70i`, `ap%69`) produces a string that fails `startsWith('/api/')` but still routes to `/api/...`. Every `/api/admin/**` route, `POST /api/login`, `POST /api/setup`, `GET /api/session` and `POST /api/logout` become internet-reachable whenever the masjid has enabled Remote access in OpenMasjidOS *and* "Allow remote adoption" in this app. That is the exact boundary [`docs/REMOTE_ADOPTION.md`](../REMOTE_ADOPTION.md) and `CLAUDE.md` §4 promise holds ("the admin panel stays LAN-only").

`requireAdmin` still fails closed on the admin routes, so no donor data or plan data is readable without a valid session cookie — which is why this is High and not Critical. What *is* exposed unauthenticated:

- `POST /api/login` — the admin password becomes brute-forcible from the internet. Because `trustProxy` is off, all tunnel traffic shares one `LoginLimiter` bucket keyed on the tunnel's egress address: that throttles an attacker, but it equally lets a remote attacker hold the masjid's own admin out of their panel indefinitely.
- `GET /api/session` — returns whether SSO is configured, whether the platform is reachable, and whether a local password exists.
- `POST /api/setup` — 409s once an admin exists, but on an install with no local password and a briefly-unreachable platform it would let a stranger claim the admin credential.

**Reachability:** reachable from an entry point, gated on the admin having turned remote adoption on (off by default).

**Evidence** — server booted locally with `OPENMASJID_PUBLIC_URL=https://omos.example.org/kiosk` so `basePath` is `/kiosk`, then probed with `curl --path-as-is`:

```
--- over the tunnel (prefix present): admin must be 404 ---
/kiosk/api/admin/plans                               -> 404
/kiosk/api/session                                   -> 404
/kiosk/api/login                                     -> 404
/kiosk/api/kiosk/config                              -> 401     (allow-listed, correct)

--- bypass attempts ---
/kiosk//api/admin/plans                              -> 404
/kiosk/%61pi/admin/plans                             -> 401   <-- BYPASS
/kiosk/a%70i/admin/plans                             -> 401   <-- BYPASS
/kiosk/ap%69/admin/plans                             -> 401   <-- BYPASS
/kiosk/%61pi/session                                 -> 200   <-- BYPASS
/kiosk/%61pi/admin/donations.csv                     -> 401   <-- BYPASS
/kiosk/api%2fadmin/plans                             -> 404
/kiosk/api/%61dmin/plans                             -> 404   (only segment 1 matters)
/kiosk/./api/admin/plans                             -> 404
/kiosk/x/../api/admin/plans                          -> 404
/kiosk/api/kiosk/%2e%2e/admin/plans                  -> 404
/kiosk/API/admin/plans                               -> 404

POST /kiosk/%61pi/login  -> {"error":"This app hasn’t been set up yet."}  [HTTP 400]
POST /kiosk/api/login    -> {"error":"Not found."}                        [HTTP 404]
```

The last pair is the clearest proof: the same handler, reached or refused purely on whether one letter was encoded.

**Attack path.** Masjid enables Remote access + remote adoption (a supported, documented configuration) → attacker finds `https://omos.<masjid-domain>/kiosk` → requests `/kiosk/%61pi/login` → brute-forces or phishes the admin password → full admin: donor list, donor CSV export, tuition device logs, ability to cancel every recurring donation.

**Fix.** Judge the path the way the router will resolve it: canonicalise before the allowlist test, and evaluate **both** the raw and the decoded form, failing closed if either looks like a non-allow-listed `/api` path. Extracted into a pure, unit-tested predicate so the rule is testable rather than inline.

---

### KIOSK-002 — Exit-PIN backoff overflows to a negative duration — Low, Confirmed

**Where:** [`android/app/src/main/java/org/openmasjidos/kiosk/KioskViewModel.kt:1324-1329`](../../android/app/src/main/java/org/openmasjidos/kiosk/KioskViewModel.kt#L1324-L1329)

```kotlin
private fun backoffUntil(attempts: Int): Long {
    if (attempts < FREE_ATTEMPTS) return 0L
    val steps = attempts - FREE_ATTEMPTS
    val seconds = (BACKOFF_BASE_SECONDS shl steps).coerceAtMost(MAX_BACKOFF_SECONDS)
    return System.currentTimeMillis() + seconds * 1000L
}
// FREE_ATTEMPTS = 3, BACKOFF_BASE_SECONDS = 5L, MAX_BACKOFF_SECONDS = 300L
```

`attempts` is unbounded, so `steps` is unbounded, and `Long.shl` compiles to the JVM `lshl` instruction — which **masks the shift distance to its low 6 bits** and does not saturate on overflow. Two separate failures follow:

- **steps 61-63:** `5L shl 61` = 5 × 2^61 ≈ 1.15 × 10^19, past `Long.MAX_VALUE` (9.22 × 10^18) → the product wraps **negative**. `coerceAtMost(300)` then selects the negative number, and `lockedUntilMs` lands in the *past* — that attempt is not throttled at all.
- **steps ≥ 64:** the shift wraps to `steps mod 64`, so `5L shl 64 == 5L` and the whole ramp restarts from 5 seconds rather than staying at the 300-second cap.

**Impact — measured, not assumed.** I first assumed this collapsed the throttle outright and rated it High. Modelling `lshl` exactly (mask to 6 bits, 64-bit two's-complement wrap) says otherwise:

```
attempt   old(s)                  new(s)
3         5                       5
9         300                     300
63        300                     300
64        -6917529027641081856    300   <-- no lockout
66        -9223372036854775808    300   <-- no lockout
67        5                       300   <-- ramp restarted

over 2000 attempts:   old 13.5 guesses/hour   fixed 12.0 guesses/hour
attempts with no lockout at all, in the first 2000:  62  (64, 66, 128, 130, 192, 194, …)
time to exhaust a 4-digit PIN:   old ~30.9 days   fixed ~34.7 days
```

Because the ramp *restarts* rather than vanishing, the sustained rate rises by about 12% — not the unbounded guessing I first supposed. The exit PIN does guard the maintenance screen ("Exit kiosk", reader settings, the server address), so getting past it is a tablet takeover; but at 13.5 guesses/hour a 4-digit PIN is a month of uninterrupted attack on a wall-mounted tablet in a public room. That is not a practical path.

What remains true, and is why it is still fixed: a security control that computes a **negative duration** and silently hands out 62 free attempts is not doing what its author wrote, and the fix costs nothing.

**Reachability:** reachable by any member of the public from the attract screen; not practically exploitable.

**Fix.** Clamp `steps` before shifting. With base 5 and a 300 s cap, `steps ≥ 6` already saturates (`5 << 6 = 320 → 300`), so clamping at 6 is arithmetically identical for every attempt count in the intended range and removes the overflow entirely. The `new(s)` column above is the fixed function, computed the same way.

---

### KIOSK-003 — `@fastify/static` 8.3.0: four high advisories — **High**, Confirmed

**Where:** [`server/package.json:12`](../../server/package.json#L12) (`"@fastify/static": "^8.0.4"`, resolved 8.3.0)

`npm audit`, verbatim:

```
@fastify/static  <=10.1.1
Severity: high
@fastify/static vulnerable to path traversal in directory listing - GHSA-pr96-94w5-mx2h
@fastify/static vulnerable to route guard bypass via encoded path separators - GHSA-x428-ghpx-8j92
@fastify/static vulnerable to Authorization Bypass via Non-Canonical URL Paths - GHSA-8pvw-jcv7-9cmj
@fastify/static vulnerable to route guard bypass via path traversal - GHSA-83w8-p2f5-377r
fix available via `npm audit fix --force`
Will install @fastify/static@10.1.2, which is a breaking change
```

**Reachability:** reachable. The plugin is registered twice — on `/uploads/` (admin-uploaded campaign images, served to the public setup page and over the tunnel) and on the built web app's root. Directory listing is off (`index: false`) and `decorateReply: false` is set on the uploads mount, which limits the first advisory; the two "route guard bypass" advisories are the same *class* of defect as KIOSK-001 and are the reason this is rated High rather than Medium here — this repo has now demonstrated that its route guards can in fact be walked past by encoding.

**Fix.** Major upgrade 8.3.0 → 10.1.2 (Tier 2 — flagged at the top of `REMEDIATION.md`).

---

### KIOSK-004 — No audit trail for financial writes on recurring plans — Medium, Confirmed

**Where:** [`server/src/index.ts:927-958`](../../server/src/index.ts#L927-L958)

`POST /api/admin/plans/:id/cancel`, `/pause` and `/schedule` each stop or alter a real donor's standing order at Stripe. They are behind `requireAdmin` and they log nothing. `log.warn` fires only on failure; the success path writes no record at all — not to the container log, not to the database.

**Impact.** A masjid with a shared admin password (the standalone fallback is a single password, and SSO sessions are minted into the same cookie) has no way to answer "who cancelled Fatima's £50/month, and when?". Stripe's own dashboard shows the subscription was cancelled by API key, which is the same key for every admin. This is the one class of action in the app that reaches out and changes something in a donor's life, and it is unattributable.

**Reachability:** requires an admin session; the concern is insider action and post-incident reconstruction, not external attack.

**Fix.** An append-only `admin_audit` table plus writes from the three plan routes and from device revoke and PIN rotation, and a read-only `GET /api/admin/audit`. Explicitly Tier 1 per the engagement's addendum ("audit logging … are Tier 1 — ship them").

---

### KIOSK-005 — Keyed-card WebView has no main-frame navigation allowlist — Medium, Likely

**Where:** [`android/app/src/main/java/org/openmasjidos/kiosk/ui/ManualCardWebView.kt:58-61`](../../android/app/src/main/java/org/openmasjidos/kiosk/ui/ManualCardWebView.kt#L58-L61)

The `WebViewClientCompat` overrides only `shouldInterceptRequest`. `shouldOverrideUrlLoading` is not overridden, so the WebView will follow **any** top-level navigation it is asked to make. JavaScript is enabled and a `@JavascriptInterface` bridge (`KioskPay`) is attached.

**Impact.** This WebView is full-screen, donor-facing and inside a locked kiosk. If anything ever drives a main-frame navigation, the kiosk becomes an unrestricted browser — the classic kiosk escape.

**Reachability: theoretical today.** I read `android/app/src/main/assets/kioskpay.html` in full: it performs no top-level navigation, `stripe.confirmCardPayment` with the Card Element renders 3-D Secure in an iframe, and the only external script is `https://js.stripe.com/v3/`. So there is no live path to this. It is defence-in-depth against a future change to that page, a Stripe.js behaviour change, or a compromised `js.stripe.com`. Given the engagement's explicit focus on kiosk escape at a public terminal, it is worth closing rather than noting.

The bridge itself is *not* a money risk: a spoofed `onResult('completed', …)` cannot invent a donation, because the ViewModel's completion always goes back to the server, which retrieves the PaymentIntent from Stripe before recording anything.

**Fix.** Override `shouldOverrideUrlLoading` and allow main-frame navigations only to `appassets.androidplatform.net` and Stripe hosts. **Sub-frame navigations are deliberately left untouched**, because 3-D Secure legitimately loads arbitrary card-issuer domains in an iframe and restricting those would break real payments.

---

### KIOSK-006 — Pairing brute force has no global budget — Medium, Confirmed

**Where:** [`server/src/index.ts:1010-1032`](../../server/src/index.ts#L1010-L1032)

A pairing code is 6 digits (10^6), single-use, and lives 10 minutes. `pairLimiter` is a `LoginLimiter` keyed on `req.socket.remoteAddress`: 5 free attempts, then exponential backoff to a 5-minute cap. That is a solid *per-source* limit and no per-source limit at all in aggregate — an attacker with N source addresses gets 5N free guesses instantly. On an IPv6 LAN a single host routinely commands a /64.

**Impact.** Guessing a live code mints a device token. That token can pull the kiosk config — which contains the **scrypt hash of the exit PIN** — and mint Stripe Terminal connection tokens.

**Reachability:** LAN by default (remote pairing is refused unless the admin opts in), and only during the 10-minute window after an admin generates a code. That, plus the single-use consumption, is what holds this to Medium.

**Fix.** A global failure budget alongside the per-peer one, sized far above any real pairing session.

---

### KIOSK-007 — Actions on mutable tags in the keystore-holding job — Medium, Confirmed

**Where:** `.github/workflows/build-image.yml`, `.github/workflows/build-apk.yml`

`actions/checkout@v4`, `actions/setup-java@v4`, `android-actions/setup-android@v3`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `docker/setup-qemu-action@v3`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`, `docker/build-push-action@v6`. All mutable tags. (`cla.yml` is already correctly pinned to a SHA — credit where due.)

**Impact.** In `build-apk.yml` the signing keystore is base64-decoded to `$RUNNER_TEMP/kiosk.jks` and the passwords enter the environment of the Gradle step. Every action in that job shares the runner filesystem. If any of those tags were repointed to malicious code — most plausibly the third-party `android-actions/setup-android` — the attacker takes the **APK signing keystore**, and with it the ability to publish a signed kiosk update that every paired tablet will accept as genuine. That is the highest-value secret in this repo.

**Reachability:** supply-chain; depends on an upstream compromise.

**Fix.** Pin every action to a full commit SHA with the version in a trailing comment.

---

### KIOSK-008 — Transitive dependency vulnerabilities — Low, Confirmed

`npm audit`, verbatim:

```
brace-expansion  4.0.0 - 5.0.8   high   DoS via unbounded expansion (GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895)
fast-uri         3.0.0 - 3.1.4   high   host confusion via backslash authority (GHSA-v2hh-gcrm-f6hx, GHSA-7p8r-x3mc-p8w7)
find-my-way      <=9.6.0         high   DDoS with HTTP2 (GHSA-c96f-x56v-gq3h)
postcss (web)    <=8.5.22        high   path traversal in sourceMappingURL auto-loading (GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp)
```

Rated Low **in this system** despite the upstream "high" labels, and the reasoning matters: `find-my-way`'s advisory needs HTTP/2, which this server does not serve; `fast-uri` is used by Ajv for schema `$id` resolution, not for routing user URLs; `brace-expansion` reaches us only through `glob` inside `@fastify/static`; `postcss` is a build-time dependency that never ships in the image. None are attacker-reachable here. They are still worth clearing so the next `npm audit` is quiet enough that a real finding stands out.

**Fix.** `npm audit fix` (non-breaking) in both packages.

---

### KIOSK-009 — `LoginLimiter` never evicts throttled keys — Low, Confirmed

**Where:** [`server/src/rateLimit.ts:38-41`](../../server/src/rateLimit.ts#L38-L41)

```ts
if (this.map.size > 5000) {
  const now = Date.now();
  for (const [k, v] of this.map) if (v.next <= now && v.fails <= MAX_FREE) this.map.delete(k);
}
```

The eviction requires `fails <= MAX_FREE` — but any key with `fails <= MAX_FREE` also has `next === 0`, so the sweep only ever deletes entries that were never throttled. The entries that actually consume memory, those with `fails > MAX_FREE`, are retained forever. The sweep also only runs from `fail()`, so a map full of stuck entries is never cleaned while the attack continues.

**Impact.** Unbounded growth of a `Map` under sustained login or pairing attempts from many source addresses. Slow, and it needs an attacker who is already being throttled, so: memory pressure on a Raspberry Pi, not a compromise.

**Fix.** Evict on expiry regardless of the failure count — an expired backoff has no state worth keeping — and sweep on a size threshold rather than only on failure.

---

### KIOSK-010 — Missing `X-Content-Type-Options` and `Referrer-Policy` — Low, Confirmed

No security headers are set on any response (verified with `curl -D -` against a running instance). The gap that matters is `nosniff` on `/uploads/*`: those files are admin-uploaded, and although the upload route allowlists MIME types and assigns its own random name and extension, `nosniff` is what stops a browser from reinterpreting a "PNG" whose bytes begin with HTML.

`X-Frame-Options` / `frame-ancestors` is **deliberately not included** — see KIOSK-011's sibling note in `ACTION_REQUIRED.md`: I could not confirm whether OpenMasjidOS ever renders an installed app inside an iframe, and shipping a framing denial that breaks the dashboard would be worse than the clickjacking exposure it closes.

---

### KIOSK-011 — HTTPS-upgrade redirect port is header-influenced — Low, Likely — **DEFERRED**

**Where:** [`server/src/index.ts:112-127`](../../server/src/index.ts#L112-L127)

`lastHttpsHost` is learned from `x-forwarded-host` on any request carrying `x-forwarded-proto: https`. `trustProxy` is off and the container is port-mapped directly, so a LAN attacker can set both headers freely. The redirect then only fires when the victim's `Host` **hostname** matches, but `hostOnly()` strips the port — so an attacker can poison the *port* and send an admin's browser to `https://<same-host>:<attacker-chosen-port>/`.

**Why deferred, not fixed.** Every fix I could construct either (a) requires knowing how the platform's TLS proxy sets `Host` versus `X-Forwarded-Host`, which I cannot observe without a live OpenMasjidOS, or (b) breaks the feature outright by refusing to learn the HTTPS port at all. Shipping an unverified change to the redirect that serves the admin panel is a worse trade than leaving a narrow, precondition-heavy issue open: exploiting it requires the attacker to already be able to bind a port on the masjid server itself, at which point they have better options. Recommendation and options are in `ACTION_REQUIRED.md`.

---

### KIOSK-012 — Container runs as root — Low, Confirmed — **DEFERRED**

**Where:** [`Dockerfile:33`](../../Dockerfile#L33) — `FROM node:22-slim AS runtime` with no `USER` directive.

**Why deferred, not fixed.** This looks like a textbook Tier-1 fix and is not one. `/data` is a named Docker volume. On existing installs that volume was created by a root process and holds `kiosk.db` at mode `0600`, root-owned (the store chmods it deliberately). Adding `USER node` would make every already-deployed masjid's app fail to open its own database on the next update — a total outage across the fleet, caused by a hardening change. The usual escape (an entrypoint that chowns then drops privileges) is unavailable too: `docker-compose.yml` sets `cap_drop: ALL`, which removes `CAP_CHOWN`, `CAP_SETUID` and `CAP_SETGID`.

The mitigating posture is unusually strong and is why the residual risk is genuinely low: the container already runs with **no Linux capabilities at all** and `no-new-privileges:true`, so in-container root cannot chown, cannot bind privileged ports, cannot override DAC, and cannot escalate. It reads and writes its own files by plain ownership.

Doing this properly needs a coordinated change (image + compose `user:` + a one-time volume chown on the host) and a migration note for existing installs. Written up in `ACTION_REQUIRED.md`.

---

### KIOSK-013 — Donation totals use the container's timezone — Info, Confirmed — **DEFERRED**

**Where:** [`server/src/store.ts:1422-1453`](../../server/src/store.ts#L1422-L1453)

`donationTotals()` computes "today" as local midnight and compares it against UTC ISO timestamps. The conversion itself is correct — the code is careful about this and the comment explains it. The problem is that the container has no `TZ` set in either the Dockerfile or the compose file, so "local" is **UTC**. A masjid in California sees "today's donations" reset at 5 pm local; one in Auckland sees it reset at midday. "This week" and "this month" drift the same way.

Not a security issue, but it is exactly the domain-correctness class the engagement asks be held to the same standard: this is the number a treasurer reads out. Fixing it properly needs a masjid timezone setting (the platform injects no profile) plus UI, which is a feature, not a fix. Written up in `ACTION_REQUIRED.md`.

---

### KIOSK-014 — Dead code with a misleading contract — Info, Confirmed — **DEFERRED**

[`server/src/students.ts:536`](../../server/src/students.ts#L536): `consumeTuitionSession` is exported and never called anywhere in the repo. Its doc comment — *"Drop a session once it has been used to mint a PaymentIntent (single-use for the pay step)"* — describes behaviour that does not happen: a tuition session survives until its 15-minute TTL and can mint several PaymentIntents.

That is not itself a vulnerability. Every mint recomputes the amount server-side from the session, re-checks the device binding, and re-applies the floor; re-minting is also genuinely useful when a card is declined and the parent retries. But a comment asserting a security property the code does not have is how a future change gets made on a false premise. Left for the maintainer to decide between deleting the function and wiring it up, since "should a declined tuition card force a fresh lookup?" is a product question, not an audit one.

---

### KIOSK-016 — No Android unit tests — Info, Confirmed — **DEFERRED**

`android/` has no test source set and no tests. `KioskViewModel.backoffUntil` and `ScryptPin.verify` are pure functions guarding a public terminal, and neither can be exercised today — a handful of JVM tests would have caught KIOSK-002 outright instead of leaving it to be reasoned about. Deferred because adding test infrastructure is beyond an audit's remit and, with no Android SDK on this machine, I could not run what I added to prove it worked. Raised in `ACTION_REQUIRED.md`.

---

### KIOSK-015 — `ScryptPin` accepts an unbounded cost parameter — Low, Likely

[`android/…/security/ScryptPin.kt:51`](../../android/app/src/main/java/org/openmasjidos/kiosk/security/ScryptPin.kt#L51) floors `N` at 2 but sets no ceiling. A config carrying an absurd `N` would make `SCrypt.generate` attempt a huge allocation; the resulting `OutOfMemoryError` is an `Error`, not an `Exception`, so the `catch (_: Exception)` below it would not catch it and the app would crash at the PIN pad. The hash arrives from our own server over pinned TLS, so this needs a compromised or buggy server rather than an attacker — but a crash at the PIN pad on a locked kiosk is an annoying failure mode for a one-line guard.

---

## What I checked and found nothing

Stating these explicitly, because "not mentioned" and "not looked at" are different things.

- **Secrets (Phase 1).** Clean. No `.env`, keystore, certificate, database or dump has ever been committed (`git log --all --diff-filter=A`, 148 distinct files, none matching sensitive patterns). `git log -p --all -S` for `sk_live_`, `sk_test_`, `rk_live_`, `ghp_`, `github_pat_`, `BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE KEY` returned only one hit — a built web bundle briefly tracked and removed in `527a4fc` — which on inspection contains the bare prefix strings `pk_test_`/`sk_live_` from the UI's key-format validation messages, no key material. `.gitignore` and `.dockerignore` both correctly exclude `.env*`, `*.jks`, `*.keystore` and `apk/*.apk`. **No credential needs rotating on account of this repo.**
- **SQL injection.** Every statement in `store.ts` is parameterised. The one interpolated identifier (`ALTER TABLE donations ADD COLUMN ${col}`) iterates a hardcoded literal array.
- **XSS in the admin panel.** No `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, no `new Function`, no `document.write` anywhere in `web/`. The changelog renderer builds React nodes deliberately. The `#omos=` fragment is treated as untrusted: `applyAccent` is an allowlist lookup, and `wallpaperImage` goes through `safeImageUrl`, which rejects anything but `/uploads/<safe>`, `http(s):` or `data:image/` and refuses quotes, backslashes and whitespace so it cannot break out of `url("…")`.
- **CSRF.** Cookies are `SameSite=Lax`, `HttpOnly`, `Secure` in the image, `Path=/`. All state-changing routes are POST/PUT/DELETE with JSON bodies, which a cross-site form cannot forge. No CORS headers are emitted at all (verified against a live instance) so cross-origin reads are blocked by the browser.
- **Server-authoritative amounts.** Verified end to end. Donations validate against the campaign's own presets and custom bounds; cover-fees gross-up is recomputed server-side and never taken from the tablet; tuition amounts are derived from a server-held session and never from the request. A `tuition` campaign is explicitly refused on the donation route so it cannot be laundered into donation totals.
- **Idempotency and partial-transaction state.** Per-attempt Stripe idempotency keys; `recordDonation` uses `ON CONFLICT` and deliberately does not update the amount on replay; the monthly path derives `trial_end` from the PaymentIntent's own `created` so a retry reproduces an identical body; the tuition outbox is keyed on the PaymentIntent with `DO NOTHING`; the receipt outbox has an explicit minimum age to close the double-send race with the inline send. This is careful work.
- **Currency and rounding.** Zero-decimal and three-decimal currencies are handled and unit-tested. Amounts are integer minor units throughout; no float ever reaches Stripe.
- **PCI scope.** Confirmed: no card data path touches this code. Tap-to-pay goes reader → Stripe Terminal SDK → Stripe. Keyed entry goes into Stripe.js's own iframe inside the WebView and is tokenised on device. The server sees only brand and last four.
- **Webhooks.** There are none, by design, so there is no signature verification to get wrong and no replay window. Confirmed no `/api/fabric` route is served (probed: 404). **Updated 2026-08-17:** still true of `/api/fabric`, but the app now serves **one** inbound route, `POST /fabric/commands/run` (WhatsApp admin commands, 0.12.0). It is not a webhook — no signature scheme, no third party — and it authenticates on two independent facts (our own app secret plus a caller header no app id can hold), fails closed when this install holds no secret, and is refused over the tunnel. See `CLAUDE.md` §18.
- ~~**Refund and chargeback authorization.** Neither exists in the app; admins are pointed at the Stripe dashboard.~~ **Out of date — refunds shipped in 0.11.0, after this list was written and before the 2026-08-13 addendum above, which did not catch it.** Re-reviewed 2026-08-17: `POST /api/admin/donations/:id/refund` sits behind `requireAdmin`, refuses anything but a `succeeded` donation, clamps the amount to what is left (`amount - refunded`), keys its Stripe idempotency on the running refunded total so a double-click replays but a genuine second partial does not, records only what Stripe confirms, and nets every total in SQL. Two defects were found and fixed in that pass, both recorded in `## Unreleased`: the admin panel sent **1/100th** of the typed partial amount, and a refund on a campaign's own Stripe account failed permanently once the donation was more than 7 days old. Refunds are now also written to the audit trail. Chargebacks are still Stripe-dashboard-only, which remains the right call.
- **Object-level authorization.** Single-tenant by design. Device routes re-derive the device from its token and never trust an id in the body; tuition pay checks `session.deviceId !== d.id`; plan reads and writes both refuse any subscription whose Stripe metadata is not `app: kiosk`, which is what stops an admin screen from cancelling the masjid's own unrelated subscriptions.
- **Anonymous donations.** Name and email are optional unless the admin requires them or the donor chooses monthly; nothing derives an identity when they are absent.
- **Recurring-plan arithmetic.** The `scheduledEndSec` off-by-one (a `cancel_at` landing on a renewal boundary makes Stripe cancel instead of charging) is correctly handled and covered by tests, as is the month-end clamp, in UTC.
- **Path traversal / uploads.** Upload filenames are `crypto.randomBytes(8)` hex with an extension chosen from a MIME allowlist; the client filename is never used. SVG is correctly refused.
- **Prototype pollution / unsafe deserialization / template injection / SSRF.** No `merge`/`extend` of user JSON into objects; every `JSON.parse` result is coerced field by field. No templating engine. No route fetches a user-supplied URL server-side (the appearance relay hits a fixed platform path; images are rendered by the browser, not proxied — a deliberate choice, documented).
- **ReDoS.** All regexes reviewed are anchored, bounded, or lazily quantified without nested repetition.
- **TLS on the tablet.** Custom `X509TrustManager` pinning the exact leaf fingerprint, no system-CA fallback, no cleartext path, `https://` enforced at pairing, constant-time fingerprint comparison, and a distinct exception so a pin mismatch surfaces as "re-pair" rather than a silent downgrade. Remote-adopted kiosks correctly switch to real system-CA validation *with* hostname verification. This is done properly.
- **Android data at rest.** `allowBackup="false"`, cloud backup and device-transfer both excluded, no exported components beyond the launcher activity and the two system-protected receivers, PIN stored only as a hash.
- **Licensing.** AGPL-3.0-only throughout, `LICENSE` present, SPDX headers on every source file, a CLA workflow, and no incompatible dependency licences observed.

---

## Coverage and gaps

**Covered with runtime evidence:** the tunnel path guard (booted and probed), server build, typecheck and the full 88-test suite, `npm audit` on both packages, git history secret scan, HTTP response headers and CORS behaviour.

**Covered by reading only:**

- **The Android app.** There is no Android SDK on this machine, so nothing in `android/` can be compiled or run locally; CI's `build-apk` job is the only compiler available, and there are no Android unit tests in the repo at all. KIOSK-002, KIOSK-005 and KIOSK-015 are therefore reasoned from the source and the JVM specification, and verified only to the extent that the APK still builds. **None of the three has been exercised on a tablet.** KIOSK-002's arithmetic is deterministic and I am confident in it; KIOSK-005's fix should be smoke-tested with one real keyed-card payment before it is relied on.
- **Everything involving a real Stripe account.** No live or test Stripe credentials were used. The Recurring screen's reads and its cancel/pause/schedule writes remain unexercised against Stripe, as does any card-present charge. (This was already flagged when v0.10.0 shipped.)
- **Anything requiring a live OpenMasjidOS.** SSO, the Fabric Stripe vault, notifications, alerts, email receipts, the Students billing broker and the real Cloudflare tunnel were all read, not run. KIOSK-001 was reproduced by simulating the tunnel's base path locally, which exercises the exact guard but not Cloudflare itself.
- **The admin panel in a browser.** Not opened. It builds and typechecks; the layout is unverified.

**Not assessable without production access:** whether any masjid currently has remote adoption enabled (which is what determines whether KIOSK-001 was ever live), the real contents of deployed data volumes, and whether the OpenMasjidOS dashboard iframes installed apps (which gates the framing header in KIOSK-010).
