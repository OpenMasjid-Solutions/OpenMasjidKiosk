<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remediation — what shipped, and how it was verified

Audit of 2026-08-04. Branch **`audit/security-2026-08-04`**, cut from `main` at `b5df3612dd2e3f281deef5ad0b69c241fda01485`.

---

## ⚠️ Autonomous push was DISABLED — nothing has reached `main`

Pushing to `main` triggers [`.github/workflows/build-image.yml`](../../.github/workflows/build-image.yml), which runs `on: push: branches: [main]` and unconditionally does `push: true` to GHCR, tagging **`:0.10.0` and `:latest`**. Any commit touching `server/`, `web/`, `android/`, the `Dockerfile`, `manifest.yaml` or `CHANGELOG.md` therefore publishes a public container image — and republishing the `0.10.0` tag moves it off the `@sha256:4c0c09e8…` digest pinned in `docker-compose.yml` and in the OpenMasjidAPPS registry.

That is a published artifact, which is the one condition that overrides "push it yourself". So: all work is on the branch, a PR is open, **nothing is merged and nothing is published.** `main` is untouched and its CI is exactly as it was.

`main` is *not* branch-protected, so the push would have succeeded. That is precisely why the check mattered.

---

## Tier 2 first — the behavior-changing changes, so you know where to look

### `@fastify/static` 8.3.0 → 10.1.2 · `0a83b12` · [KIOSK-003]

A major version bump of the plugin that serves the admin panel, `/new`, and every uploaded campaign image. If something looks wrong with images or the SPA in the next few days, look here first.

Verified against a running server with a real public dir and a real uploads dir:

```
--- the SPA + assets must still serve ---
/                                                        -> 200
/assets/app.js                                           -> 200
/new                                                     -> 200
/admin                                                   -> 200
--- uploads must still serve ---
/uploads/img_test.png                                    -> 200
--- traversal out of the uploads root must NOT serve ---
/uploads/../kiosk-secret-probe.txt                       -> 403
/uploads/..%2fkiosk-secret-probe.txt                     -> 404
/uploads/%2e%2e/kiosk-secret-probe.txt                   -> 403
/uploads/....//kiosk-secret-probe.txt                    -> 404
--- directory listing must stay off ---
/uploads/                                                -> 403

GET / body: <!doctype html><html><head><title>t</title></head><body>SPA<
did the secret probe leak anywhere? no
```

Also confirmed the Dockerfile's runtime step still resolves, since that is where a lockfile mismatch would surface:

```
$ npm ci --omit=dev
found 0 vulnerabilities
EXIT=0
+-- @fastify/cookie@11.0.2
+-- @fastify/multipart@9.4.0
+-- @fastify/static@10.1.2
+-- better-sqlite3@12.11.1
+-- fastify@5.9.0
+-- stripe@17.7.0
`-- zod@3.25.76
```

### New `admin_audit` table · `54250f9` · [KIOSK-004]

A schema change and a new API response. Additive only — `CREATE TABLE IF NOT EXISTS`, no existing table altered, no existing column touched, no data migrated.

**Reverse migration:**

```sql
DROP INDEX IF EXISTS idx_admin_audit_ts;
DROP TABLE IF EXISTS admin_audit;
```

Safe to run at any time: nothing else reads the table, and `recordAudit` is wrapped so a write failure is logged and swallowed rather than failing the action it describes.

Verified live, end to end (setup → set PIN → clear PIN → revoke device):

```
--- GET /api/admin/audit (authenticated) ---
  14:49:39  device.revoke  dev_ghost  admin (local password)  kiosk removed
  14:49:39  pin.clear      -          admin (local password)  kiosk exit PIN removed — the maintenance screen is no longer PIN-gated
  14:49:39  pin.set        -          admin (local password)  kiosk exit PIN changed — takes effect on each kiosk's next heartbeat

--- does the PIN leak into the trail? ---
  no (the PIN value never appears)
--- unauthenticated read must be refused ---
  GET /api/admin/audit with no cookie: 401
