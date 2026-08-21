# CLAUDE.md — OpenMasjidKiosk

> This file is the single source of truth for the **OpenMasjidKiosk** app. Read it fully before writing any code. When in doubt, follow this document, then the references in §2, over your own assumptions. If something is ambiguous, ask before guessing.

---

## 0. Branching policy

**This section comes before everything else in this file, and overrides anything below it that assumes work lands on `main`.** Nothing here changes the build contract or the slice plan in §17 — slices simply continue on `dev` now.

### Session-start check (do this before making any change)

```bash
git branch --show-current    # MUST print: dev
```

If it prints anything else, `git checkout dev` first. If you are on `main`, you are in the wrong place — stop and switch. Do not "just make this one small change" here.

### The two branches

| Branch | What it is | Who moves it |
|---|---|---|
| `dev` | Where **all** development happens. Every slice, feature, fix, experiment, docs edit and dependency bump. | You, freely. |
| `main` | The stable channel. Its tip is always the last release. | **Only Hasan, by saying "merge to main".** |

### Rules

1. **All development happens on `dev`** — this session and every future one. Commit and push to `dev` as normal work.
2. **Never commit to `main`.** Not for a hotfix, not for a typo, not for a one-line docs fix, not because something is urgent. There is no exception that does not start with Hasan saying so.
3. **Never merge, rebase onto, cherry-pick into, or fast-forward `main` autonomously.** Not even when `dev` is green and `main` is behind. Being obviously-correct is not authorisation.
4. **`main` moves only when Hasan explicitly says so** — the words **"merge to main"** or **"push to main"**. Nothing else counts: not "ship it", not "release it", not "looks good", not approving a diff, not merging a PR into `dev`. If you think a release is due, *say so and wait*.
5. **A change is not done until it is installable.** Hasan runs a real box on the Development
   channel and presses Update as soon as work is reported. So every change on `dev` goes:
   commit → push → CI green → confirm the `:dev` image actually published (the workflow's
   "What was published" step prints the digest and the immutable `:dev-<12-char sha>` tag) →
   only then report it. Never leave work committed locally, and if CI failed or nothing
   published, say so plainly instead of reporting the change as shipped — from the box, a
   change that never reached GHCR is indistinguishable from a broken update.
6. **After every push to `dev`, ask.** End the reply with a clear one-line offer — *"Pushed to `dev`. Do you want me to push to main?"* — and then keep working on `dev` until he answers with the words in rule 4. Ask every time, not once per session: the answer is per change, and silence is not a yes. A "no" (or no reply) means carry on pushing to `dev` as normal.
6b. **Version every dev build you want installable.** OpenMasjidOS decides an app has an update by comparing the catalog's `version:` with the installed one, so a dev build that reuses the last stable version is *undetectable* — nothing to notify about, nothing to install. So on `dev`, `version:` is a **semver prerelease `X.Y.Z-dev.N`**: `X.Y.Z` is the release being worked toward, `N` increments on each publishable dev build. Stable 0.10.2 → `0.11.0-dev.1`, `-dev.2`, … → ships as `0.11.0` → dev moves to `0.12.0-dev.1`. It must never equal a stable version; `0.10.2 < 0.11.0-dev.1 < 0.11.0` is exactly right.

    Bump **all six together** — `VERSION`, `manifest.yaml`, `server/package.json`, `web/package.json`, both lockfile `version` fields (each carries it **twice**: top level and `packages[""]`) — **and** the tag in `docker-compose.yml`, which must equal `manifest.yaml`'s version exactly.

    **CI now genuinely checks all of them** (`build-image.yml` → "Check every version field agrees"), plus the `:dev` line and the prerelease shape. Until 0.12.0 this sentence was a promise the workflow did not keep: it compared the compose tag against the manifest and nothing else. That gap mattered because **`server/package.json` is where `config.version` is read from** — forget it and the build is green, the image publishes, and the server tells every tablet the *previous* version is the latest, which is a permanent false "Update available" that installing cannot clear.

    The `-dev.N` **shape is load-bearing**: the platform compares dotted-numeric parts, so `N` must sit in its own dotted position. `0.11.0-dev1` collapses to `0.11.0` and is silently never offered. Pinned by `server/src/config.test.ts`.
7. **That merge is a release.** When told, run the full runbook: set the release version (drop the `-dev.N`) in `VERSION` + `manifest.yaml` + `server/package.json` + `web/package.json` (and their lockfile `version` fields) and write the `CHANGELOG.md` release entry (rule 7b) → merge to `main` → let CI publish the stable image → copy the printed `@sha256` digest into `docker-compose.yml` → tag `vX.Y.Z` on that pin commit → **open a PR against OpenMasjidAPPS `dev` and stop there** (rule 7c — you cannot and must not push the catalog yourself) → start the next dev cycle at `X.Y+1.0-dev.1`. `VERSION` moves on `dev` too (rule 6b), and so does `CHANGELOG.md` (rule 7b).

7b. **`CHANGELOG.md`: two audiences, one file.** The changelog ships *inside the image* — the admin panel's "What's new" reads it from disk — so it is a product surface, not a git artefact, and it has to serve a masjid admin reading release notes and a developer tracking `dev` at the same time. It therefore has two kinds of section, and both branches carry the file:

    | Section | Lives on | Contains | Written |
    |---|---|---|---|
    | `## Unreleased` (always at the top) | **`dev` only** | **Every** dev change, in full: fixes, internals, docs sweeps, dead code, anything a tester on the dev channel would notice or want explained. | On each publishable dev build, as part of the same commit. |
    | `## X.Y.Z` | **both** branches | **MAJOR changes only** — what a masjid actually needs to know: new capability, changed behavior, a fix for something they hit. Not internals, not refactors, not doc edits. | At release, by distilling `## Unreleased`. |

    **At release:** distil `## Unreleased` down to the major-only `## X.Y.Z` entry. `main` gets that entry and **no `## Unreleased` section at all** — a stable install must never read notes for code it isn't running. `dev` gets the same `## X.Y.Z` entry *plus* a fresh empty `## Unreleased` above it for the next cycle. The two files differ only by that section, and that difference is deliberate and permanent — do not "fix" it by syncing them.

    **Never delete or rewrite a released `## X.Y.Z` section.** They are the notes running installs display. (This has been broken twice: once by merging `main` into a stale branch, which silently dropped twelve of them, and once by an edit whose search text started at the `## Unreleased` heading and whose replacement did not put it back. Check `grep -c '^## ' CHANGELOG.md` before and after any changelog edit.)

