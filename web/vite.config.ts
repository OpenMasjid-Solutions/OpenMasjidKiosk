// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { ACCENTS, accentVars } from './src/accents';
import { RTL_LANGS, WALLPAPER_IDS } from './src/appearance';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

/**
 * The tables the pre-paint script in index.html needs, written into it at build time.
 *
 * That script runs before ANY module has loaded — it is what stops a light-theme masjid seeing a
 * dark flash, or a gold accent seeing cyan — so it cannot import accents.ts. Copying the table into
 * the HTML by hand would be a second copy that drifts; generating it from the same module the app
 * uses means there is only ever one. A placeholder left unreplaced fails the build rather than
 * shipping a page that silently skips its own theme.
 */
function prepaintTables(): Plugin {
  const accentTable: Record<string, { dark: Record<string, string>; light: Record<string, string> }> = {};
  for (const id of Object.keys(ACCENTS)) {
    const dark = accentVars(id, 'dark');
    const light = accentVars(id, 'light');
    if (dark && light) accentTable[id] = { dark, light };
  }
  const replacements: [string, string][] = [
    ['/*__ACCENT_VARS__*/{}', JSON.stringify(accentTable)],
    ['/*__WALLPAPER_IDS__*/[]', JSON.stringify(WALLPAPER_IDS)],
    ['/*__RTL_LANGS__*/[]', JSON.stringify(RTL_LANGS)],
  ];
  return {
    name: 'kiosk-prepaint-tables',
    transformIndexHtml(html) {
      let out = html;
      for (const [marker, value] of replacements) {
        if (!out.includes(marker)) throw new Error(`index.html is missing the pre-paint marker ${marker}`);
        out = out.split(marker).join(value);
      }
      return out;
    },
  };
}

// The admin panel + /new page are served by the Node server, which also exposes /api and
// the APK download. In dev (`npm run dev`) we proxy those to the server on :8080 so the
// same fetches work locally and in production.
export default defineConfig({
  plugins: [react(), prepaintTables()],
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
      '/uploads': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // React and the icon set change far less often than the app does. Kept in chunks of their own,
        // their hashed names survive an update, so an admin's browser keeps them instead of fetching
        // the whole bundle again after every dev build — the platform splits the same way.
        manualChunks: { react: ['react', 'react-dom'], icons: ['lucide-react'] },
      },
    },
  },
});