```

### Behavior changes worth knowing about, in one list

| Change | What an admin or donor might notice |
|---|---|
| Tunnel guard now decodes before judging (`7d64632`) | Nothing on the LAN. Over the tunnel, encoded admin paths now 404 like the plain ones always did. |
| Global pairing budget (`8236e1e`) | After 50 **wrong** pairing codes in 10 minutes across the whole network, pairing returns 429 until the window rolls. Correct codes never spend it. |
| Audit trail (`54250f9`) | Three plan actions, device revoke and PIN changes are now recorded. New route `GET /api/admin/audit`. No UI yet. |
| `nosniff` + `Referrer-Policy` (`1ac360d`) | Nothing visible. No framing header was added — see `ACTION_REQUIRED.md` §4. |
| WebView main-frame allowlist (`02e7cb7`) | Keyed card entry should be unchanged. **Smoke-test one keyed payment** — this is the change with the least verification behind it. |
| PIN backoff clamp (`d5c88b9`) | Nothing. Identical for every attempt count in the intended range. |

---

## Everything that shipped

| # | Commit | Finding | What changed |
|---|---|---|---|
| 1 | `7d64632` | KIOSK-001 · High | Tunnel guard canonicalises the path before applying the allowlist; extracted to `server/src/tunnel.ts` with 8 tests |
| 2 | `d5c88b9` | KIOSK-002 · Low | Clamp the PIN-backoff shift distance |
| 3 | `02e7cb7` | KIOSK-005 · Medium | Main-frame navigation allowlist on the card WebView |
| 4 | `a3ffbbd` | KIOSK-015 · Low | Bound the scrypt cost accepted from config |
| 5 | `0a83b12` | KIOSK-003 · High | `@fastify/static` 8.3.0 → 10.1.2 |
| 6 | `7a56987` | KIOSK-008 · Low | `npm audit fix` in both packages |
| 7 | `54250f9` | KIOSK-004 · Medium | `admin_audit` table, writes, and a read-only route |
| 8 | `c3bad1e` | KIOSK-009 · Low | Evict lapsed rate-limiter entries |
| 9 | `8236e1e` | KIOSK-006 · Medium | Global pairing-failure budget |
| 10 | `1ac360d` | KIOSK-010 · Low | `nosniff` + `Referrer-Policy` |
| 11 | `8629767` | KIOSK-007 · Medium | Every GitHub Action pinned to a verified commit SHA |

### Why the headline fix works

The tunnel guard asked "does this path start with `/api/`?" of the string as it arrived on the wire. Fastify's router asks the same question of the string *after* percent-decoding each segment. Two different questions about the same request, and the gap between them was the vulnerability: `/%61pi/admin/plans` is not `/api/...` to the guard and is `/api/admin/plans` to the router.

The fix removes the disagreement rather than patching the symptom. `blockedOverTunnel` builds every spelling the router could resolve the path to — as it arrived, decoded once (what the router does), and decoded twice (so a double-encoded probe can't out-run it) — and refuses if **any** of them reads as a non-allow-listed `/api` path. Fail-closed: an ambiguous path is refused, not guessed at. It cannot produce a false positive on the kiosk surface because `/api/kiosk/`, `/api/public/` and `/api/app` contain no characters percent-decoding can change, which the test suite asserts directly.

It is a pure exported function specifically so the rule is testable. Running the *old* inline rule against the new cases:

```
OLD RULE LEAKS: /%61pi/admin/plans
OLD RULE LEAKS: /a%70i/admin/plans
OLD RULE LEAKS: /ap%69/admin/plans
OLD RULE LEAKS: /%61pi/login
OLD RULE LEAKS: /%61pi/session
OLD RULE LEAKS: /%2561pi/admin/plans
OLD RULE LEAKS: /api

old rule: 7/7 of the regression cases slip through
```

And the same live probe that found the bug, re-run after the fix:

```
=== AFTER FIX ===
--- LAN (no prefix) must be UNCHANGED ---
/api/admin/plans                                   -> 401
/api/session                                       -> 200
--- tunnel: kiosk surface must still work ---
/kiosk/api/kiosk/config                            -> 401
/kiosk/api/app                                     -> 200
/kiosk/api/public/appearance                       -> 200
--- tunnel: the BYPASSES that worked before ---
/kiosk/%61pi/admin/plans                           -> 404
/kiosk/a%70i/admin/plans                           -> 404
/kiosk/ap%69/admin/plans                           -> 404
/kiosk/%61pi/session                               -> 404
/kiosk/%61pi/admin/donations.csv                   -> 404
/kiosk/%2561pi/admin/plans                         -> 404
POST /kiosk/%61pi/login  -> {"error":"Not found."}  [HTTP 404]
```

---

## Test results, before and after

**Baseline** (at `pre-audit-2026-08-04`, before any change): 88/88 server tests pass, `tsc` clean on server and web, `vite build` clean, CI green on `main`.

**After** — full ship gate:

```
===== SERVER TESTS =====
ℹ tests 106
ℹ pass 106
ℹ fail 0

===== SERVER TYPECHECK =====
> tsc -p tsconfig.json --noEmit
exit=0

===== WEB BUILD (tsc --noEmit && vite build) =====
✓ 1590 modules transformed.
dist/index.html                   1.47 kB │ gzip:  0.81 kB
dist/assets/index-CyuBmUQk.css   48.22 kB │ gzip:  9.96 kB
dist/assets/index-C9si-Giq.js   304.37 kB │ gzip: 86.78 kB
✓ built in 1.99s

===== AUDIT =====
found 0 vulnerabilities      (server)
found 0 vulnerabilities      (web)
```

88 → **106 tests**, all passing. 18 new tests: 8 for the tunnel guard, 5 for the audit trail (including the upgrade path onto a database that predates the table), 5 for the rate limiters.

The web bundle hashes are **identical** to the baseline (`index-CyuBmUQk.css`, `index-C9si-Giq.js`) — the postcss bump changed nothing in the output.

**Dependency counts:** server 4 high → **0**; web 1 high → **0**.

**Android:** compile-verified via a `workflow_dispatch` of `build-apk.yml` on the audit branch — that workflow uploads an artifact and publishes nothing, so it was safe to run. [Run 30921564227](https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk/actions/runs/30921564227):

```
status: completed  conclusion: success
job build: success
   1. Set up job: success
   2. Run actions/checkout@11d5960a326750d5838078e36cf38b85af677262: success
   3. Set up JDK 17: success
   4. Set up Android SDK: success
   5. Make gradlew executable: success
   6. Decode signing keystore (if provided): success
   7. Build signed release APK: success
   8. Build debug APK (no signing secrets): skipped
   9. Collect APK as ***.apk: success
  10. Upload APK artifact: success
