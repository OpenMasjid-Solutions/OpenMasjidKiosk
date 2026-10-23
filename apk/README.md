<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# `apk/` — the bundled Android apps

This folder is where the two **signed Android APKs** — the kiosk (`openmasjidkiosk.apk`) and
OpenMasjid Mobile Donations (`openmasjidmobile.apk`) — are placed at build time so the server can
serve them from the setup page (`/new`). Their versionName always matches the server (all three
read the repo-root [`VERSION`](../VERSION) file), so neither app can drift from the server it pairs
with.

- **In CI:** `build-apk.yml` builds + signs both and uploads them as the `kiosk-apk` and
  `mobile-apk` artifacts; `build-image.yml` downloads both into this folder **before** the Docker
  build (and fails if either is missing), and the `Dockerfile` copies `apk/` into the image at
  `/app/public/download/`.
- **Locally:** this folder ships only `.gitkeep` (and this README), so `docker build` still
  succeeds. `/new` offers only the apps actually present; with no APK, its download button is
  disabled with a note that the app isn't included in this install yet.

The APKs themselves are **never committed** (see the repo `.gitignore`).
