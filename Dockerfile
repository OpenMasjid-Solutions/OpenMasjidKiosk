# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# OpenMasjid Kiosk — multi-stage, multi-arch (amd64 + arm64).
# The JS build stages run on the native BUILD platform (fast, arch-independent output);
# only the runtime stage runs as the TARGET arch, where `npm ci` pulls the correct
# prebuilt native binaries (e.g. better-sqlite3) for that architecture.
#
# The Android APK is NOT built here (that needs the Android SDK + JDK + a signing
# keystore). CI (build-image.yml) builds + signs it in a separate job and drops it into
# ./apk/ in the build context BEFORE this image build; the last runtime step copies it in
# so the server can serve it from /new. Locally (no APK) the build still succeeds — the
# apk/ folder ships a .gitkeep, and /new shows a friendly "app coming after the first
# build" message until a real APK is present.

# ---- Build the web admin (Vite → static files) -----------------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Compile the server (TypeScript → dist) --------------------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Runtime (target architecture) -----------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="OpenMasjid Kiosk" \
      org.opencontainers.image.description="Tap-to-donate kiosk for a wall-mounted tablet with a Stripe Reader M2." \
      org.opencontainers.image.source="https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk" \
      org.opencontainers.image.licenses="AGPL-3.0"

# ca-certificates: outbound HTTPS to api.stripe.com. tini: reap children + forward
# signals cleanly so the container stops fast and tidily.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Production deps only — this resolves any per-arch prebuilt native binary
# (e.g. better-sqlite3) for the target architecture.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=server /server/dist ./dist
COPY --from=web /web/dist ./public

# Bundle the Android kiosk APK, served by /new. CI drops the signed APK into ./apk/
# before this build; locally the folder holds only a .gitkeep (build still succeeds).
COPY apk/ ./public/download/

ENV PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    APK_PATH=/app/public/download/openmasjidkiosk.apk
EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