```

This one run verifies two things: the three Kotlin changes **compile** and produce a signed release APK, and the **SHA-pinned actions resolve and run** (`actions/checkout@11d5960a…`, `setup-java`, `setup-android`, `upload-artifact` all succeeded on their pinned commits).

It does **not** verify runtime behavior. There is no Android SDK on this machine and no Android unit tests in the repo, so **none of the three Kotlin changes has been run on a tablet.** KIOSK-002 and KIOSK-015 are pure functions whose arithmetic I modeled directly; KIOSK-005 changes navigation behavior and is the one that warrants a real keyed-card smoke test.

---

## A correction to my own finding

I first rated KIOSK-002 **High**, on the reasoning that an overflowing shift would collapse the PIN lockout and leave a 4-digit PIN brute-forceable in an hour. Before writing it up I modeled `lshl` exactly, and the reasoning was wrong: because the ramp *restarts* rather than vanishing, the attacker gets 13.5 guesses/hour against an intended 12.0 — a 12% speedup, and ~31 days rather than ~35 to exhaust a 4-digit PIN.

**Re-rated Low.** The fix still shipped (it is free and provably identical in the intended range), but it is a degraded rate limiter, not a way past the PIN. The measured table is in the finding. Flagging it because the first framing was in an earlier draft and I would rather you have the number than the narrative.

---

## Deferred, and why

| Finding | Why it did not ship |
|---|---|
| **KIOSK-011** · redirect port from an untrusted header | Every candidate fix needs knowledge of how the platform's TLS proxy sets `Host` versus `X-Forwarded-Host`, which cannot be observed without a live OpenMasjidOS. Shipping an unverified change to the redirect that serves the admin panel is the worse trade; exploiting it already requires binding a port on the masjid server. |
| **KIOSK-012** · container runs as root | `USER node` would break **every existing install** — `/data` is a named volume with a root-owned `kiosk.db` at mode 0600 — and `cap_drop: ALL` rules out the entrypoint-chown pattern too. Needs a coordinated image + compose + volume-chown migration. Already mitigated by no capabilities + `no-new-privileges`. |
| **KIOSK-013** · totals use the container's timezone | Needs a masjid timezone setting and UI. Guessing a timezone produces quietly wrong numbers on the figure a treasurer reads out. |
| **KIOSK-014** · dead `consumeTuitionSession` | Deleting versus wiring it up is a product decision ("should a declined tuition card force a fresh balance lookup?"). Not a vulnerability either way. |
| **KIOSK-016** · no Android unit tests | Adding test infrastructure is beyond an audit's remit, and with no Android SDK here I could not run what I added to prove it worked. |

All five are written up in `ACTION_REQUIRED.md` with concrete recommendations.

---

## Rollback

**Revert one fix** (each commit is self-contained and independently revertable, which is the point of one-per-finding):

```bash
git revert 7d64632   # KIOSK-001  tunnel guard
git revert d5c88b9   # KIOSK-002  PIN backoff clamp
git revert 02e7cb7   # KIOSK-005  WebView navigation allowlist
git revert a3ffbbd   # KIOSK-015  scrypt cost bound
git revert 0a83b12   # KIOSK-003  @fastify/static 10.x   (then: cd server && npm install)
git revert 7a56987   # KIOSK-008  npm audit fix          (then: cd server && npm install; cd ../web && npm install)
git revert 54250f9   # KIOSK-004  audit trail            (then run the reverse migration below)
git revert c3bad1e   # KIOSK-009  limiter eviction
git revert 8236e1e   # KIOSK-006  global pairing budget
git revert 1ac360d   # KIOSK-010  security headers
git revert 8629767   # KIOSK-007  pinned actions
```

Reverting `54250f9` leaves the (now unused) table behind. To remove it as well:

```sql
-- against /data/kiosk.db
DROP INDEX IF EXISTS idx_admin_audit_ts;
DROP TABLE IF EXISTS admin_audit;
```

**Revert the whole run.** Nothing was merged, so this needs no revert at all — just don't merge the PR, and optionally:

```bash
git push origin --delete audit/security-2026-08-04
```

**If it has been merged** and you want `main` back exactly as it was:

```bash
git checkout main
git reset --hard pre-audit-2026-08-04      # b5df3612dd2e3f281deef5ad0b69c241fda01485
# NOTE: this rewrites main. Prefer the non-destructive form:
git revert --no-commit pre-audit-2026-08-04..HEAD && git commit -m "revert: back out the 2026-08-04 security audit"
```

The tag `pre-audit-2026-08-04` is local only — push it if you want it on the remote:

```bash
git push origin pre-audit-2026-08-04
```