7c. **Getting a stable release into the OpenMasjidOS catalog — you go as far as a PR, and no further.** Stable moves only through a **catalog release run by a catalog maintainer**. Our part ends at an open pull request.

    **Step 1 — in THIS repo, in this order. The order is the whole point.**

    1. Bump `manifest.yaml` (and the rest of rule 6b's fields) to the release version.
    2. Let CI build and publish the image.
    3. Commit `docker-compose.yml` carrying the **published image's `@sha256` digest**.
    4. **Tag the digest-pin commit from step 3 — not the commit before it.** The commit before it is the one *called* `release: vX.Y.Z`, the one that bumps every version field and reads like the release. That is the wrong one, and it is the one you will reach for. Its `image:` line has no digest yet (or still carries the last release's), because the digest cannot exist until CI has built from it. Tag it and the tag ships the **previous** release's code under the new version number, for anyone pinning by tag. **This has already happened twice.**

        ```
        27e322b  release: v0.11.0                          <- version bump. NOT this one.
        bb56a5e  build: pin 0.11.0 to the digest CI published   <- tag THIS one.
        ```

        Check before tagging, don't assume: `git show <commit>:docker-compose.yml | grep image:` must print an `@sha256:` that matches the digest CI printed under "What was published".

    **Step 2 — open a PR against `OpenMasjid-Solutions/OpenMasjidAPPS`, base branch `dev`, never `main`.** Change **only our own entry** in `registry.yaml`:

    ```yaml
      - id: kiosk
        ref: v0.12.0        # the tag just published — the human label
        commit: <40-char SHA of the tagged commit>
    ```

    `commit:` is **what actually gets fetched**; `ref:` is only a label. Get it with `git rev-list -n1 v0.12.0`. Follow step 1 and they are the same commit. **If they ever differ, pin the commit that has the correct digest** — the code that gets installed comes from `commit:`, so that is the one that has to be right.

    **Step 3 — stop.** Do not commit to the catalog's `main`. Do not merge the catalog's `dev` into `main`: the two branches legitimately hold *different builds* of `catalog.json`, and merging them corrupts both channels. A maintainer runs the release that moves `main`.

    **The dev channel needs none of this.** `dev_ref: dev` tracks our `dev` branch automatically and rebuilds hourly. Just keep the prerelease version and its version-tagged image current — and **publish the image before pushing the version bump**, because the dev tag is exact and an entry that lands first is a pull failure on someone's box.

    **The trap that makes `ref:` and `commit:` drift apart here.** `build-image.yml` triggers on `v*` tags, so pushing the tag **rebuilds and republishes** `:X.Y.Z` — moving it off the digest the tagged commit pins. The image is not bit-reproducible, so the new digest genuinely differs. Re-pinning afterwards creates a commit *after* the tag, and that is the commit whose digest matches what `:X.Y.Z` now serves. At v0.10.2 and v0.11.0 both, the release therefore ended with `ref:` and `commit:` pointing at different commits. That is survivable — every digest published stays immutable and pullable, and the source trees are identical because `docker-compose.yml` is in the workflow's `paths-ignore` — but it is exactly the ambiguity step 1 exists to prevent, so **pin the commit whose digest `:X.Y.Z` actually resolves to**, and say plainly in the PR which commit that is and why it is not the tag.
8. **Re-pin the image line when merging to `main`.** `dev` carries `:X.Y.Z-dev.N`; `main` must always carry `:<version>@sha256:<digest>`. A merge that leaves the dev line on `main` would point every stable install at a development build — check it explicitly, every time. CI enforces both directions (a prerelease version or image reaching stable fails the build), but do not rely on that to notice for you.

### Update channels (how the two branches reach a masjid)

OpenMasjidOS has an Update Channel toggle, and the OpenMasjidAPPS catalog resolves this app per channel:

| Channel | Git ref | `version:` | Image the compose installs | Also published |
|---|---|---|---|---|
| stable | the `vX.Y.Z` tag (registry `ref:` + immutable `commit:`) | `X.Y.Z` | `:<version>@sha256:…` | `:latest` |
| dev | the `dev` branch | `X.Y.Z-dev.N` | `:X.Y.Z-dev.N` (exact, immutable) | `:dev`, `:dev-<12-char sha>` |

**Both channels are versioned and both install an immutable image.** They differ only in *how* the image is made immutable — a digest on stable, a per-build version tag on dev — and in who they are for.

`:dev` still exists as a convenience alias for `docker pull`, and `:dev-<sha>` still identifies exactly which commit a box runs. **Neither is what the catalog installs**, and the compose must never name them (CI fails the build if it does).

`.github/workflows/build-image.yml` decides the channel from the **git ref, not the event**, so a manual `workflow_dispatch` run on `dev` can never publish `:latest`. Both channels run the *full* pipeline — Gradle APK → web → server → multi-arch (amd64 + arm64) image — so a dev image ships a dev APK built from the dev branch, and an arm64-only regression surfaces on the channel that exists to catch it.

Every dev build also gets an immutable `:dev-<12-char sha>` tag. `:dev` means "newest"; `:dev-<sha>` identifies exactly which commit a box is running. Both are convenience aliases for `docker pull` — **neither is what the catalog installs**, which is the versioned tag above.

The workflow's **"Check the compose image matches the channel"** step fails the build if `docker-compose.yml` is ever wrong for the ref it is on:

| On | Fails when |
|---|---|
| `dev` | the image says `:dev`; the tag doesn't equal `manifest.yaml`'s `version:`; the version isn't a `X.Y.Z-dev.N` prerelease; the compose has more than one `image:` line (the check only reads the first) |
| `main` / `v*` | the image says `:dev` or names a prerelease; the version is a prerelease; (tags only) the image isn't `@sha256`-pinned |

A digest pin on `dev` is *allowed* — `:X.Y.Z-dev.N@sha256:…` passes — because the version tag is already immutable, so a digest adds integrity without freezing the channel. It is simply not required.

### The dev channel end to end (all of it is now wired)

Both gaps that used to be listed here are closed. What the path looks like today, and where it has bitten:

- **Catalog.** `OpenMasjidAPPS/registry.yaml` carries `dev_ref: dev` for `kiosk`, and the catalog build is channel-aware: it publishes a **separate catalog per branch**, and OpenMasjidOS reads `OpenMasjidAPPS/<channel>/catalog.json`. The dev entry serves this branch's `docker-compose.yml` verbatim, so that file's image tag is what a masjid actually installs. Confirm with:
  `curl -s https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/dev/catalog.json`
- **Never let the catalog entry outrun the image.** The dev tag is exact, so an entry published before its image exists is a pull failure on someone's box. `build-image.yml` dispatches the catalog rebuild *after* the push, which orders it correctly — but OpenMasjidAPPS also rebuilds **hourly**, so a tick landing during the ~7-minute build can still catch a new `version:` before its image. That is why the version bump belongs in the same push as the build that publishes it, and never ahead of it.

    **What the catalog actually does in that window (observed 2026-08-21):** it falls back to our **stable** entry, so a dev box is briefly told the current version is the last release — a silent cross-channel downgrade, not the loud pull failure this section used to predict. It lasted about three minutes and recovered on the next rebuild, and every other app kept its own dev prerelease throughout, so it is the catalog resolving *our* entry and preferring `ref:` over `dev_ref:` when the dev image is not in GHCR yet. Nothing to fix here — the bump and the build are already one push, and the gap is inherent — but worth knowing before someone chases a phantom downgrade, and worth raising with a catalog maintainer: keeping the previous dev entry would be the better fallback.
- **APK channel identity.** `VERSION` itself now carries the prerelease, and both the APK (`versionName`) and the server (`config.version`) read it — so a dev tablet reports `0.11.0-dev.1` against a dev server saying the same, and the tablet's string comparison stays honest. The old `APP_VERSION_SUFFIX=-dev` mechanism is retired (CI passes an empty suffix): it existed only because `VERSION` used to be identical on both branches, and appending to a prerelease would give the uncomparable `0.11.0-dev.1-dev`. `applyVersionSuffix` now refuses to touch a version that already has a prerelease, so re-enabling it is harmless. `versionCode` stays a hardcoded `1` **on purpose** — equal versionCode is a permitted reinstall, so dev and stable APKs install over each other in both directions; a higher dev versionCode would make the stable APK a genuine downgrade and trap the tablet.
- **How an update actually lands.** OpenMasjidOS compares the catalog's `version:` with the installed one — the same mechanism on both channels. That is the whole reason dev builds carry `X.Y.Z-dev.N`: with the old scheme (stable version + moving `:dev` tag) a new dev build changed nothing observable, so the platform could not notify and had nothing to install.

  **Two failure modes are worth knowing, because both were silent.** (1) Before versioned dev builds, the platform fell back to re-pulling `:dev` and comparing image digests — and that comparison read `listContainers().Image`, which moby replaces with the image **ID** as soon as the recorded name resolves elsewhere, i.e. exactly when a pull moves a tag. Every dev update answered *"already running the latest Development build. Nothing was changed."* (2) A suffix applied to only one half. `build-image.yml` stopped passing `APP_VERSION_SUFFIX` while `build-apk.yml` kept appending `-dev`, so the `0.11.0-dev.1` image bundled an APK calling itself `0.11.0-dev.1-dev` — a permanent false "update available" on every dev tablet that installing could never clear. **The server half and the APK half must always change together**; both now refuse to suffix a version that already carries a prerelease.

---

## 1. What we are building (one paragraph)

**OpenMasjidKiosk** turns a wall-mounted Android tablet with a **Stripe Reader M2** into a beautiful tap-to-donate station for a masjid. It has **two parts in one repo**: (1) a **server** — a normal OpenMasjidOS app (one Docker container: Fastify API + admin web UI + SQLite) that holds all configuration, records donations, and talks to Stripe with the secret key it fetches from the **OpenMasjidOS Fabric**; and (2) an **Android app** — a Kotlin kiosk/launcher that a volunteer installs by browsing to the server's setup page (e.g. `http://192.168.1.x:7878/new`), downloading the APK, and entering a short **6-digit pairing code** (no camera needed — most kiosk tablets don't have one). The tablet shows a GiveALittle-style giving screen — **six preset amounts + a custom amount**, one-time or **monthly** — takes the card on the M2 reader (**Bluetooth or USB**), and shows a custom thank-you. The app is locked in kiosk mode and can only be exited with a **PIN set in the admin web UI**. Everything matches the OpenMasjidOS design language, is served over **HTTPS**, and is **AGPL-3.0-only**.

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
  ├── CHANGELOG.md             # ships INSIDE the image — the panel's "What's new" (rule 7b)
  ├── server/                  # Node 22 + TypeScript + Fastify + better-sqlite3
  ├── web/                     # React + Vite + Tailwind admin panel (+ /new page)
  ├── android/                 # Kotlin + Jetpack Compose kiosk app (Gradle)
  ├── docs/                    # TABLET_SETUP, READER_SETUP, ARCHITECTURE, REMOTE_ADOPTION,
  │                            #   STUDENTS_INTEGRATION, FABRIC_BILLING_CONTRACT, audit/
  ├── assets/                  # README artwork (not shipped in the image)
  ├── apk/                     # CI drops the built APK here for the Dockerfile to bundle
  └── .github/workflows/       # build-image.yml (GHCR multi-arch) + build-apk.yml + cla.yml
  ```
  *(The building guide suggests repos named `openmasjid-<id>`; the shipped apps use the `OpenMasjidX` style. Keep `OpenMasjidKiosk` for consistency with Display/Donations — what must match is the **image name**: the compose references the lowercased repo, `ghcr.io/openmasjid-solutions/openmasjidkiosk`.)*
- **App `id`: `kiosk`** — same everywhere (manifest + registry entry). Category: `donations`.
- **Host port: `7878`** (container `8080`). The platform remaps conflicts and, because we set `https: true`, also serves us over **HTTPS on a dedicated port** with its own certificate — our container stays a plain HTTP server.
- **Image:** `ghcr.io/openmasjid-solutions/openmasjidkiosk:<version>@sha256:<digest>` — public, multi-arch (amd64 + arm64), **digest-pinned** in the compose.
- Registered by PR to OpenMasjidAPPS `registry.yaml`: `- id: kiosk / repo: OpenMasjid-Solutions/OpenMasjidKiosk / ref: v0.1.0` (ask the maintainer to pin an immutable `commit:` SHA per the guide).

---

## 4. Scope

> **This section is the original v1.0 plan, kept for the boundaries it draws — especially the ❌ list, which is where the security-relevant "we do not do that" decisions live.** It is not a feature list: the app has grown well past it (campaigns, tuition, branded receipts, remote adoption, recurring-plan management, refunds, the donor cancel link). **`README.md` is the live description of what ships**; struck-through entries below record where the boundary genuinely moved and why.

### ✅ In scope (v1.0)
**Server (the OpenMasjidOS app)**
- One-click install (**no install settings** — everything is configured in-app, like Display).
- **Fabric:** `sso: true` (admin panel shares the dashboard login, with local-password fallback), `stripe: true` (**in-app Stripe account picker**), `https: true` (required for Stripe apps), `notifications: true` (best-effort "New donation" alerts — fail soft).
- **Admin panel:** Devices (kiosks), Giving-screen designer, Payments, Donations log, About.
- **`/new` onboarding page:** downloads the bundled APK + shows setup instructions and the **6-digit pairing** flow.
- **Device pairing & fleet management:** **6-digit pairing codes** (typed on the tablet — no camera/QR), per-device tokens, rename/revoke, heartbeats (online, battery, charging, reader status, app version), per-device logs, remote config push.
- **Payments engine:** Terminal **connection tokens**, Terminal **Location** management, PaymentIntent creation (card_present), server-side verification + capture, **monthly subscriptions** created from the reader's `generated_card`, Stripe email **receipts**, donations recorded in SQLite with totals + **CSV export**.
- Test-mode badge whenever a test key is in use.

**Android app (the kiosk)**
- Distributed via `/new` (sideload APK); on first run the volunteer **types the server address + a 6-digit pairing code** (no camera/QR — kiosk tablets often have none). The app pins the server's HTTPS certificate on that first successful pair (**trust-on-first-use**), since the fingerprint can no longer travel in a QR.
- **Stripe Reader M2 over Bluetooth AND USB** — discovery, connect, battery level, required-update handling, auto-reconnect — all set up inside the app's (PIN-protected) settings.
- **GiveALittle-simple giving flow:** attract screen → 6 preset amounts + "Other" number pad → one-time / monthly → (optional) name & email, **both required for monthly** → tap/insert card → processing → **custom thank-you message** → auto-reset.
- **Kiosk mode:** the app is a HOME launcher, uses **Lock Task Mode** when provisioned as device owner (documented one-time ADB step), falls back to screen pinning; screen kept awake; auto-starts on boot; exit only via hidden gesture + **PIN set in the admin web UI**.
- Sends logs/heartbeats/status to the server; pulls theme + config (wallpaper, accent, amounts, messages) live.
- Matches the OpenMasjidOS design language (DESIGN.md) on Android: dark default, emerald/gold, spring motion, reduced-motion respect, RTL-ready.

### ❌ Out of scope (v1.0)
- Any handling of card numbers by our code (reader + Stripe only).
- **Webhooks** and any app-run public server. (Tablet + server both need outbound internet to Stripe.)
- ~~Public/internet exposure~~ — **now supported (v0.9.20+) as opt-in REMOTE ADOPTION** over the OS
  Cloudflare tunnel (manifest `domain: true` + `tunnel: true`). A tablet at another site pairs to
  `https://omos.<domain>/<basePath>` (default `/kiosk`) once the admin turns on Remote access in
  OpenMasjidOS AND flips "Allow remote adoption" in our admin. **Kiosk-endpoints-only over the tunnel**,
  and it is an **allowlist, not a denylist** — `blockedOverTunnel` in `tunnel.ts` refuses *every* `/api`
  path except `/api/app`, `/api/public/*` and `/api/kiosk/*`, plus all of `/fabric/*`. (This used to
  read "404s `/api/admin` + `/api/fabric`", which understates it in the direction that matters: add a
  new `/api/…` route for the tablet and it is refused over the tunnel until you allow-list it. And
  `/fabric` is **not** under `/api`, so it needed its own rule — every non-`/api` path falls through as
  allowed, which is correct for the SPA, `/new`, `/download` and `/uploads`, and was quietly wrong the
  day the first `/fabric/*` route shipped.) The admin panel stays LAN-only.

  **The tablet chooses its TLS mode from the ADDRESS TYPED, not from the certificate chain**
  (`KioskRepository.isPrivateHost`): a private-range IP, `localhost`, `*.local` or `*.lan` gets
  self-signed + trust-on-first-use pinning; anything else gets ordinary system-CA validation with
  hostname verification, which is what a Cloudflare hostname needs. See `docs/REMOTE_ADOPTION.md`.
- ~~refunds in-app (point admins at the Stripe dashboard)~~ — **now supported.** Opening a donation in
  Admin → Donations offers **Refund** (full or partial, with a Stripe reason). The server refunds the
  PaymentIntent, records the running refunded total on the row, emails the donor a branded refund note
  when they left an address, and raises the `donation-refunded` alert (which OpenMasjidOS fans out to
  the admin's email and/or webhook). **Every donation total is netted** (`amount - refunded`) so the
  headline figures never overstate what the masjid kept; the CSV gains Refunded/Net/Refund ID columns.
  Refunding a monthly's payment does **not** cancel the plan — the UI and the alert both say so.
- Gift Aid, donor accounts, printed receipts, iOS, non-Stripe processors, offline payments (Terminal offline mode is a later feature).
- Play Store distribution (sideload via `/new` is the model; Play listing is a later decision).

### 🔭 Later (design for, don't build)
- ~~Per-device amount presets & campaigns~~ — **built.** Campaigns are first-class (own amounts, colors, images, type, Stripe account, thank-you) and each targets chosen kiosks.
- ~~`domain: true`~~ — **built**, though not as the "public giving link from a kiosk QR" originally imagined. It carries **remote adoption** (pairing a tablet at another site) and the **donor's monthly-cancel link**. A public giving *page* remains unbuilt.
- Still later: Gift Aid; Terminal offline mode; Play Store / managed provisioning (QR device-owner enrolment); WisePOS-style internet readers; donor accounts; a screen for the `admin_audit` trail (the data and `GET /api/admin/audit` exist; nothing renders them).

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
- **Stripe account (this is "the Fabric gets the Stripe acc from the OS"):** the admin adds named Stripe accounts once in **OS Settings → Payments**. Our Payments screen lists them via `GET /api/fabric/stripe/accounts` (no keys) and stores only the chosen **account id**. On process start (and on account change) fetch keys via `GET /api/fabric/stripe?account=<id>` with the app secret; hold `publishableKey`/`secretKey` **in memory only**. Show a **TEST MODE** badge for `sk_test_`/`pk_test_`. Keep manual key entry as the **standalone fallback** only (platform absent), clearly labeled.
- **Restore resilience (required):** read `OPENMASJID_*` from env on every start; never persist them or fetched keys or a "linked" flag; all Fabric calls time out (~4 s) and fail soft to standalone.
- **Notifications:** after a successful donation, `POST /api/fabric/notify` (`"$20 donation received at the foyer kiosk"`, level `success`). Best-effort; never block or depend on it.

---

## 7. Devices: `/new`, pairing, and transport security

- **`/new`** (public route on the app's port): a friendly one-page setup guide — big "Download the kiosk app" button serving the **APK bundled into the server image at build time** (so the app version always matches the server), sideload instructions ("allow installs from your browser"), and "then enter the **6-digit pairing code** from **Admin → Devices**."
- **Pairing (6-digit code, no camera):** Admin → Devices → **Add kiosk** generates a **single-use 6-digit pairing code (TTL 10 min)** and shows it next to the server's **HTTPS address** (with a Copy button, and a warning if you are viewing the panel on localhost, which a tablet cannot reach). **No certificate fingerprint is shown** — this line used to promise one "for optional out-of-band verification", and nothing renders it because nothing *can*: `https: true` means the **platform** terminates TLS with its own certificate, so this container never sees the cert a tablet will be offered. Trust-on-first-use is therefore the whole of the pinning story, not a fallback beside a manual check, and §14 should be read that way. On the tablet the volunteer **types the server address and the 6-digit code**; the app calls `POST /api/kiosk/pair` over HTTPS and receives a long-lived **device token** (random 256-bit, hashed at rest server-side, shown never again). Because the fingerprint can't ride in a QR, the app **pins the certificate it sees on that first successful pair (trust-on-first-use)**. The code is single-use, short-lived and attempt-limited so a 6-digit space can't be brute-forced.
- **Transport:** the tablet **only ever talks HTTPS** to the server, with the certificate **pinned on the first successful pair (trust-on-first-use)** (custom trust evaluation thereafter accepting exactly that cert/public key — correct for the platform's self-signed LAN certificate; never fall back to plain HTTP; re-pair if the fingerprint changes, with a clear admin-facing explanation). All kiosk API calls carry the device token; the server scopes every route to that device and rate-limits.
- **Fleet management:** heartbeat every **10 s** (`KioskViewModel.HEARTBEAT_INTERVAL_MS`), with the server treating a kiosk as offline after **35 s** (`ONLINE_MS` in `index.ts`, which the WhatsApp `kiosks` command deliberately shares so the two never disagree). Carries `battery`, `charging`, `readerStatus`, `readerSerial`, `readerBattery`, `appVersion`, `configVersion` → Devices page shows live status, flags "not charging" (a wall kiosk should always be on power) and "offline". Actions: rename, **revoke** (kills the token; kiosk returns to pairing), show a fresh pairing code, *identify* (kiosk flashes), push config now. Structured device **logs** (payments, reader events, errors) viewable per device.
- **Config:** one versioned JSON (amounts, currency symbol, monthly on/off, name/email prompt policy, thank-you message, wallpaper, accent, theme, **kiosk-PIN hash**). Kiosks fetch on heartbeat when the version bumps; applied live with a gentle transition.

---

## 8. Payments (Stripe Terminal — the core)

Use the official **Stripe Terminal Android SDK** on the tablet and the **`stripe`** Node SDK on the server (pinned versions, fixed API version). The M2 is a Bluetooth-LE reader that on Android also supports **USB** — support **both**, selectable in the app's reader settings.

- **Connection tokens:** the app's `ConnectionTokenProvider` calls `POST /api/kiosk/connection-token` (device token auth); the server mints it via Stripe with the secret key. This is the only credential the tablet ever gets, and it's short-lived by design.
- **Location:** Terminal readers must connect with a `locationId`. On first Payments setup the server ensures a Terminal **Location** exists (named after the masjid, address entered by the admin — remember: the platform injects no profile) and hands its id to kiosks. Admin can pick an existing Location instead.
- **One-time donation flow:**
  1. Kiosk → `POST /api/kiosk/payment-intents` `{amountMinor, campaignId?, monthly?, manual?, coverFees?, donorName?, donorEmail?, idempotencyKey?}` — the real `PaymentIntentBody` schema in `index.ts`. **There is no `oneTime` field** (this line used to claim one): one-time is simply `monthly` absent, and because zod strips unknown keys, a client written from the old sketch that sent `{oneTime: false}` got a one-time donation *silently* — the donor charged once, no Subscription, and no error to notice. The server validates the amount against **that campaign's** presets/custom bounds (`isAllowedAmountForCampaign` — never trust client amounts, integer minor units only), computes cover-fees itself, and refuses a `tuition` campaign outright so a crafted tablet can't mint a tuition charge as a plain donation.
  2. Server creates the PaymentIntent on the **campaign's** Stripe account (its own, or the primary) with `payment_method_types: ['card_present']` and `capture_method: 'manual'`, and returns the client secret. **Keyed entry is a second path** — `manual: true` → `createCardPaymentIntent`, `payment_method_types: ['card']`, the card typed into Stripe.js inside `ManualCardWebView` (`assets/kioskpay.html`), never a browser, because a device-owner Lock Task kiosk allow-lists only our package. The tablet falls back to it automatically when no reader is connected.
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
- **Lock Task Mode:** when the app is **device owner**, use `startLockTask()` for true kiosk (no status bar pulldown, no recents/home escape). Document the one-time provisioning in `docs/TABLET_SETUP.md`: factory-reset tablet, skip accounts, `adb shell dpm set-device-owner org.openmasjidos.kiosk/.KioskAdminReceiver`. **Fallback** without device owner: **not** screen pinning — that was tried and removed in 0.11.0, because Android forbids a pinned app from launching any other app and says nothing when it refuses, which silently broke Android Settings, the permission prompts and the self-updater. The soft kiosk is: being the HOME launcher, immersive-sticky bars, a bounce-back watchdog, a dead Back button, and an optional accessibility helper that closes the notification shade. Be honest in docs about its limits.
- **Stay awake:** keep-screen-on flag while in kiosk; recommend "always plugged in" mounts; report charging state so the admin sees a fallen cable.
- **Unlock:** hidden gesture — **10 taps on the screen background** (`SECRET_TAPS`; unconsumed taps anywhere, *not* a corner: on a multi-appeal kiosk the corner is a campaign tab) → PIN pad → verifies against the **PIN set in Admin → Devices** (synced as a **scrypt** hash in config so unlock works offline; rate-limited with backoff; server-side verify when online). Unlock opens the maintenance screen: reader setup (BT/USB discovery, connect, update, battery), server address/re-pair, diagnostics, app version, **Exit kiosk** and **Return to kiosk**.
- **Boot & recovery:** BOOT_COMPLETED brings the app up even if not device owner; the app self-heals into the attract screen after crashes (foreground watchdog) and reconnects the reader automatically.
- **Permissions:** request-and-explain only what Terminal needs — Bluetooth scan/connect (API 31+) or location (older), USB host access — from the PIN-protected maintenance screen, which walks a volunteer through them with a reason for each.

  **One exception, and it is deliberate:** on a tablet that is **not** device owner, `MainActivity.onCreate` asks for `ACCESS_FINE_LOCATION` once at first launch, because Stripe's SDK requires it before it will look for *any* reader — including a USB one, which has no discovery UI to hang a prompt off. So on the soft-kiosk tier a bare Android permission dialog can appear over the giving screen on a cold start until it is granted. On a device-owner tablet `grantReaderPermissions` has already granted it silently and no dialog ever appears. (§10 used to say "never in the donor flow" without qualification, which is the sort of absolute that stops someone believing the rest of the paragraph once they see the prompt.)

---

## 11. The admin panel (web/)

Same SSO + design language as Donations. **Six top-level tabs** (`TABS` in `web/src/App.tsx` — this
list used to name Payments and About as tabs of their own, which would send you to add a screen
beside one that already exists inside Settings):

| Tab | `id` | What it is |
|---|---|---|
| **Dashboard** | `dashboard` | Totals at a glance, plus what needs attention. |
| **Devices** | `devices` | The fleet (§7): status cards, pairing, rename/revoke/identify/rotate, per-kiosk logs. |
| **Campaigns** | `giving` | The designer, opening full-page per appeal: amounts, design, type & fees, Stripe account, target kiosks, messages, live preview. |
| **Donations** | `analytics` | The log, netted totals, per-kiosk breakdown, CSV, and the **refund** action. |
| **Recurring** | `recurring` | Monthly plans, read live from Stripe: pause/resume, cancel, schedule an end, invoice history. |
| **Settings** | `settings` | Everything else, as panels **within** this tab (not tabs of their own). |

Note the two `id`s that do not match their labels — `giving` for Campaigns and `analytics` for
Donations. They are the original slice names and are load-bearing: the tab is reflected in the URL
hash, so renaming one breaks every bookmark and the profile menu's deep links.

Panels inside **Settings**: Payments (Fabric Stripe account picker §6, Terminal Location, currency,
test-mode badge, standalone key-entry fallback) · Notifications (per-alert routing, §18) · Email
receipts (the branded receipt designer) · the masjid address · the kiosk **exit PIN** · remote
adoption · About (version, docs links, the AGPL **Source code** link) · **What's new**, read from the
`CHANGELOG.md` shipped inside the image.

---

## 12. `manifest.yaml` & `docker-compose.yml` (the invariants — the files themselves are the spec)

**Read the two real files at the repo root.** They are heavily commented and they are what the catalog serves; a sketch here would only drift out of date, as the one that used to sit in this section did (it still showed `version: 0.1.0` and four Fabric flags long after there were nine). What this section pins is the set of properties a change must not break:

**`manifest.yaml`**
- `id: kiosk` · `category: donations` · `license: AGPL-3.0-only` · one port (`container: 8080`).
- **No `settings:` block, ever.** Install stays one-click; the Stripe account is picked in-app.
- Fabric flags currently declared: `sso`, `https` (mandatory — we take card payments), `stripe`, `notifications`, `email`, `domain`, `tunnel`, plus an `alerts:` list and `fabric.consumes: [students/billing]`. Adding a flag is opting into a platform capability and must be matched by real handling in `server/src/fabric.ts`.
- `version:` is the release being worked toward, in the shape rule 6b requires, and must equal the compose image tag exactly.

**`docker-compose.yml`**
- **Exactly one `image:` line** — CI's channel check reads the first and fails the build if there is more than one.
- The image reference matches the channel (rule 8): `:X.Y.Z-dev.N` on `dev`, `:<version>@sha256:<digest>` on `main`/tags.
- The three `OPENMASJID_*` vars **must be referenced** in `environment:`, plus `OPENMASJID_PUBLIC_URL` for remote adoption. Without those lines the platform's injected values never reach the container and the whole Fabric silently no-ops — the documented Display trap.
- Least-privilege per the contract: `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `tmpfs: [/tmp]`, and **no** labels, `privileged`, host namespaces, `devices`, Docker socket, sensitive mounts, `extends` or `include`.
- The container is a plain HTTP server; the platform terminates TLS and provides the HTTPS endpoint.

**Known deviation, deliberately not fixed:** the container runs as **root**. `USER node` alone would break every deployed masjid on update — `/data` and `kiosk.db` inside it are root-owned, and `cap_drop: ALL` removes `CAP_CHOWN`/`CAP_SETUID`, so an entrypoint cannot fix it either. It needs the Dockerfile, the compose and a documented one-time `chown` together, coordinated across the OpenMasjid apps. Residual risk is low (no capabilities at all, plus `no-new-privileges`). See `docs/audit/ACTION_REQUIRED.md` §5.

---

## 13. Tech stack

- **server/** — Node 22 (`node:22-slim` in the image), TypeScript strict, **Fastify**, **better-sqlite3**, **stripe** SDK, **scrypt** via `node:crypto` for the fallback admin password + PIN hashes (chosen over argon2 by the maintainer, 2026-07-02: zero extra native deps and Pi-friendly — see `docs/ARCHITECTURE.md`), **zod** at every boundary. No WebSocket (heartbeat polling is enough); add SSE for the Devices page if live feel demands it.
- **web/** — React + Vite + TypeScript + Tailwind (preflight off) + **lucide-react**, and that is the whole runtime dependency list. Tokens and recipes come from **DESIGN.md** (Sakīna Glass) as hand-written CSS in `src/styles/`; animation is CSS transitions and keyframes. (This bullet used to name **shadcn/ui** and **Motion** as well — neither was ever imported by a single file, and `motion` sat in `package.json` as an unused runtime dependency until it was removed on 2026-08-17. Prefer plain CSS here: the panel is a handful of screens and the design language is already expressed as tokens.) Inherits live appearance via the Fabric `#omos=` fragment + `/api/public/appearance` (treat the fragment as untrusted presentation input).
- **android/** — **Kotlin + Jetpack Compose**, minSdk 26 (Terminal SDK floor), **Stripe Terminal Android SDK** (Bluetooth + USB discovery/connect for the M2), DataStore for device config, WorkManager for heartbeats. **No camera/QR** — pairing is a typed 6-digit code (kiosk tablets often have no camera). Recreate the design language natively: same palette tokens, spring motion (`animate*AsState`/`AnimatedContent`), dark default, RTL, reduced-motion.
- **One container** serves API + admin + `/new` + the bundled APK. Multi-stage Dockerfile; CI: `build-apk.yml` builds + signs the APK (keystore in GH secrets, versionName from `VERSION`), `build-image.yml` builds web+server, **copies the freshly built APK into the image**, pushes multi-arch to GHCR, prints the digest to pin.

---

## 14. Security checklist (all mandatory)

- Secret key: Fabric → memory only; never to tablet/browser/logs/volume. Publishable key + connection tokens + PI client secrets are the only Stripe material the tablet sees.
- Tablet↔server: **HTTPS only, certificate pinned** on the first successful pair (trust-on-first-use); never downgrade; re-pair on fingerprint change. Device tokens hashed at rest, revocable, scoped, rate-limited.
- Amounts validated server-side (presets/min/max, integer minor units); idempotency keys on all Stripe creates; donation recorded only after server-side Stripe verification (+ capture when `requires_capture`).
- Admin: Fabric SSO as identity assertion only (never call the platform as the admin); fail-closed session check; local-password fallback; signed HTTP-only SameSite cookies; restore-resilience rules (§6) observed to the letter.
- Kiosk PIN: scrypt hash in synced config; offline verify; exponential backoff on attempts; PIN rotation from admin invalidates old immediately on next heartbeat.
- Uploads (wallpapers) validated and size-capped; rich text sanitized; every kiosk route authenticated; `/new` and pairing endpoints rate-limited (6-digit pairing codes single-use, 10-min TTL, attempt-limited so the 1M-code space can't be brute-forced).
- PCI posture: card data reader→Stripe only (P2PE-style); our code never sees a PAN — state this in the README.

---

## 15. Build & run

```bash
# server — the third command is NOT optional, see below
cd server && npm install && npm run build && npm run typecheck:tests && npm test
# admin web
cd web && npm install && npm run build
# android (debug apk)
cd android && ./gradlew assembleDebug
# everything the App Store runs
docker compose up -d
```

**`npm run build` does not type-check the tests.** `tsconfig.json` excludes `*.test.ts` (they run
from source under tsx, which strips types without checking them), so the suite is the one part of
the tree the ordinary build never sees. `tsconfig.test.json` + `npm run typecheck:tests` cover it;
four real errors were sitting in the tests, green, when that was added.

**CI runs both, plus the web build, on every push to `dev`/`main` and every pull request**
(`.github/workflows/test.yml`), and `build-image.yml` publishes nothing unless they pass. Before
0.12.0 it ran neither: the Dockerfile type-checked the shipping code and that was all, so a red
suite could not stop a release and a contributor's PR got no CI beyond the CLA bot.

Local dev: Vite proxies `/api` to the server; use Stripe **test keys** + the Terminal **simulated reader** (`isSimulated`) so the whole flow runs without hardware; test on a real M2 before release. `docs/TABLET_SETUP.md` covers tablet provisioning; `docs/READER_SETUP.md` covers M2 pairing/USB cabling.

**Boot it and press the thing.** `tsc` and the suite do not prove a route works: a `415` reached a
donor's cancel button because it was only reasoned about. `node dist/index.js` with `DATA_DIR` and
`PORT` set, then `curl` the surface you changed.

---

## 16. Definition of done (per feature)

Builds via the commands above and `docker compose up -d`; **`tsc` clean on the server, its tests and the web, and the suite green** — there is no ESLint and no ktlint in this repo, so "lint clean" means nothing here and this line used to ask for it; installs one-click on a real OpenMasjidOS and opens over the platform's HTTPS URL; SSO works with local fallback; Stripe account picked via the Fabric with **nothing persisted**; a simulated-reader donation completes end-to-end **with the donation recorded only after server verification**; monthly path creates a real Subscription in test mode; kiosk cannot be escaped without the admin PIN; light+dark, RTL, reduced-motion all pass on **both** web and Android; wording is plain and warm; no raw error ever reaches a donor.

---

## 17. Working agreement for Claude (the coding agent)

- **First**, read BUILDING_AN_APP.md (+ its CLAUDE.md and DESIGN.md), then the Donations and Display repos. They are the live contract and precedents; where this file lags them, follow them and flag it.
- **All nine slices below shipped in v0.1.0–v0.10.2 and the list is now history, not a plan.** It is kept because it still describes the *shape* of a change worth making: end-to-end and demoable, server + web + tablet together. Everything since has been built the same way. What the app actually does today is `README.md`; what it has done release by release is `CHANGELOG.md`. Features added after the slice plan — multiple campaigns, tuition via OpenMasjid Students, branded receipts, remote adoption, recurring-plan management, refunds, the donor's own cancel link — are documented there and in `docs/`.
- The original vertical slices, each end-to-end and demoable:
  1. Repo scaffold (all three parts) + Dockerfile + manifest/compose per §12; container boots, serves a themed admin shell, `/healthz`, and a stub `/new`.
  2. **Fabric:** SSO with local fallback + appearance inheritance + restore-resilience.
  3. **Payments setup:** Stripe account picker via Fabric, Location management, test-mode badge, connection-token endpoint.
  4. **Android shell:** Compose app, pairing (typed server address + **6-digit code**, **trust-on-first-use** cert pinning, device token), kiosk/launcher + PIN unlock + maintenance screen, heartbeats/logs → Devices page live.
  5. **Reader:** M2 discovery/connect over **Bluetooth and USB**, update handling, simulated-reader mode.
  6. **One-time donations** end-to-end (PI create → collect → confirm → server verify/capture → record → thank-you → notification), with the giving UI (6 presets + custom).
  7. **Monthly** (name/email gate, generated_card → Customer → Subscription, graceful non-reusable-card path) + receipts.
  8. **Giving-screen designer** (amounts, messages, wallpapers, accent, live preview) + live config push.
  9. Donations log + CSV; polish pass (motion, empty states, RTL, reduced-motion); docs; tag `v0.1.0`; APK bundling in CI; registry PR.
- Never put a Stripe secret anywhere the tablet or browser can see; never record a donation the server hasn't verified with Stripe; never let the kiosk be escapable without the PIN; ask before heavy dependencies or contract deviations.

---

## 18. WhatsApp: admin commands (and why we do not send)

OpenMasjidOS can send WhatsApp on a masjid's behalf through **OpenWA**, a self-hosted gateway the
masjid installs and links to their own phone, and it can now take **admin commands** back over it.
We never see the gateway, its credentials, or the number: we POST to the platform, which owns a
**single serialised queue** shared by every app and by its own alerts.

**Ban risk attaches to the NUMBER**, so the platform paces everything — randomised gaps, typing
indicators, per-recipient cooldowns, hourly/daily caps, a 7-day warm-up, and quiet hours that queue
rather than drop. Hence `202 { queued: true }` and never "sent": delivery is seconds to hours away.
**Nothing auth-critical may ever depend on it.** It is an unofficial client and the number can be
restricted. Email stays the fallback.

### What we implement: `POST /fabric/commands/run`

An admin messages the masjid's number and gets an answer about hardware nobody is standing next to.
The platform decides who may run what, renders the numbered menu **from our manifest order**, asks
for confirmation, and formats the reply. **We do not build a menu.** We execute one command.

**The command set is three read-only questions** (`takings`, `kiosks`, `recent`) — declared in
`manifest.yaml` and implemented in `buildCommands()`. A test parses the manifest and asserts the two
lists match, because drift shows up as a menu entry that answers "I don't know that one".

**Every command only reads, and that is a design decision rather than a starting point.** It is what
makes the follow-up conversation safe: see below.

**No donor identity is ever sent** — amounts, times, kiosks and funds only, never a name, an email
or a card. A WhatsApp thread keeps a copy forever on at least two phones, which is exactly why the
platform refuses to hand out app logs over this channel. A test feeds the commands a store whose
rows carry a donor name, email and card digits and asserts none of it reaches any reply.

Code: `server/src/commands.ts` (registry + pure rules), the route in `index.ts`, tests in
`commands.test.ts`. Rules that will bite if missed:

- **Verify BOTH headers.** `X-OpenMasjid-App-Secret` must equal our own `OPENMASJID_APP_SECRET`,
  **and** `X-OpenMasjid-Caller-App` must be exactly `omos:platform` — a value no app id can hold,
  because the colon is outside the app-id charset. It identifies the platform *by construction*,
  not by an allow-list.
- **An absent secret fails CLOSED** (`503 not_ready`). A standalone install has an empty
  `OPENMASJID_APP_SECRET`, and a naive equality check would let empty match empty — anyone on the
  LAN running admin commands with no credential at all. Pinned by a test.
- **`/fabric/*` is LAN-only** and must never cross the tunnel. This is *not* covered by the `/api`
  allowlist — `tunnel.ts` had to learn `/fabric` separately, because every non-`/api` path fell
  through as allowed. A credential check is the wrong last line of defense for something that can
  act on hardware.
- **10 second timeout; the platform also caps the body at 16 KB.** We never approach that cap and
  do not check it: every reply goes through `tidyReply`, whose `COMMAND_TEXT_MAX` of 1000 characters
  is the real limit. (A constant restating the 16 KB figure used to sit in `commands.ts` unread —
  it documented a check that did not exist, and has been removed.) We give up at 8s and answer
  "still working" so *we*
  own the message rather than having the connection cut. If a job is long, start it and say so.
- Reply shapes: `{ok:true,text}` · `{ok:false,error}` · `404 {ok:false,code:'unknown_command'}` ·
  `503 {ok:false,code:'not_ready'}`. Text is plain, ≤1000 chars, control characters stripped.
- **Never let an exception reach a phone** — messages here can carry a Stripe id or a file path.
- Manifest: at most **12** commands; `id` kebab-case, **not all digits** (`!kiosk 2` must only mean
  "the second option"), never `help`/`yes`/`no`/`cancel`/`stop`; `confirm: true` on anything that
  changes hardware state (it also puts the command in the admin's audit alert); `argument` must be
  an **object with a label** — `argument: true` is **rejected** at the catalog build, not coerced.
- **Never put `commands` in `fabric.provides`.** Reserved: it would expose the same handler to other
  apps through the app-to-app broker, a different trust boundary sharing a path prefix.

The platform already offers `!os restart <app>`, which restarts our whole container. A kiosk-level
command is the finer-grained, more useful thing.

### Follow-up questions (platform v0.51.0-dev.11+)

Return `followUp: { token }` beside your text and the platform treats the sender's **next message**
as an answer — no `!` prefix — and posts it back with `followUpToken` set. Omit `followUp` to finish.

**The token is the only state that survives a turn.** The platform stores it against that one sender
and keeps nothing else about the flow, so whatever a step needs to remember has to be encoded in it.
`takings` uses exactly that: `takings:pick` for the first ask and `takings:pick2` for the one retry
after a typo, so the retry counter lives in the token and this app holds no conversation state at
all. Charset `A-Za-z0-9._:-`, ≤128 chars.

**Validate a token before echoing it** (`validFollowUpToken`). It lands in a later request body, so
a malformed one is our bug arriving as a platform error — and the symptom is a conversation that
silently stops answering, which is near-undiagnosable from a chat window. The route drops an invalid
token rather than sending it, ending the exchange cleanly instead of half-opening one.

**THE THING THAT WILL BITE: the exchange can end without you.** Three minutes idle, fifteen minutes
total, twelve turns, the sender typing `exit`/`cancel`/`done`, or starting any new `!` command. You
just stop receiving answers, with no notification. **Never leave a half-applied change waiting on a
reply that may not come** — apply on the last answer, or keep your own draft with its own expiry.

This is the strongest argument for the command set being read-only: a question that only reads has
nothing to half-apply, so an abandoned conversation costs nothing and needs no draft, no expiry and
no reconciliation. **The day a command starts writing, that stops being free** — and that is the
moment to add a draft with its own expiry rather than trusting the sender to finish.

Also: **any `ok:false` ends the exchange**, which is why `CommandResult` only permits `followUp` on
the success side — a failed turn must never leave someone's ordinary conversation being read as
input. **Ask one thing at a time**; these are WhatsApp messages, not a form. And the sender is
re-authorised every turn, so a permission removed mid-conversation takes effect immediately.

A stray or unrecognized token must read as a **fresh turn**, never as an answer to a question we did
not ask — the route blanks anything that is not one of ours, and a test covers it.

### Sending: per-alert routing lives in OUR settings (`whatsapp: true`)

The platform's alerts matrix has **no WhatsApp column for apps**, on purpose — it routes to the
admin's single number and the platform cannot know which person a given app's alert is about. So
recipient choice is ours, and lives in **Settings → Notifications** (`server/src/alerts.ts`,
`web/src/alerts.tsx`). Each declared alert carries an `AlertRoute`:

| Field | Default | What it does |
|---|---|---|
| `os` | **true** | Relay via `POST /api/fabric/alert` → the platform's own matrix (email/webhook/off) |
| `email` | `''` | **Also** email this address directly, via the Fabric email provider |
| `whatsapp` | **false** | **Also** send a WhatsApp |
| `phone` | `''` | Where to. Digits, international, no plus |

**The three are ADDITIVE and each fails soft independently.** An alert exists to tell someone
something is wrong, so one channel being broken must never suppress another, and none may disturb
the donation, refund or reader event that raised it.

**The defaults are the load-bearing part.** `os: true` everywhere means an upgrade changes nothing —
nobody has to visit the new screen to keep the alerts they rely on. `whatsapp: false` means the new
channel is opt-in per alert, which is right for a channel that spends the masjid's own number's
reputation. Both are pinned by tests, as is "an alert added in a later release arrives at its
default rather than missing from the saved blob".

**Every alert goes through `raiseAlert`/`alert()` in `index.ts` — never `fabricAlert` directly**, or
the admin's choices are bypassed. Including the in-app **Send test**, which follows the same routing
on purpose: a test that took a different path would prove nothing about their configuration.

**A phone number with no country code is REFUSED, not guessed at.** The platform refuses one rather
than guessing, and so must we — a UK admin typing `07700 900123` means +44, but assuming that would
one day message a stranger in another country. A refused number does not wipe the saved one (a box
that empties itself reads as the app losing it, and they retype the same number).

`routeSummary()` reports what a route will *actually* do, so "WhatsApp on" with no number shows as
sending nothing rather than looking covered.

### The platform stopped pacing WhatsApp (OpenMasjidOS 0.51.1) — so we do

**Minimum platform versions:** WhatsApp send **0.51.0+**; message status and the durable queue
**0.51.1+**; a per-app outcome history and a separate read budget **0.51.1-dev.8+**. Treat an absent
`outcomes` field as `false` — never assume the status endpoint exists.

**What was broken on the platform, and looked like ours.** Its queue always examined the *first*
message; if that one could not go yet it slept and looked at the same one again, so a single held-up
message blocked every message from every app. A failing message paused the whole queue for its retry
delay — up to 15 minutes, up to 5 attempts. With a 30-minute per-group cooldown, one group image
could stop all WhatsApp traffic for half an hour. The queue also lived only in memory, so anything
held for a rate limit or a retry was destroyed on restart, which on the dev channel is often — while
we had been told `202 { queued: true }` and had no way to learn otherwise. All fixed in 0.51.1.

**What the platform no longer does for us — and this is the part that changes our code.** Quiet
hours, the hourly and daily caps, the per-recipient 60-second cooldown, the per-group cooldown, the
group caps, the warm-up ramp on a newly linked number, and the random 6–20 second gap between
messages are **all gone**. Only a typing indicator remains. A message we hand over goes out in
seconds.

That deleted a backstop we were relying on without having decided to. **`payment-failed` is the
alert that made it matter**: it fires on every PaymentIntent Stripe refuses and has no natural bound,
so expired keys on a Friday meant one message per person who tried to give, for the whole of jummah.
The 60-second cooldown used to absorb exactly that.

So pacing is ours: **`whatsappGate` in `alerts.ts`** — one WhatsApp per alert id per 30 minutes, with
the number held back carried on the next message so suppression is never silent. `test` is exempt
(an admin is watching the screen). State is in memory, so a restart lets one extra through — the
right direction to fail, since a duplicate alert costs nothing and a swallowed one costs the thing
the alert was about.

**Ban risk attaches to the NUMBER**, that number is shared by every app on the box, and a blocked
number cannot be recovered — the masjid loses the number their community reaches them on. It is the
one failure in this app nobody can undo. Hence also: one message per call (never a loop over a
roster), no retry around a `202` (it is already queued; retrying just duplicates), and the admin
chooses recipients because we know who ours are and the platform does not.

**Refusals are surfaced, not swallowed.** `POST /api/fabric/whatsapp` answers `400`/`403` with a
plain sentence — an unapproved group, a number with no country code, an empty message, too many
images queued, or (new in 0.51.1) *the masjid's own gateway number*, which used to be accepted and
go nowhere. Those used to reach a `log.debug` and nothing else, which is most of why this felt
mysterious: a refused message and a lost one were indistinguishable. They are now logged at **warn**,
stored per alert, and shown on the Notifications screen beside the switch that caused them.

**We store the message id and resolve it.** The `202` carries an `id`; `GET /api/fabric/whatsapp/status/<id>`
says `queued | sent | failed | expired`. `scheduleWhatsAppFollowUp` asks after a minute and again
after ten for responsiveness; `reconcileWhatsApp` then re-asks every 15 minutes about anything still
`queued`, until the platform's 24-hour window closes. The record holds no message text and no
recipient. A 404 means "not ours, or aged out", **never failure** — it also covers a platform too
old to have the endpoint.

**Why the reconcile exists, since the first version deliberately did without it.** It gave up after
ten minutes, reasoning that the history was only the most recent 200 records and that polling was not
worth the traffic. Both premises died in 0.51.1-dev.8: the history is **500 per app for 24 hours**
(that 200 was one ring *shared by every app*, so a big Students run could evict our reader-offline
record and every poll came back 404), and **status reads have their own 600/min budget**, separate
from sending, so a poll can no longer refuse a masjid's alert. Giving up at ten minutes meant a
message that failed at twenty read as `queued` in the panel for ever, which is the exact
"accepted and silently lost" state this feature exists to end. At most one read per alert id per
sweep — six, against six hundred.

**Do not add an `immediate` flag.** It was considered and dropped platform-side, correctly: it could
only skip the typing indicator (the last thing making the traffic look human) or jump a queue every
app shares — and every app would set it, so within a week it would mean nothing.

**Unchanged:** `202` means *accepted*, never delivered. There is no delivery receipt from WhatsApp.
Nothing auth-critical may ever ride on it — no codes, no resets. Email has a real provider; use that.

### What we deliberately do NOT do

- **No donor phone numbers, and no phone field on the kiosk** (maintainer, 2026-08-16). A donor at a
  kiosk gave their details for a receipt, not for announcements. WhatsApp here reaches **only the
  numbers an admin typed into Settings → Notifications**. If that ever changes: receipts one-to-one
  only, nothing else without a separate explicit opt-in.
- **Never depend on a WhatsApp send.** `202 { queued: true }` means accepted for later — the
  platform paces everything (randomised gaps, cooldowns, caps, quiet hours), so delivery is seconds
  to hours away. Email stays the fallback and nothing auth-critical may ride on it.

Full contract: OpenMasjidOS `docs/WHATSAPP.md` and `docs/APP_MANIFEST_SPEC.md`, **dev** branch.
