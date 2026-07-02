// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

// The admin panel + /new page are served by the Node server, which also exposes /api and
// the APK download. In dev (`npm run dev`) we proxy those to the server on :8080 so the
// same fetches work locally and in production.
export default defineConfig({
  plugins: [react()],
  // Relative asset base so the built index.html references assets as ./assets/… — one
  // build works at the root regardless of how it's reached. Do NOT change to an absolute
  // base.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/download': 'http://localhost:8080',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
