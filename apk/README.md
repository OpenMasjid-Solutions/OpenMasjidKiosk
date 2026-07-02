<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# `apk/` — the bundled Android kiosk app

This folder is where the **signed Android APK** is placed at build time so the server can
serve it from the setup page (`/new`). The versionName always matches the server (both
read the repo-root [`VERSION`](../VERSION) file), so the tablet app can never drift from
the server it pairs with.

- **In CI:** `build-apk.yml` builds + signs `openmasjidkiosk.apk` and uploads it as an
  artifact; `build-image.yml` downloads it into this folder **before** the Docker build,
  and the `Dockerfile` copies `apk/` into the image at `/app/public/download/`.
- **Locally:** this folder ships only `.gitkeep`, so `docker build` still succeeds. Until
  a real APK is present, `/new` shows a friendly "the app will be available after the
  first build" message.

The APK itself is **never committed** (see the repo `.gitignore`).
