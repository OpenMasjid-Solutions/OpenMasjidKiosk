// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Entry point: a Fastify server that serves the built admin web app, the public
 *  setup page (/new), the bundled Android APK, and the JSON API. Slice 1 establishes the
 *  themed shell + health check + /new. Later slices add the OpenMasjidOS Fabric (SSO,
 *  Stripe account, notifications), device pairing & fleet management, the payments
 *  engine (Stripe Terminal connection tokens + verify/capture), and the donations log. */
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';

const log = makeLog('main');

/** The download filename we hand the tablet — versioned so a stale cached copy is
 *  obvious. The URL path stays stable at /download/openmasjidkiosk.apk. */
const apkFilename = `openmasjidkiosk-${config.version}.apk`;

async function main(): Promise<void> {
  const app = Fastify({
    logger: false, // we log ourselves and never log secrets
    // trustProxy stays OFF: the app is port-mapped directly (no reverse proxy in front),
    // so a client-supplied X-Forwarded-For must NOT be trusted. Rate limiters (added in
    // later slices) key on the real TCP peer instead.
    bodyLimit: 1_048_576, // 1 MiB JSON cap (uploads get their own limit later)
  });

  await app.register(fastifyCookie); // parses req.cookies + decorates reply.setCookie (used from slice 2)

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

  // ── Public bootstrap the web app reads on load (no secrets) ─────────────────
  app.get('/api/app', async () => ({
    data: {
      name: 'OpenMasjid Kiosk',
      version: config.version,
      // True when running embedded under OpenMasjidOS (Fabric available). Wired now;
      // the SSO/appearance handshake itself arrives in slice 2.
      embedded: ssoConfigured(),
      // Whether the Android app is bundled in this image (false in local dev / before
      // the first CI build). The /new page uses this to show the download button.
      apkAvailable: fs.existsSync(config.apkPath),
      apkDownloadPath: '/download/openmasjidkiosk.apk',
      apkFilename,
    },
  }));

  // ── Download the bundled kiosk APK (served by /new) ─────────────────────────
  app.get('/download/openmasjidkiosk.apk', async (_req, reply) => {
    if (!fs.existsSync(config.apkPath)) {
      return reply.code(404).send({ error: 'The kiosk app isn’t available yet on this server.' });
    }
    const stat = fs.statSync(config.apkPath);
    reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="${apkFilename}"`)
      .header('content-length', String(stat.size))
      .header('cache-control', 'no-cache');
    return reply.send(fs.createReadStream(config.apkPath));
  });

  // ── Static web app (built by Vite into ./public) ────────────────────────────
  const indexPath = path.join(config.publicDir, 'index.html');
  const havePublic = fs.existsSync(indexPath);
  if (havePublic) {
    // index:false — we serve index.html ourselves (below) for the SPA + its routes.
    await app.register(fastifyStatic, { root: config.publicDir, index: false });
  } else {
    log.warn(`no built web app at ${config.publicDir} — run "cd web && npm run build" (dev uses the Vite server on :5173)`);
  }

  const rawIndex = havePublic ? fs.readFileSync(indexPath, 'utf8') : '';
  const sendIndexHtml = (reply: import('fastify').FastifyReply) => reply.type('text/html').send(rawIndex);
  if (havePublic) app.get('/', async (_req, reply) => sendIndexHtml(reply));

  // SPA fallback: client-side routes (e.g. /new, /admin) resolve to index.html; requests
  // that look like a file (have an extension, e.g. a stale /assets/x.js) still 404 rather
  // than silently returning the app shell; unknown API/health routes return JSON.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    const pathname = url.split('?')[0];
    const looksLikeFile = path.extname(pathname) !== '';
    if (req.method === 'GET' && havePublic && !looksLikeFile && !url.startsWith('/api') && !url.startsWith('/healthz')) {
      return sendIndexHtml(reply);
    }
    return reply.code(404).send({ error: 'Not found.' });
  });

  // Consistent JSON error envelope; never leak a stack trace or framework-internal text
  // to the browser. Only a message the app itself authored (expose: true) is surfaced;
  // everything else becomes a friendly line.
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { message?: string; statusCode?: number; expose?: boolean };
    log.error('request error', e.message ?? 'unknown');
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    const friendly =
      status === 413 ? 'That request was too large.' : status < 500 ? 'We couldn’t process that request.' : 'Something went wrong. Please try again.';
    reply.code(status).send({ error: e.expose && e.message ? e.message : friendly });
  });

  await app.listen({ port: config.port, host: config.host });
  log.info(`OpenMasjid Kiosk listening on http://${config.host}:${config.port}`);
  log.info(ssoConfigured() ? 'running embedded under OpenMasjidOS (Fabric available)' : 'running standalone (local admin, Fabric absent)');

  const shutdown = (code = 0) => {
    log.info('shutting down');
    app.close().finally(() => setTimeout(() => process.exit(code), 200));
    // Hard backstop in case app.close() hangs, so the container actually cycles.
    setTimeout(() => process.exit(code), 2000).unref?.();
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

main().catch((err) => {
  // Log the message only (not the whole error object) so a future thrown error can't
  // spill a key or connection string into the logs.
  log.error('fatal startup error', err instanceof Error ? err.message : err);
  process.exit(1);
});
