<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Contributing to OpenMasjid Kiosk

Thanks for helping! A few ground rules.

## Licensing

This project is licensed **AGPL-3.0-only** (see [`LICENSE`](LICENSE)) and contributions are
governed by the **Contributor License Agreement** ([`CLA.md`](CLA.md), the canonical text). By
submitting a contribution you agree it is licensed under **AGPL-3.0-only**, you certify the
[Developer Certificate of Origin](https://developercertificate.org/) (the work is yours to
contribute), and you accept the CLA. Sign your commits off:

```
git commit -s -m "..."
```

**Signing the CLA.** You sign **once**, automatically, on your first pull request: the CLA bot
comments with a link to [`CLA.md`](CLA.md) and asks you to reply with the exact sentence

> I have read the CLA Document and I hereby sign the CLA

The CLA keeps the public tree AGPL-3.0 while letting OpenMasjid-Solutions also offer
commercial/dual licenses; you keep your copyright. If you cannot accept the relicensing grant
(§2 of the CLA), say so in your PR and we'll take it AGPL-only or discuss.

## Where to branch from

**Open pull requests against `dev`, never `main`.** All development happens on `dev`; `main`'s tip
is always the last release and only the maintainer moves it. See the Branching policy at the top of
[`CLAUDE.md`](CLAUDE.md).

## Build and test

```bash
cd server && npm install && npm run build && npm test   # tsc + node --test
cd web    && npm install && npm run build               # tsc + vite build
cd android && ./gradlew assembleDebug                    # needs JDK 17+ and the Android SDK
```

All three must pass before you open a PR. Local development uses Stripe **test keys** and the
Terminal **simulated reader**, so the whole donation flow runs without hardware. `web`'s dev server
(`npm run dev`) proxies `/api`, `/healthz` and `/download` to the server on `:8080`.

## Code

- Keep it **AGPL-3.0-only** — every source file carries an SPDX header
  (`// SPDX-License-Identifier: AGPL-3.0-only`); add one to new files.
- It must build and pass tests before you open a PR.
- Match the surrounding style; the UI follows the OpenMasjidOS design language
  (dark default, WCAG AA, RTL-ready, honors `prefers-reduced-motion`).
- **Explain the non-obvious in comments, not the obvious.** This codebase's comments say *why* a
  thing is the way it is — usually because the other way was tried and broke something. Keep that.
- Don't weaken the security invariants noted in the code (Fabric secret handling, SSRF guards, and the reverse-proxy `X-Forwarded-*` handling).

## Things that are load-bearing

Changes here need care and a clear reason, because each was a real incident:

- **A donation is recorded only after the server retrieves the PaymentIntent from Stripe.** The
  tablet's word is never enough.
- **Amounts are validated server-side** against the campaign's presets and bounds; cover-fees are
  computed on the server. The tablet never dictates a price.
- **The Stripe secret key lives in memory only** — never sent to a browser or tablet, never logged,
  never written to `/data`.
- **The tunnel allowlist** (`server/src/tunnel.ts`) must judge the path the *router* resolves, not
  the one that arrived — that is what percent-encoding walked past once already.
- **`CHANGELOG.md` sections for released versions are never edited or deleted** — running installs
  display them. New work goes in `## Unreleased`.
