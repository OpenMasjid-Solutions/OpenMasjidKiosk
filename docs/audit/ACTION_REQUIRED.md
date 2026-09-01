<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Action required — things only you can do

From the 2026-08-04 security audit, plus §§9–12 from the 2026-08-17 repo-wide sweep. Everything here
is outside what I should decide or do on my own.

---

## From the 2026-09-01 pre-release sweep — one thing needs a tablet

### 13. A monthly gift can still be downgraded to a one-off silently, on ONE remaining path — HIGH

Found in the 0.12.0 pre-flight. **Half of it is fixed in this release; the other half needs hardware.**

Keyed entry always creates a ONE-OFF charge (`startManualCollect` passes `monthly = false`) but never
cleared `giving.monthly` — so the thank-you screen still rendered `"$X / month"`
(`GivingScreen.kt:1497`) and `monthlyOutcome` stayed `None`, so the honest "we couldn't set up monthly
giving" note did not appear either. The donor leaves believing a standing order exists. It does not.
That is the failure v0.11.0 headlined, reached through a different door, and it is **pre-existing —
`v0.11.0` has the identical shape**, so it is not a regression in this release.

**Fixed here:** the donor-initiated route. The "enter card by hand" button is no longer offered for a
monthly gift (`manualOnCard && !isTuition && !giving.monthly`). That makes the card step agree with a
guard the flow already had — `startGiving` refuses a monthly gift with no reader, saying "Monthly
giving needs the card reader" — and its failure mode is benign: the donor uses the reader, which is
what monthly requires anyway.

**NOT fixed, and this is the bit for you.** The automatic fallback at `KioskViewModel.kt:788` still
calls `startManualCollect()` when `ReaderManager.registerFor` fails to move the reader onto a
campaign's own Stripe account. For a MONTHLY gift that silently downgrades and still says "/ month".

**Why I left it.** The fix touches the donation state machine — clearing `monthly` and setting
`monthlyOutcome = NotSupported` at the top of `startManualCollect`, and stopping the success path at
`KioskViewModel.kt:931` clobbering it back to `None`. There is no Android SDK on this machine, so CI
compiling is the only check that code gets, and an unverified edit to the flow every donation runs
through is a far worse risk than a rare pre-existing edge case. It needs a tablet, a campaign on a
second Stripe account, and a forced `registerFor` failure.

**What I would do:** make that branch route to the SAME error the existing guard uses rather than
downgrading at all — a monthly gift genuinely needs the reader, so falling back to keyed is wrong
regardless of what the screen then says.

---

## From the 2026-08-17 sweep — four decisions, in the order I would take them

Fixed and shipped in that sweep (listed so you know what is *not* waiting on you): the partial-refund
scale bug, refunds failing after 7 days on a campaign's own Stripe account, refunds missing from the
audit trail, `/complete` swallowing exceptions, the email circuit breaker ignoring "unreachable", CI
never running the tests, and a batch of dead code and stale documentation. The four below are left
because each needs a judgement that is yours, and I have said plainly why rather than guessing.

### 9. A kiosk with no exit PIN gives any passer-by Android Settings — HIGH

**No exit PIN is the default state.** `pinHash` is empty until an admin sets one in Devices, and
nothing requires it. On such a kiosk, `KioskViewModel.kt:1250` deliberately opens the maintenance
screen without a PIN prompt — the comment explains why, and the reasoning is sound as far as it goes:
*"so a fresh kiosk isn't bricked for reader setup/diagnostics"*. `exitAllowed` is correctly withheld,
so **Exit kiosk** stays hidden.

But two other controls on that screen are escapes, not diagnostics, and neither is gated:

- **Open Android Settings** — whose own comment says it "drops kiosk lockdown so Settings can open".
  From Settings, the tablet is entirely open.
- **Re-pair** — which can point the tablet at a different server.

Ten taps on the background of the giving screen is all it takes. The fix the audit proposes is small
and obvious — gate those two on `exitAllowed` as well — but it changes the kiosk lockdown on a path
that **cannot be compiled or run on the dev machine**, and it interacts with first-run setup, which is
exactly what the current behavior exists to protect. Getting it wrong strands a volunteer at a
tablet with no way into Settings to join Wi-Fi.

**What I would do:** set an exit PIN on every kiosk today (Devices → the kiosk → exit PIN) — that
alone closes it completely. Then make the change deliberately, with a tablet in hand. Worth
considering alongside it: the admin panel could simply refuse to leave the PIN unset, or warn on the
Devices page, which is a web-only change that can be tested here.

**`README.md` was also wrong about this** and has been corrected: it described the gesture as always
leading to "your exit PIN", which is only true once one is set.

### 10. Keyed-card donations are captured on the tablet, not by the server — HIGH

`createCardPaymentIntent` (`stripe.ts`) sets no `capture_method`, so keyed intents **auto-capture** on
confirm. The reader path sets `capture_method: 'manual'` and the server captures only after
re-checking with Stripe — which is the invariant the whole app is built on ("never trust the
tablet's word"). The keyed path does not have it.

The consequence: if the tablet's `/complete` call is lost — a dropped connection, a crash, a server
restart at the wrong second — **Stripe has taken the money and this app has no record of it**, and the
donor is shown *"That didn't complete. If your card was charged it will be refunded."* Nothing
refunds it, because nothing knows. Keyed entry is not a rare path: the tablet falls back to it
automatically whenever no reader is connected.

**Why I did not just fix it.** The one-line change (`capture_method: 'manual'`) is almost certainly
right, and the server already handles `requires_capture` on this route. But it changes the
**semantics of a live payment path** that I cannot compile, run, or put a card through from here. If
the WebView's confirm treats a non-`succeeded` status as failure, every keyed donation breaks — and
keyed entry is the fallback that keeps a masjid taking money when its reader dies. The blast radius
of being wrong is much larger than the bug.

**What I would do:** make the change, then put one real card through a kiosk with the reader
unplugged, on test keys, before it ships. It is a fifteen-minute check that can only be done with
hardware. Consider a reconciliation sweep too — PaymentIntents we created that never completed —
since that closes the class rather than this instance.

### 11. The local admin password can never be changed

There is **no route and no UI** to change it. `setAdmin` is called from exactly one place —
`POST /api/setup` — which refuses once an admin exists.

This matters most because **§1 of this very document tells you to rotate it**, as the response to a
possible exposure. That instruction cannot be carried out. If you only ever sign in through
OpenMasjidOS SSO there is nothing to rotate and this is moot; if a local password was set at first
run, it is currently fixed for the life of the install.

**What I would do:** add `PUT /api/admin/password` behind `requireAdmin`, requiring the current
password when one is set, and skipping that check for an SSO-minted session so an SSO admin can set a
recovery password. Small and testable — I left it out because it is a feature, not a fix, and adding
an auth route is not something to slip into a sweep unannounced.

### 12. Two smaller ones I judged were yours

- **Donor names and email addresses go to WhatsApp verbatim** when an admin switches that channel on
  for `donation-refunded` or `monthly-cancelled` (`raiseAlert` sends one identical body to all three
  channels). `CLAUDE.md` §18 forbids donor identity in WhatsApp **commands** and says why — a thread
  keeps a copy forever on at least two phones — but says nothing about alerts, and an admin arguably
  needs the name to act on "a donor stopped their monthly donation". Email carries the same content
  and is on by default. **So this may be exactly what you intended**; it is only worth flagging
  because the same reasoning was applied so carefully one paragraph away. If you want it changed, the
  shape is a WhatsApp-specific rendering that keeps the amount, kiosk and fund and drops the person.
- **The Gradle wrapper downloads its distribution unverified** (no `distributionSha256Sum`), in the
  job that has just decoded the APK signing keystore to disk. Adding the checksum is the right fix
  and I did not, because I cannot obtain the published hash from here in a way worth trusting — and a
  wrong one breaks every Android build. It is two minutes with the checksum from
  `services.gradle.org`.

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

## 2. ~~Merge the PR~~ — DONE, shipped in v0.10.0. Nothing to do.

Kept as a record rather than deleted, because the paragraph that used to be here told a reader to go
and merge a branch that no longer exists, and that instruction outlived its truth by two releases.

The audit branch `audit/security-2026-08-04` was merged and released as **v0.10.0**; the fixes have
since been carried through v0.10.2, v0.11.0 and the current cycle. The release runbook it described
now lives in `CLAUDE.md` rules 7 and 7c, which is the version to follow — it has been corrected
twice since (tag the digest-pin commit, not the release commit; and open a PR against the catalog's
`dev`, never push its `main`).

**Autonomous push is no longer disabled.** `REMEDIATION.md`'s header still describes the audit-run
policy of 2026-08-04; the standing policy is `CLAUDE.md` §0 — all work lands on `dev` freely, and
`main` moves only when the maintainer says "merge to main".

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

## 4. ~~Confirm whether OpenMasjidOS iframes installed apps~~ — RESOLVED 2026-08-13, nothing for you to do

The 2026-08-04 audit shipped `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` but deliberately left out a framing header, because it could not determine whether the dashboard's "Open" renders an app inside an iframe or navigates to it — and a framing denial that broke the dashboard would have been worse than the gap it closed.

**Settled by reading the platform.** `openApp()` in OpenMasjidOS `packages/ui/src/lib/apps.ts` ends with:

```ts
window.open(target, '_blank', 'noopener,noreferrer');
```

and the string `iframe` does not appear anywhere in the OpenMasjidOS source. The dashboard **navigates**; nothing frames us. So `frame-ancestors 'none'` (plus `X-Frame-Options: DENY` for browsers predating CSP level 2) now ships in the `onSend` hook in `server/src/index.ts`, verified against a running server on `/healthz`, the admin SPA and the donor cancel page.

If OpenMasjidOS ever starts embedding apps, this is the one line that would need to become `frame-ancestors 'self' <platform origin>`.

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

- ~~**`consumeTuitionSession` is dead code**~~ ([KIOSK-014](SECURITY_AUDIT.md#kiosk-014)) — **deleted 2026-08-13.** It was never called, so removing it changed no behavior, and it took its misleading "single-use" comment with it. `getTuitionSession` now documents the truth: a session is **reusable until it expires**, deliberately, so a parent whose card is declined doesn't have to type the Student ID and re-confirm the child again. Wiring single-use *on* remains the open product question ("should a declined tuition card force a fresh lookup?") and is still nobody's call but yours. Not a vulnerability either way: every mint recomputes the amount server-side and re-checks the device binding.
- **Android has no unit tests at all.** `KioskViewModel.backoffUntil` and `ScryptPin.verify` are pure functions guarding a public terminal, and neither can be tested today. A `test/` source set with a handful of JVM tests would have caught KIOSK-002 outright. Worth an issue — and it is the only compile-and-behavior gap left, since the dev machine has no Android SDK and CI's `build-apk` job proves compilation but nothing else.

---

## 8. Assumptions I made

Stated so you can check them rather than inherit them:

1. **That percent-decoding is the only canonicalisation Fastify's router applies to static path segments.** I tested duplicate slashes, dot segments, encoded dot segments, encoded slashes, case, trailing slashes and null bytes (all correctly 404) alongside the encoding that worked. The fix does not depend on this being an exhaustive list — it fails closed on the raw form *and* the decoded forms — but the list itself came from probing, not from the router's source.
2. **That `kioskpay.html` is the only page ever loaded in the card WebView.** True in the current code; the KIOSK-005 allowlist would need widening if that changes.
3. **That the reusable `build-apk.yml` compiling successfully means the Kotlin changes are correct.** It means they *compile*. KIOSK-002 and KIOSK-015 are pure functions I reasoned about carefully; KIOSK-005 changes runtime navigation behavior and **should get one real keyed-card payment as a smoke test** before you rely on it.
4. **That "50 wrong pairing codes in 10 minutes across the whole network" is comfortably above legitimate use.** A volunteer types one code, correctly or once wrong. If a masjid ever bulk-pairs a large fleet with a lot of mistyping, they would see a 429 and have to wait — recoverable, and the admin can re-issue codes.
5. **That the audit trail's `actor` is best-effort by necessity.** Our session cookie asserts that *someone* signed in, not who. When the platform can name the SSO user we record that; otherwise the row says so plainly. If you want reliable attribution, the session cookie needs to carry an identity — a bigger change than an audit run should make.
