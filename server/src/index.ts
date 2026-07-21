// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Entry point: a Fastify server that serves the built admin web app, the public setup
 *  page (/new), the bundled Android APK, and the JSON API.
 *
 *  Slice 1: themed shell + health check + /new + APK download.
 *  Slice 2 (this): the OpenMasjidOS Fabric — single sign-on (server→server) with a local
 *  admin-password fallback, live appearance inheritance, restore-resilience, and the
 *  notifications relay. Stripe/payments, device pairing & fleet management, and the
 *  donations log arrive in later slices. */
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { z } from 'zod';
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';
import { Store, grossUpForFees, type Device } from './store';
import { COOKIE, cookieOptions, hashPassword, hashPin, makeDeviceToken, makePairingCode, makeToken, verifyPassword, verifyToken, SSO_SESSION_MS } from './auth';
import { notify, probePlatform, fetchAppearance, fetchFabricStripe, fetchFabricStripeAccounts, clearFabricStripeCache, fetchFabricSite, cachedFabricSite } from './fabric';
import { studentsInfo, studentsLookup, recordStudentPayment, checkStudentPayment, createTuitionSession, getTuitionSession, computeTuitionAmount, billingConfigured } from './students';
import { LoginLimiter } from './rateLimit';
import { toCsv } from './csv';
import {
  completeCardPresentPaymentIntent,
  createCardPaymentIntent,
  createCardPresentPaymentIntent,
  createConnectionToken,
  createLocation,
  createMonthlySubscription,
  listLocations,
  looksLikePublishable,
  looksLikeSecret,
  publicStripeStatus,
  retrieveLocation,
  stripeConfigured,
  stripeMode,
  toMajor,
  verifySecretKey,
  type StripeKeys,
} from './stripe';

const log = makeLog('main');

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1)/i;

/** The download filename we hand the tablet — versioned so a stale cached copy is obvious.
 *  The URL path stays stable at /download/openmasjidkiosk.apk. */
const apkFilename = `openmasjidkiosk-${config.version}.apk`;

async function main(): Promise<void> {
  const store = new Store();
  const loginLimiter = new LoginLimiter();

  const app = Fastify({
    logger: false, // we log ourselves and never log secrets
    // trustProxy stays OFF: the app is port-mapped directly (no reverse proxy in front), so
    // a client-supplied X-Forwarded-For must NOT be trusted — the login limiter keys on the
    // real TCP peer instead.
    bodyLimit: 1_048_576, // 1 MiB JSON cap (uploads get their own limit later)
    // Base-path awareness (manifest `domain: true`): when OpenMasjidOS exposes us for REMOTE
    // adoption behind its Cloudflare tunnel, it forwards the FULL admin-chosen path prefix (e.g.
    // /kiosk) WITHOUT stripping it, so requests arrive as /kiosk/api/x, /kiosk/assets/y, etc. We
    // strip it here, before routing, so every route below stays written at the root and works
    // identically on the LAN (no prefix) and behind the tunnel. The prefix is the Fabric
    // `basePath` (cached, refreshed periodically); empty = LAN-only, nothing to strip. A request
    // that ARRIVES with the prefix came via the tunnel — we flag it so /api/admin stays LAN-only.
    rewriteUrl(req) {
      const url = req.url ?? '/';
      const base = cachedFabricSite().basePath;
      if (!base) return url;
      if (url === base || url.startsWith(base + '/') || url.startsWith(base + '?')) {
        (req as unknown as { omosViaTunnel?: boolean }).omosViaTunnel = true;
      }
      if (url === base) return '/';
      if (url.startsWith(base + '/')) return url.slice(base.length);
      if (url.startsWith(base + '?')) return '/' + url.slice(base.length);
      return url;
    },
  });

  await app.register(fastifyCookie);
  // Campaign images (background/cover/logo) are uploaded here. One small file per request; the
  // 5 MiB cap is generous for a wallpaper but bounded. Registered separately from the 1 MiB JSON
  // body limit above.
  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 } });

  // Uploaded images live in the data volume and are served read-only at /uploads/*.
  const uploadsDir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  await app.register(fastifyStatic, { root: uploadsDir, prefix: '/uploads/', decorateReply: false, index: false });

  // ── Gently upgrade insecure browser hits to HTTPS ────────────────────────────
  // The platform terminates TLS and serves us over HTTPS on a dedicated port (setting
  // x-forwarded-proto=https), but it doesn't tell the container that port. So we LEARN our
  // external HTTPS host from proxied secure requests, then 308-redirect insecure browser
  // navigations there — only to the SAME hostname (never an attacker-supplied one), and
  // never for API/health/download calls. Stripe's card field also needs a secure context.
  let lastHttpsHost = '';
  const hostOnly = (h: string) => h.split(':')[0].toLowerCase();
  app.addHook('onRequest', async (req, reply) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? '');
    const fwdHost = String(req.headers['x-forwarded-host'] ?? '');
    if (proto === 'https') {
      if (/^[a-z0-9.-]+(:\d+)?$/i.test(fwdHost)) lastHttpsHost = fwdHost;
      return; // already secure
    }
    if (req.method !== 'GET' || !lastHttpsHost) return;
    const reqHost = String(req.headers.host ?? '');
    if (reqHost && hostOnly(reqHost) !== hostOnly(lastHttpsHost)) return; // never cross-host
    const url = req.raw.url ?? '/';
    if (url.startsWith('/api') || url.startsWith('/healthz') || url.startsWith('/download')) return;
    return reply.redirect(`https://${lastHttpsHost}${url}`, 308);
  });

  // ── Keep everything but the kiosk surface LAN-only, even when remote adoption exposes us ──
  // A request that arrived over the OS Cloudflare tunnel carries the base-path prefix (flagged as
  // omosViaTunnel in rewriteUrl). Over the tunnel we ALLOWLIST (fail-closed) only the public kiosk
  // surface: the device API (/api/kiosk/*), the public bootstrap (/api/app), the live appearance
  // relay (/api/public/*), plus non-/api paths (the SPA + static assets, the APK at /download, and
  // uploaded images at /uploads — the setup page needs them). Every OTHER /api route — admin, login,
  // session, setup, logout, and /api/fabric — stays LAN-only, so the admin panel and its auth are
  // never reachable from the internet even when a remote kiosk is adopted.
  app.addHook('onRequest', async (req, reply) => {
    if ((req.raw as unknown as { omosViaTunnel?: boolean }).omosViaTunnel !== true) return;
    const p = (req.raw.url ?? '/').split('?')[0];
    if (p.startsWith('/api/') && !(p === '/api/app' || p.startsWith('/api/public/') || p.startsWith('/api/kiosk/'))) {
      return reply.code(404).send({ error: 'Not found.' });
    }
  });

  /** A request is authenticated if it carries a valid local session cookie — minted by
   *  first-run setup, password login, or a confirmed OpenMasjidOS SSO check. */
  const isAuthed = (cookie: string | undefined): boolean => verifyToken(store.secret, cookie, 'admin');
  const requireAdmin = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!isAuthed(req.cookies[COOKIE])) return reply.code(401).send({ error: 'Please sign in.' });
  };

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

  // ── Public bootstrap the web app reads on load (no secrets) ─────────────────
  app.get('/api/app', async () => ({
    data: {
      name: 'OpenMasjid Kiosk',
      version: config.version,
      embedded: ssoConfigured(),
      // Whether the platform's base URL actually reached this container. If this is false while
      // running under OpenMasjidOS, the `environment:` block in docker-compose.yml didn't pass
      // OPENMASJID_BASE_URL through — and appearance/SSO/notifications all silently no-op.
      fabricReachable: !!config.omosBaseUrl,
      apkAvailable: fs.existsSync(config.apkPath),
      apkDownloadPath: '/download/openmasjidkiosk.apk',
      apkFilename,
    },
  }));

  // ── Same-origin appearance relay ────────────────────────────────────────────
  // Our page is served over HTTPS (platform's per-app TLS proxy, because manifest sets
  // `https: true`). The platform's appearance endpoint is plain HTTP, so a direct browser
  // fetch would be mixed-content blocked. The web polls us (same origin) and we fetch the
  // platform server-to-server, returning it VERBATIM (theme, wallpaper, wallpaperImage,
  // accent, lang) or {} (no secrets) — exactly like OpenMasjid Donations/Display. The admin
  // types a full image URL in OpenMasjidOS, so the browser renders wallpaperImage directly;
  // we do NOT proxy the image bytes (no SSRF surface, matches the other apps).
  app.get('/api/public/appearance', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return await fetchAppearance();
  });

  // ── Session: who am I? Also performs the SSO upgrade. ───────────────────────
  app.get('/api/session', async (req, reply) => {
    let authed = isAuthed(req.cookies[COOKIE]);
    let username: string | undefined;
    // True unless we tried to reach the platform and couldn't — lets the UI tell "open it
    // from the dashboard" apart from "OpenMasjidOS is unreachable".
    let reachable = true;
    if (!authed && ssoConfigured()) {
      const probe = await probePlatform(req.headers.cookie);
      reachable = probe.reachable;
      if (probe.username) {
        reply.setCookie(COOKIE, makeToken(store.secret, SSO_SESSION_MS), cookieOptions(SSO_SESSION_MS));
        authed = true;
        username = probe.username;
      }
    }
    return {
      data: {
        // Standalone first run creates a password. Under OpenMasjidOS, signing in is the
        // dashboard's job (SSO) — but a local password is ALWAYS available as recovery, so
        // the panel can never brick.
        needsSetup: !store.hasAdmin() && !ssoConfigured(),
        authed,
        hasPassword: store.hasAdmin(),
        sso: { enabled: ssoConfigured(), reachable, username },
      },
    };
  });

  // ── First-run setup / local-password recovery ───────────────────────────────
  const SetupBody = z.object({ password: z.string().min(8).max(200), name: z.string().max(80).optional() });
  app.post('/api/setup', async (req, reply) => {
    if (store.hasAdmin()) return reply.code(409).send({ error: 'This app is already set up.' });
    // Allow the local password when SSO isn't configured (standalone) OR the platform is
    // currently unreachable (a restore onto a new box, the OS briefly down) — so the panel
    // can never brick. But when the platform IS reachable, refuse: the admin should sign in
    // through the dashboard, and refusing closes the pre-setup window where a passer-by on
    // the LAN could otherwise claim the admin password first.
    if (ssoConfigured() && (await probePlatform(req.headers.cookie)).reachable) {
      return reply.code(403).send({ error: 'Sign in through your OpenMasjidOS dashboard — press Open on the Kiosk app.' });
    }
    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose a password of at least 8 characters.' });
    store.setAdmin(hashPassword(parsed.data.password), parsed.data.name?.trim());
    reply.setCookie(COOKIE, makeToken(store.secret), cookieOptions());
    return { data: { ok: true } };
  });

  // ── Password login (rate-limited) ───────────────────────────────────────────
  const LoginBody = z.object({ password: z.string().min(1).max(200) });
  app.post('/api/login', async (req, reply) => {
    // Key the brute-force limiter on the real, unspoofable TCP peer — never req.ip.
    const peer = req.socket.remoteAddress ?? 'unknown';
    const wait = loginLimiter.retryAfterMs(peer);
    if (wait > 0) return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
    const admin = store.getAdmin();
    if (!admin) return reply.code(400).send({ error: 'This app hasn’t been set up yet.' });
    const parsed = LoginBody.safeParse(req.body);
    if (parsed.success && verifyPassword(parsed.data.password, admin)) {
      loginLimiter.succeed(peer);
      reply.setCookie(COOKIE, makeToken(store.secret), cookieOptions());
      return { data: { ok: true } };
    }
    loginLimiter.fail(peer);
    return reply.code(401).send({ error: 'Incorrect password.' });
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { data: { ok: true } };
  });

  // ── Fabric notifications: diagnose + send a test alert ──────────────────────
  app.post('/api/admin/notify-test', { preHandler: requireAdmin }, async () => {
    const base = config.omosBaseUrl;
    const hasSecret = !!config.omosAppSecret;
    let result: { delivered: boolean; reason?: string } = { delivered: false, reason: 'no-fabric' };
    if (base && hasSecret) {
      result = await notify({
        title: 'OpenMasjid Kiosk — test',
        text: '✅ Test alert from OpenMasjid Kiosk. If you see this, donation alerts will reach you here.',
        level: 'info',
      });
    }
    return {
      data: { baseUrlSet: !!base, hasSecret, baseUrlLoopback: LOOPBACK_RE.test(base), appId: config.omosAppId, ...result },
    };
  });

  // ── Payments (Stripe via the Fabric, with a standalone key fallback) ─────────
  // Resolve the effective Stripe account: the OpenMasjidOS-vaulted Fabric account when it's
  // actually configured (real pk+sk), else the locally-entered keys. The secret key stays in
  // memory only — never sent to the browser/tablet, never persisted.
  const resolveAccount = async (): Promise<{ keys: StripeKeys; source: 'fabric' | 'local'; id: string; label: string } | null> => {
    if (ssoConfigured()) {
      const choice = store.getFabricStripeChoice();
      const fab = await fetchFabricStripe(choice);
      if (fab && stripeConfigured(fab)) {
        return { keys: { publishableKey: fab.publishableKey, secretKey: fab.secretKey }, source: 'fabric', id: fab.id, label: fab.label };
      }
      // A vault account was explicitly chosen but can't be resolved right now (renamed/removed, or the
      // platform is briefly unreachable). FAIL CLOSED — never silently fall back to leftover standalone
      // keys while embedded, or donations would route to the wrong Stripe account. (Callers surface a
      // friendly "Payments aren't set up" message on null.) The local fallback is only for a genuinely
      // standalone install, or an embedded one where no account has been chosen yet.
      if (choice) return null;
    }
    const local = store.getLocalStripe();
    if (stripeConfigured(local)) return { keys: local, source: 'local', id: 'local', label: 'Locally-entered keys' };
    return null;
  };

  type ResolvedAccount = { keys: StripeKeys; source: 'fabric' | 'local'; id: string; label: string };
  /** Resolve a SPECIFIC Stripe account (a campaign's chosen account). '' = the primary account
   *  (resolveAccount). 'local' = the standalone-entered keys. Otherwise a Fabric-vaulted account id.
   *  Fails closed (null) if a specific account is requested but can't be resolved — we never silently
   *  route money to the wrong account. The secret key stays in memory only. */
  const resolveAccountById = async (accountId: string): Promise<ResolvedAccount | null> => {
    const id = (accountId || '').trim();
    if (!id) return resolveAccount();
    if (id === 'local') {
      const local = store.getLocalStripe();
      return stripeConfigured(local) ? { keys: local, source: 'local', id: 'local', label: 'Locally-entered keys' } : null;
    }
    if (ssoConfigured()) {
      const fab = await fetchFabricStripe(id);
      if (fab && stripeConfigured(fab)) return { keys: { publishableKey: fab.publishableKey, secretKey: fab.secretKey }, source: 'fabric', id: fab.id, label: fab.label };
    }
    return null;
  };

  /** Non-secret Payments status for the admin screen (publishable keys + booleans only). */
  const paymentsStatus = async () => {
    const embedded = ssoConfigured();
    const accounts = embedded ? await fetchFabricStripeAccounts() : [];
    const chosenId = store.getFabricStripeChoice();
    const chosen = embedded ? await fetchFabricStripe(chosenId) : null;
    const resolved = await resolveAccount();
    return {
      embedded,
      fabric: { available: accounts.length > 0, accounts, chosenId, status: chosen ? publicStripeStatus(chosen) : null },
      local: publicStripeStatus(store.getLocalStripe()),
      resolved: resolved ? { source: resolved.source, label: resolved.label, ...publicStripeStatus(resolved.keys) } : null,
      currency: store.getCurrency(),
      location: store.getLocation(),
      masjid: store.getMasjid(),
      testMode: resolved ? stripeMode(resolved.keys) === 'test' : false,
    };
  };

  app.get('/api/admin/payments', { preHandler: requireAdmin }, async () => ({ data: await paymentsStatus() }));

  // Pick which OpenMasjidOS-vault account to use (in-app picker; keeps install one-click).
  app.put('/api/admin/payments/account', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ accountId: z.string().max(120) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose an account.' });
    store.setFabricStripeChoice(parsed.data.accountId.trim());
    clearFabricStripeCache(); // apply immediately — next fetch re-reads the OS vault
    return { data: await paymentsStatus() };
  });

  // Standalone fallback: manually-entered keys (used only when the Fabric is absent).
  app.put('/api/admin/payments/local', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ publishableKey: z.string().max(255).optional(), secretKey: z.string().max(255).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the keys.' });
    const p = parsed.data;
    if (p.publishableKey && !looksLikePublishable(p.publishableKey)) return reply.code(400).send({ error: 'The publishable key should start with pk_.' });
    if (p.secretKey && !looksLikeSecret(p.secretKey)) return reply.code(400).send({ error: 'The secret key should start with sk_.' });
    store.setLocalStripe(p);
    const verify = p.secretKey ? await verifySecretKey(p.secretKey) : undefined;
    return { data: { ...(await paymentsStatus()), verify } };
  });

  app.put('/api/admin/payments/currency', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ currency: z.string().min(3).max(8) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose a currency.' });
    store.setCurrency(parsed.data.currency);
    return { data: await paymentsStatus() };
  });

  // Masjid name + address — used to name/address the Terminal Location (platform injects none).
  const AddressBody = z.object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(120).optional(),
    state: z.string().max(120).optional(),
    postalCode: z.string().max(40).optional(),
    country: z.string().max(2).optional(),
  });
  app.put('/api/admin/masjid', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ name: z.string().max(160).optional(), address: AddressBody.optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details.' });
    return { data: store.setMasjid(parsed.data) };
  });

  // ── Terminal Locations (a reader must connect with a locationId) ─────────────
  app.get('/api/admin/payments/locations', { preHandler: requireAdmin }, async (_req, reply) => {
    const acct = await resolveAccount();
    if (!acct) return reply.code(400).send({ error: 'Choose or enter a Stripe account first.' });
    try {
      return { data: { locations: await listLocations(acct.keys.secretKey) } };
    } catch {
      return reply.code(502).send({ error: 'Couldn’t reach Stripe to list locations. Please try again.' });
    }
  });

  app.post('/api/admin/payments/location', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ displayName: z.string().max(160).optional(), address: AddressBody }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please add the masjid address.' });
    const a = parsed.data.address;
    if (!a.line1 || !a.country) return reply.code(400).send({ error: 'A street address and 2-letter country code are required.' });
    const acct = await resolveAccount();
    if (!acct) return reply.code(400).send({ error: 'Choose or enter a Stripe account first.' });
    const displayName = (parsed.data.displayName || store.getMasjid().name || 'Masjid kiosk').slice(0, 160);
    try {
      const loc = await createLocation(acct.keys.secretKey, displayName, {
        line1: a.line1, line2: a.line2, city: a.city, state: a.state, postalCode: a.postalCode, country: a.country,
      });
      store.setLocation({ id: loc.id, name: loc.displayName });
      return { data: { location: loc } };
    } catch (e) {
      log.warn('create location failed: ' + (e instanceof Error ? e.message : String(e)));
      return reply.code(502).send({ error: 'Stripe couldn’t create that location. Check the address (country must be a 2-letter code).' });
    }
  });

  app.put('/api/admin/payments/location', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ id: z.string().max(120) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose a location.' });
    const acct = await resolveAccount();
    if (!acct) return reply.code(400).send({ error: 'Choose or enter a Stripe account first.' });
    const loc = await retrieveLocation(acct.keys.secretKey, parsed.data.id);
    if (!loc) return reply.code(404).send({ error: 'That location no longer exists on this Stripe account.' });
    store.setLocation({ id: loc.id, name: loc.displayName });
    return { data: { location: loc } };
  });

  // Verify Stripe + Terminal end-to-end by minting a connection token (the same short-lived
  // credential the tablet gets). The token itself is never returned to the browser.
  app.post('/api/admin/payments/test', { preHandler: requireAdmin }, async () => {
    const acct = await resolveAccount();
    if (!acct) return { data: { ok: false, message: 'No Stripe account is set up yet.' } };
    try {
      await createConnectionToken(acct.keys.secretKey, store.getLocation()?.id);
      return { data: { ok: true, mode: stripeMode(acct.keys), source: acct.source } };
    } catch (e) {
      const err = e as { type?: string };
      const message =
        err.type === 'StripeAuthenticationError'
          ? 'Stripe didn’t accept the secret key.'
          : 'Couldn’t reach Stripe Terminal. Check the account and your connection.';
      return { data: { ok: false, message } };
    }
  });

  // ── Devices: pairing, fleet management, kiosk PIN ───────────────────────────
  const pairLimiter = new LoginLimiter(); // brute-force guard for 6-digit pairing codes
  const tuitionLookupLimiter = new LoginLimiter(); // brute-force guard for tuition name+PIN lookups

  // Kiosks heartbeat every ~10s; treat one as offline after ~3 missed beats (+ a little slack for
  // jitter) so a fallen/unplugged tablet shows offline in the admin panel within ~35s, not minutes.
  const ONLINE_MS = 35_000;
  const deviceView = (d: Device) => ({
    ...d,
    online: !!d.lastSeen && Date.now() - Date.parse(d.lastSeen) < ONLINE_MS,
  });

  // Admin: list the fleet.
  app.get('/api/admin/devices', { preHandler: requireAdmin }, async () => ({ data: { devices: store.listDevices().map(deviceView) } }));

  // Admin: mint a single-use 6-digit pairing code (TTL 10 min) to type into a tablet.
  app.post('/api/admin/devices/pair-code', { preHandler: requireAdmin }, async () => ({ data: store.createPairingCode(makePairingCode()) }));

  // Admin: remote-adoption status + toggle (for pairing a tablet at ANOTHER site over the OS
  // Cloudflare tunnel). `available` = the platform has Remote access on and is exposing us, so a
  // remote tablet can reach `publicUrl`. `allowAdoption` is our own opt-in gate (off by default);
  // remote pairing is refused unless BOTH are true. publicUrl is the address a remote tablet types.
  app.get('/api/admin/remote', { preHandler: requireAdmin }, async () => {
    const site = await fetchFabricSite();
    return {
      data: {
        available: site.enabled && !!site.publicUrl,
        publicUrl: site.publicUrl,
        basePath: site.basePath,
        allowAdoption: store.getRemoteAdoption(),
      },
    };
  });
  app.put('/api/admin/remote', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ allowAdoption: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please try again.' });
    store.setRemoteAdoption(parsed.data.allowAdoption);
    return { data: { allowAdoption: store.getRemoteAdoption() } };
  });

  app.put('/api/admin/devices/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().max(80).optional(),
        // A UI rotation in degrees ('0'/'90'/'180'/'270'); legacy named values are normalised in the store.
        orientation: z.string().max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success || (parsed.data.name === undefined && parsed.data.orientation === undefined)) {
      return reply.code(400).send({ error: 'Please enter a name or orientation.' });
    }
    const id = (req.params as { id: string }).id;
    let d = store.getDevice(id);
    if (!d) return reply.code(404).send({ error: 'Kiosk not found.' });
    if (parsed.data.name !== undefined) d = store.renameDevice(id, parsed.data.name.trim()) ?? d;
    if (parsed.data.orientation !== undefined) d = store.setDeviceOrientation(id, parsed.data.orientation) ?? d;
    return { data: deviceView(d) };
  });

  app.delete('/api/admin/devices/:id', { preHandler: requireAdmin }, async (req) => {
    store.revokeDevice((req.params as { id: string }).id);
    return { data: { ok: true } };
  });

  app.post('/api/admin/devices/:id/identify', { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getDevice(id)) return reply.code(404).send({ error: 'Kiosk not found.' });
    store.setIdentify(id);
    return { data: { ok: true } };
  });

  // (Removed the remote "push update" endpoint: a kiosk is the HOME launcher, so it can't be made to
  //  open a browser remotely in a reliable way. Updating is done AT the tablet — 7-tap → PIN →
  //  "Update app" — which ends kiosk mode and opens the APK link. The admin panel just explains that.)


  app.get('/api/admin/devices/:id/logs', { preHandler: requireAdmin }, async (req) => ({
    data: { logs: store.listLogs((req.params as { id: string }).id) },
  }));

  // Admin: set/clear the kiosk exit PIN (4–8 digits). Stored as a scrypt hash + synced to
  // kiosks in the config; the tablet verifies it OFFLINE. Bumps the config version.
  app.put('/api/admin/pin', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ pin: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter a PIN.' });
    const pin = parsed.data.pin.trim();
    if (pin === '') {
      store.setPinHash('');
      return { data: { set: false } };
    }
    if (!/^\d{4,8}$/.test(pin)) return reply.code(400).send({ error: 'The PIN must be 4 to 8 digits.' });
    store.setPinHash(hashPin(pin));
    return { data: { set: true } };
  });

  // ── Giving-screen designer (amounts/messages the kiosk shows) ────────────────
  // Everything here is pushed live: setGiving/setAttractTitle bump the config version, so paired
  // kiosks pick it up on their next heartbeat and re-render. Amounts are integer minor units.
  app.get('/api/admin/giving', { preHandler: requireAdmin }, async () => ({
    data: { giving: store.getGiving(), currency: store.getCurrency(), masjidName: store.getMasjid().name, attractTitle: store.getAttractTitle() },
  }));

  const GivingBody = z
    .object({
      presetsMinor: z.array(z.number().int().positive()).max(12).optional(),
      allowCustom: z.boolean().optional(),
      customMinMinor: z.number().int().positive().optional(),
      customMaxMinor: z.number().int().positive().optional(),
      monthlyEnabled: z.boolean().optional(),
      manualEntryEnabled: z.boolean().optional(),
      namePolicy: z.enum(['off', 'optional', 'required']).optional(),
      emailPolicy: z.enum(['off', 'optional', 'required']).optional(),
      thankYouMessage: z.string().max(500).optional(),
      maxBrightness: z.boolean().optional(),
      footerText: z.string().max(80).optional(),
      largeAmountThresholdMinor: z.number().int().min(0).optional(),
      largeAmountNote: z.string().max(600).optional(),
      largeAmountImage: z.string().max(500).optional(),
      celebrateEnabled: z.boolean().optional(),
      celebrateThresholdMinor: z.number().int().min(0).optional(),
      attractTitle: z.string().max(120).optional(),
      masjidName: z.string().max(160).optional(),
    })
    .strict();

  app.put('/api/admin/giving', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = GivingBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the giving-screen settings.' });
    const { attractTitle, masjidName, ...giving } = parsed.data;
    store.setGiving(giving); // sanitises (≤6 presets, sane bounds, known policies) + bumps configVersion
    if (attractTitle !== undefined) store.setAttractTitle(attractTitle.trim());
    if (masjidName !== undefined) {
      store.setMasjid({ name: masjidName.trim() });
      store.bumpConfigVersion(); // masjidName is in the kiosk config but setMasjid doesn't bump
    }
    return { data: { giving: store.getGiving(), currency: store.getCurrency(), masjidName: store.getMasjid().name, attractTitle: store.getAttractTitle() } };
  });

  // ── Campaigns (giving appeals shown as kiosk tabs) ───────────────────────────
  // Each campaign has its own amounts, colour, background, thank-you, monthly/cover-fees, and
  // (optionally) its own Stripe account. Changes bump the config version → kiosks pick them up
  // on the next heartbeat. Amounts are integer MINOR units (same as the giving API).
  const CampaignBody = z
    .object({
      title: z.string().max(120).optional(),
      type: z.enum(['donation', 'zakat', 'tuition']).optional(),
      description: z.string().max(1000).optional(),
      deviceIds: z.array(z.string().max(60)).max(200).optional(),
      primaryColor: z.string().max(9).optional(),
      accentColor: z.string().max(9).optional(),
      backgroundImage: z.string().max(500).optional(),
      coverImage: z.string().max(500).optional(),
      logo: z.string().max(500).optional(),
      presetsMinor: z.array(z.number().int().positive()).max(12).optional(),
      allowCustom: z.boolean().optional(),
      customMinMinor: z.number().int().positive().optional(),
      customMaxMinor: z.number().int().positive().optional(),
      monthlyEnabled: z.boolean().optional(),
      coverFees: z.boolean().optional(),
      forceCoverFees: z.boolean().optional(),
      thankYouMessage: z.string().max(500).optional(),
      theme: z.enum(['auto', 'light', 'dark']).optional(),
      stripeAccountId: z.string().max(120).optional(),
      live: z.boolean().optional(),
    })
    .strict();

  // The Stripe accounts a campaign can settle to (for the per-campaign picker), plus which one is
  // the primary (reader) account — a campaign on a different account is taken by keyed entry.
  const campaignAccounts = async () => {
    const embedded = ssoConfigured();
    const accounts = embedded ? await fetchFabricStripeAccounts() : [];
    const primary = await resolveAccount();
    return { accounts, primaryAccountId: primary?.id ?? '', hasLocal: stripeConfigured(store.getLocalStripe()) };
  };

  app.get('/api/admin/campaigns', { preHandler: requireAdmin }, async () => ({
    data: {
      campaigns: store.listCampaigns(),
      currency: store.getCurrency(),
      // The kiosk-wide bottom tagline, so the campaign preview can mirror what the tablet shows.
      footerText: store.getGiving().footerText,
      // The paired kiosks a campaign can be targeted at (for the "show on which kiosk" picker).
      devices: store.listDevices().map((d) => ({ id: d.id, name: d.name })),
      ...(await campaignAccounts()),
    },
  }));

  app.post('/api/admin/campaigns', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CampaignBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the campaign settings.' });
    if (!parsed.data.title || !parsed.data.title.trim()) return reply.code(400).send({ error: 'Please give the campaign a title.' });
    return { data: { campaign: store.createCampaign(parsed.data) } };
  });

  app.put('/api/admin/campaigns/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CampaignBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the campaign settings.' });
    const c = store.updateCampaign((req.params as { id: string }).id, parsed.data);
    if (!c) return reply.code(404).send({ error: 'Campaign not found.' });
    return { data: { campaign: c } };
  });

  app.delete('/api/admin/campaigns/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const ok = store.deleteCampaign((req.params as { id: string }).id);
    if (!ok) return reply.code(400).send({ error: 'The main campaign can’t be deleted. Make another campaign the main one first.' });
    return { data: { ok: true } };
  });

  app.post('/api/admin/campaigns/reorder', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ ids: z.array(z.string().max(120)).max(50) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please provide the campaign order.' });
    store.reorderCampaigns(parsed.data.ids);
    return { data: { campaigns: store.listCampaigns() } };
  });

  app.post('/api/admin/campaigns/:id/main', { preHandler: requireAdmin }, async (req, reply) => {
    const ok = store.setMainCampaign((req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: 'Campaign not found.' });
    return { data: { campaigns: store.listCampaigns() } };
  });

  // Upload a campaign image (background / cover / logo). Admin-only. PNG/JPG/WEBP/GIF, ≤5 MiB —
  // NO SVG (script-injection surface). The file gets a random name (no traversal) and is served
  // read-only from /uploads/*. Returns its URL for the campaign field.
  const IMG_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  app.post('/api/admin/upload', { preHandler: requireAdmin }, async (req, reply) => {
    let data: Awaited<ReturnType<typeof req.file>>;
    try {
      data = await req.file();
    } catch {
      return reply.code(413).send({ error: 'That image is too large (max 5 MB).' });
    }
    if (!data) return reply.code(400).send({ error: 'Please choose an image file.' });
    const ext = IMG_EXT[data.mimetype];
    if (!ext) {
      data.file.resume(); // drain so the connection doesn't hang
      return reply.code(400).send({ error: 'Please upload a PNG, JPG, WEBP or GIF image.' });
    }
    const name = `img_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const dest = path.join(uploadsDir, name);
    try {
      await pipeline(data.file, fs.createWriteStream(dest));
    } catch {
      fs.rm(dest, { force: true }, () => {});
      return reply.code(413).send({ error: 'That image is too large (max 5 MB).' });
    }
    if (data.file.truncated) {
      fs.rm(dest, { force: true }, () => {});
      return reply.code(413).send({ error: 'That image is too large (max 5 MB).' });
    }
    return { data: { url: `/uploads/${name}` } };
  });

  // ── Donations log, totals + CSV export ──────────────────────────────────────
  // Donations are recorded ONLY after the server verified the PaymentIntent with Stripe, so the log
  // reflects real money. Totals count succeeded donations only. Renewals of monthly subscriptions
  // are charged by Stripe and NOT tracked here (LAN-only, no webhooks) — see them in the Stripe
  // dashboard; these totals are what the kiosks collected directly.
  // The log shows the newest 2000 for a snappy page; TOTALS are computed in SQL over the whole table
  // (store.donationTotals), so they never undercount even with a long history.
  app.get('/api/admin/donations', { preHandler: requireAdmin }, async () => {
    return { data: { donations: store.listDonations(), totals: store.donationTotals(), currency: store.getCurrency() } };
  });

  // CSV export — behind admin auth (it exposes donor PII). Every cell is escaped against CSV formula
  // injection (donor name/email are attacker-controllable). Amounts are in major units for humans.
  // Exports the FULL history (limit -1 = no SQLite limit), not just the on-screen page.
  app.get('/api/admin/donations.csv', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows: string[][] = [['Date', 'Amount', 'Currency', 'Type', 'Campaign', 'Status', 'Donor name', 'Donor email', 'Kiosk', 'PaymentIntent']];
    for (const d of store.listDonations(-1)) {
      rows.push([
        d.createdAt,
        String(toMajor(d.amountMinor, d.currency)),
        d.currency,
        d.kind === 'monthly' ? 'Monthly' : 'One-time',
        d.campaignTitle,
        d.status,
        d.donorName,
        d.donorEmail,
        d.deviceName || '',
        d.paymentIntentId,
      ]);
    }
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="donations.csv"')
      .header('cache-control', 'no-store');
    return toCsv(rows);
  });

  // ── Kiosk (device-token) routes ─────────────────────────────────────────────
  /** The device for the request's token, INCLUDING a revoked one (or null if the token is
   *  malformed/unknown). Callers decide how to treat `.revoked`. */
  const resolveDevice = (req: import('fastify').FastifyRequest): Device | null => {
    const bearer = typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '';
    const raw = (req.headers['x-device-token'] as string | undefined) || bearer || '';
    if (!/^[a-f0-9]{64}$/i.test(raw)) return null;
    return store.getDeviceByTokenHash(store.hashDeviceToken(raw));
  };

  /** Require a live (non-revoked) device; 401 otherwise. Used by config/logs/connection-token
   *  (heartbeat handles revoked specially, returning `revoked:true` so the tablet re-pairs). */
  const authDevice = (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): Device | null => {
    const d = resolveDevice(req);
    if (!d || d.revoked) {
      reply.code(401).send({ error: 'This kiosk isn’t paired.' });
      return null;
    }
    return d;
  };

  // Pair a tablet with a single-use 6-digit code (typed by the volunteer). Rate-limited on
  // the real TCP peer so the 1e6 code space can't be brute-forced.
  const PairBody = z.object({ code: z.string().max(12), name: z.string().max(80).optional(), platform: z.string().max(40).optional() });
  app.post('/api/kiosk/pair', async (req, reply) => {
    const peer = req.socket.remoteAddress ?? 'unknown';
    const wait = pairLimiter.retryAfterMs(peer);
    if (wait > 0) return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
    // Remote (over-the-tunnel) pairing is opt-in: refuse it unless the admin turned on "Allow
    // remote adoption". LAN pairing (no tunnel prefix, so omosViaTunnel is unset) is always allowed.
    if ((req.raw as unknown as { omosViaTunnel?: boolean }).omosViaTunnel === true && !store.getRemoteAdoption()) {
      return reply.code(403).send({ error: 'Remote adoption is turned off for this kiosk. Ask the masjid admin to enable it in the kiosk’s admin panel.' });
    }
    const parsed = PairBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the 6-digit pairing code from Admin → Devices.' });
    const code = parsed.data.code.trim();
    if (!store.consumePairingCode(code)) {
      pairLimiter.fail(peer);
      return reply.code(400).send({ error: 'That pairing code is invalid or has expired. Generate a fresh one in Admin → Devices.' });
    }
    pairLimiter.succeed(peer);
    const token = makeDeviceToken();
    const device = store.createDevice({ name: parsed.data.name?.trim() || 'Kiosk', platform: parsed.data.platform?.trim() || '', tokenHash: store.hashDeviceToken(token) });
    store.addLogs(device.id, [{ level: 'info', event: 'paired', detail: `platform=${device.platform}` }]);
    log.info(`kiosk paired: ${device.id}`);
    return { data: { deviceToken: token, deviceId: device.id, configVersion: store.getConfigVersion() } };
  });

  const HeartbeatBody = z.object({
    battery: z.number().min(0).max(100).optional(),
    charging: z.boolean().optional(),
    readerStatus: z.string().max(40).optional(),
    readerSerial: z.string().max(80).optional(),
    readerBattery: z.number().min(0).max(100).optional(),
    appVersion: z.string().max(40).optional(),
    configVersion: z.number().int().optional(),
    // The live on-screen loop sends foreground:true; the WorkManager backstop sends false. Only a
    // foreground heartbeat can act on the one-shot "open update" flag, so only it consumes it — the
    // backstop must not, or an admin's Update could be silently eaten by a background check-in.
    foreground: z.boolean().optional(),
  });
  app.post('/api/kiosk/heartbeat', async (req, reply) => {
    const d = resolveDevice(req);
    if (!d) return reply.code(401).send({ error: 'This kiosk isn’t paired.' });
    // A revoked device gets a clean signal (not a 401) so the tablet wipes + re-pairs.
    if (d.revoked) return { data: { configVersion: store.getConfigVersion(), identify: false, latestAppVersion: config.version, revoked: true } };
    const parsed = HeartbeatBody.safeParse(req.body ?? {});
    if (parsed.success) store.updateHeartbeat(d.id, parsed.data);
    return {
      data: {
        configVersion: store.getConfigVersion(),
        identify: store.consumeIdentify(d.id),
        latestAppVersion: config.version, // the APK version bundled in this server image (info only)
        revoked: false,
      },
    };
  });

  app.get('/api/kiosk/config', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    // Resolve the primary (reader) account once: its id decides which campaigns are reader-capable,
    // and its publishable key lets the tablet initialise Stripe's PaymentSheet EARLY (the keyed-entry
    // card form fails if PaymentConfiguration isn't set up first). The publishable key is public/safe;
    // a cross-account campaign's keyed PI returns its own key and the tablet re-inits just-in-time.
    const acct = await resolveAccount();
    const cfg = store.getKioskConfig(acct?.id ?? '', d.id); // device-aware: orientation + targeted campaigns
    if (acct?.keys.publishableKey) (cfg.config as Record<string, unknown>).publishableKey = acct.keys.publishableKey;
    return { data: cfg };
  });

  const LogsBody = z.object({
    entries: z.array(z.object({ level: z.string().optional(), event: z.string().optional(), detail: z.string().optional(), ts: z.number().optional() })).max(200),
  });
  app.post('/api/kiosk/logs', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const parsed = LogsBody.safeParse(req.body);
    if (parsed.success) store.addLogs(d.id, parsed.data.entries);
    return { data: { ok: true } };
  });

  // The tablet's ConnectionTokenProvider calls this — the only Stripe credential the tablet
  // ever gets (short-lived). Minted server-side from the resolved account + Location.
  app.post('/api/kiosk/connection-token', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const acct = await resolveAccount();
    if (!acct) return reply.code(400).send({ error: 'Payments aren’t set up yet.' });
    try {
      const secret = await createConnectionToken(acct.keys.secretKey, store.getLocation()?.id);
      return { data: { secret } };
    } catch {
      return reply.code(502).send({ error: 'Couldn’t reach Stripe Terminal. Please try again.' });
    }
  });

  // ── One-time donations (Terminal card-present) ───────────────────────────────
  // Format an amount for the donation alert (best-effort; falls back to "<major> <CUR>").
  const formatMoney = (minor: number, currency: string): string => {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency }).format(toMajor(minor, currency));
    } catch {
      return `${toMajor(minor, currency)} ${currency}`;
    }
  };

  const PaymentIntentBody = z.object({
    amountMinor: z.number().int().positive(),
    // Which campaign (appeal) this donation is for. Omitted/invalid → the main campaign.
    campaignId: z.string().max(120).optional(),
    donorName: z.string().trim().max(120).optional(),
    donorEmail: z.string().trim().max(200).optional(),
    // Recurring monthly donation (sets up a Subscription from the card-present charge).
    monthly: z.boolean().optional(),
    // Keyed/manual card entry (Stripe's on-device card form) instead of the reader.
    manual: z.boolean().optional(),
    // Donor opted to cover the estimated card fee (only honoured if the campaign allows it).
    coverFees: z.boolean().optional(),
    // Per-attempt key so a network retry can't create a second PI (Stripe idempotency).
    idempotencyKey: z.string().trim().min(8).max(255).optional(),
  });

  /** A light email sanity check for the monthly gate (Stripe validates for real on the receipt). */
  const looksLikeEmail = (e: string): boolean => e.length >= 3 && e.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

  // Create the PaymentIntent the reader will collect + confirm. The amount is validated
  // server-side against the configured presets/custom bounds — NEVER trust the tablet.
  app.post('/api/kiosk/payment-intents', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const parsed = PaymentIntentBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'That donation request wasn’t valid.' });
    const { amountMinor, donorName, idempotencyKey } = parsed.data;
    const donorEmail = (parsed.data.donorEmail ?? '').trim();
    const monthly = parsed.data.monthly === true;
    const manual = parsed.data.manual === true;
    // Resolve the campaign (fall back to the main campaign for an old tablet or an unknown id).
    const campaign = (parsed.data.campaignId ? store.getCampaign(parsed.data.campaignId) : null) ?? store.getMainCampaign();
    if (!campaign) return reply.code(400).send({ error: 'Giving isn’t set up yet.' });
    if (!campaign.live && !campaign.isMain) return reply.code(400).send({ error: 'That appeal isn’t available.' });
    // Amount is validated against THIS campaign's presets/custom bounds — never trust the tablet.
    if (!store.isAllowedAmountForCampaign(campaign, amountMinor)) return reply.code(400).send({ error: 'That amount isn’t available.' });
    // Resolve the campaign's Stripe account (its own, or the primary/reader account when unset).
    const acct = await resolveAccountById(campaign.stripeAccountId);
    if (!acct) return reply.code(400).send({ error: 'This appeal’s Stripe account isn’t available.' });
    const primary = await resolveAccount();
    const readerCapable = !campaign.stripeAccountId || (!!primary && campaign.stripeAccountId === primary.id);
    // The physical reader is locked to the primary account, so a cross-account campaign is keyed-only.
    if (!manual && !readerCapable) {
      return reply.code(400).send({ error: 'This appeal is taken by keyed card entry, not the reader.' });
    }
    // Monthly giving needs name + email and the card reader (the reusable card comes from a
    // card-present charge — it can't be set up from keyed entry or a cross-account campaign).
    if (monthly) {
      if (manual) return reply.code(400).send({ error: 'Monthly giving needs the card reader.' });
      if (!readerCapable) return reply.code(400).send({ error: 'Monthly giving needs the card reader.' });
      if (!campaign.monthlyEnabled) return reply.code(400).send({ error: 'Monthly giving isn’t available for this appeal.' });
      if (!donorName || !donorName.trim()) return reply.code(400).send({ error: 'Monthly giving needs a name.' });
      if (!looksLikeEmail(donorEmail)) return reply.code(400).send({ error: 'Monthly giving needs a valid email for the receipt.' });
    }
    const currency = store.getCurrency();
    // Cover-fees: forced on for a Zakat campaign (forceCoverFees), otherwise only when the campaign
    // offers it AND the donor opted in. The masjid nets ≈ the base; the donor pays the grossed-up
    // total. Computed server-side (the tablet only displays it).
    const coverFees = campaign.forceCoverFees || (parsed.data.coverFees === true && campaign.coverFees);
    const chargeMinor = coverFees ? grossUpForFees(amountMinor) : amountMinor;
    const preset = campaign.presetsMinor.includes(amountMinor) ? 'preset' : 'custom';
    const metadata = {
      app: 'kiosk',
      deviceId: d.id,
      campaignId: campaign.id,
      campaign: campaign.title.slice(0, 120),
      kind: monthly ? 'monthly' : 'one_time',
      entry: manual ? 'manual' : 'reader',
      preset,
      coverFees: coverFees ? '1' : '0',
      baseMinor: String(amountMinor),
      stripeAccountId: acct.id, // so /complete uses the SAME account this PI was created on
      donorName: donorName ?? '',
      donorEmail,
    };
    const piInput = {
      amountMinor: chargeMinor,
      currency,
      description: `${monthly ? 'Monthly donation' : 'Donation'} — ${campaign.title || store.getMasjid().name || 'OpenMasjid Kiosk'}`,
      receiptEmail: donorEmail || undefined, // Stripe emails a receipt on success (if enabled)
      metadata,
    };
    try {
      // Manual = a keyed (card) PaymentIntent the tablet confirms via Stripe's on-device card form;
      // otherwise a card-present PaymentIntent the M2 reader collects. Both are verified server-side
      // in /complete before a donation is recorded. The tablet needs the publishable key for the
      // manual (Stripe SDK) form — it's public and safe to return.
      const pi = manual
        ? await createCardPaymentIntent(acct.keys.secretKey, piInput, idempotencyKey)
        : await createCardPresentPaymentIntent(acct.keys.secretKey, piInput, idempotencyKey);
      store.rememberPiAccount(pi.id, acct.id); // so /complete verifies with the same account
      return { data: { paymentIntentId: pi.id, clientSecret: pi.clientSecret, chargeMinor, coverFees, publishableKey: manual ? acct.keys.publishableKey : undefined } };
    } catch (err) {
      // Surface the REAL Stripe reason (e.g. `payment_method_unactivated` — online Cards not enabled
      // on the account) in Admin → Devices → Logs, not just the container log. Previously swallowed,
      // which is why keyed-entry failures were undiagnosable.
      const e = err as { code?: string; type?: string; message?: string };
      const why = `${e.code ?? e.type ?? ''} ${e.message ?? ''}`.trim().slice(0, 300);
      log.warn(`payment-intent create failed (${manual ? 'manual' : 'reader'}): ${why}`);
      store.addLogs(d.id, [{ level: 'warn', event: 'payment_create_failed', detail: `${manual ? 'manual' : 'reader'} · ${why}` }]);
      return reply.code(502).send({ error: 'Couldn’t start the payment. Please try again.' });
    }
  });

  // Finish a donation: the server retrieves the PI from Stripe, captures it if needed, and
  // records the donation ONLY if Stripe says it succeeded. The tablet's word is never enough.
  app.post('/api/kiosk/payment-intents/:id/complete', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const id = (req.params as { id: string }).id;
    if (!/^pi_[A-Za-z0-9_]+$/.test(id)) return reply.code(400).send({ error: 'That payment wasn’t valid.' });
    // Verify with the SAME account the PI was created on (a cross-account campaign settles elsewhere).
    // If the mapping was lost (a restart between create and complete), fall back to the primary account.
    const acct = await resolveAccountById(store.getPiAccount(id));
    if (!acct) return reply.code(400).send({ error: 'Payments aren’t set up yet.' });
    try {
      const result = await completeCardPresentPaymentIntent(acct.keys.secretKey, id);
      const meta = result.metadata;
      const wantsMonthly = meta.kind === 'monthly';
      // For a successful monthly donation, set up the recurring Subscription from the reusable
      // card Stripe derived from this card-present charge. The first month is THIS payment; the
      // Subscription's first automatic charge is a month out (never double-charged). If the card
      // can't be reused (generated_card absent), the one-time gift still stands — we just report
      // that monthly couldn't be arranged so the tablet can say so kindly.
      const campaignLabel = meta.campaign || store.getMasjid().name || 'OpenMasjid Kiosk';
      let monthly = { requested: wantsMonthly, created: false };
      if (result.succeeded && wantsMonthly && result.generatedCard) {
        try {
          const sub = await createMonthlySubscription(acct.keys.secretKey, {
            amountMinor: result.amountMinor,
            currency: result.currency,
            paymentMethod: result.generatedCard,
            name: meta.donorName || undefined,
            email: meta.donorEmail || undefined,
            productName: `Monthly donation — ${campaignLabel}`,
            deviceId: d.id,
            anchorSec: result.createdSec, // deterministic across retries (idempotency-safe)
            idempotencyKey: id,
          });
          monthly = { requested: true, created: sub.created };
        } catch (e) {
          log.warn('monthly subscription failed: ' + (e instanceof Error ? e.message : String(e)));
        }
      }
      store.recordDonation({
        paymentIntentId: id,
        deviceId: d.id,
        campaignId: meta.campaignId || '',
        campaignTitle: meta.campaign || '',
        amountMinor: result.amountMinor,
        currency: result.currency,
        kind: meta.kind || 'one_time',
        status: result.succeeded ? 'succeeded' : result.status,
        donorName: meta.donorName,
        donorEmail: meta.donorEmail,
        chargeId: result.chargeId,
      });
      if (result.succeeded) {
        const label = monthly.created ? 'monthly donation set up' : 'donation received';
        void notify({
          text: `${formatMoney(result.amountMinor, result.currency)} ${label} at ${d.name || 'the kiosk'}.`,
          level: 'success',
        });
      }
      return { data: { status: result.status, succeeded: result.succeeded, amountMinor: result.amountMinor, currency: result.currency, monthly } };
    } catch {
      return reply.code(502).send({ error: 'Couldn’t confirm the payment with Stripe.' });
    }
  });

  // ── Tuition (students/billing) — a `tuition` campaign shells out to OpenMasjid Students ─────
  // The parent taps the tuition tile, types their child's name + PIN, we verify + fetch the balance
  // from Students over the Fabric broker, they pay the full balance or pick invoices, the M2 reader
  // takes the card, and we record it into the Students ledger (never as a kiosk "donation"). The app
  // secret stays on the server; the PIN is inert input (body only, never logged/stored/in metadata);
  // amounts are computed server-side from a held session. Everything fails soft if Students is absent.

  /** Push a succeeded tuition charge to the Students ledger (idempotent on the PI id); update the
   *  outbox. `recorded` → done; `rejected` → give up (Students' daily reconciliation is the backstop);
   *  `unavailable` → leave pending for the outbox retry. Re-checks pay_status so we never record a
   *  charge that didn't succeed. */
  const tryRecordTuition = async (piId: string): Promise<void> => {
    const row = store.getTuitionOutbox(piId);
    if (!row || row.recordStatus !== 'pending' || row.payStatus !== 'succeeded') return;
    const res = await recordStudentPayment({
      idempotencyKey: piId,
      familyId: row.familyId,
      studentId: row.studentId || undefined,
      amountCents: row.amountMinor,
      currency: row.currency,
      occurredAt: row.occurredAt || new Date().toISOString(),
      externalRef: {
        stripePaymentIntentId: piId,
        stripeChargeId: row.chargeId || undefined,
        stripeAccountId: row.stripeAccountId || undefined,
      },
      allocations: row.allocations ?? undefined,
    });
    if (res.status === 'recorded') store.setTuitionRecordStatus(piId, 'recorded', res.paymentId);
    else if (res.status === 'rejected') store.setTuitionRecordStatus(piId, 'skipped');
    // 'unavailable' → leave pending; drainTuitionOutbox retries.
  };

  /** Drain the outbox: for each succeeded-but-unrecorded tuition charge, `check` first (avoids a
   *  double-record) then push. Stops the pass if the platform is down. */
  const drainTuitionOutbox = async (): Promise<void> => {
    for (const row of store.listPendingTuitionRecords()) {
      const chk = await checkStudentPayment(row.paymentIntentId);
      if (chk.status === 'recorded') {
        store.setTuitionRecordStatus(row.paymentIntentId, 'recorded', chk.paymentId);
        continue;
      }
      if (chk.status === 'unavailable') break; // platform down — retry next tick
      await tryRecordTuition(row.paymentIntentId); // not-recorded → push it
    }
  };

  // Should the tuition tile show, and how is it labelled? (Cached ~5 min in students.ts.)
  app.get('/api/kiosk/tuition/info', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const r = await studentsInfo();
    if (!r.available || !r.info.enabled) return { data: { enabled: false } };
    return { data: { enabled: true, schoolName: r.info.schoolName, currency: r.info.currency, tagline: r.info.tagline } };
  });

  // Resolve a student name + PIN to a family + balance. Rate-limited per peer; the PIN is NEVER logged.
  // A wrong PIN and a name mismatch return the SAME `found:false` (no enumeration oracle).
  const TuitionLookupBody = z.object({
    campaignId: z.string().max(120),
    name: z.string().trim().min(1).max(120),
    pin: z.string().trim().min(1).max(40),
  });
  app.post('/api/kiosk/tuition/lookup', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const peer = req.socket.remoteAddress ?? 'unknown';
    const wait = tuitionLookupLimiter.retryAfterMs(peer);
    if (wait > 0) return reply.code(429).send({ error: `Too many tries. Please wait ${Math.ceil(wait / 1000)}s.` });
    const parsed = TuitionLookupBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the student’s name and PIN.' });
    const campaign = store.getCampaign(parsed.data.campaignId);
    if (!campaign || campaign.type !== 'tuition') return reply.code(400).send({ error: 'That isn’t a tuition appeal.' });
    const r = await studentsLookup(parsed.data.name, parsed.data.pin);
    if (r.status === 'unavailable') return reply.code(503).send({ error: 'Tuition is temporarily unavailable — please try again shortly.' });
    if (r.status === 'not-found') {
      tuitionLookupLimiter.fail(peer); // count only real "not found" toward the limit
      return { data: { found: false } };
    }
    tuitionLookupLimiter.succeed(peer);
    // Stash the family + invoices server-side; the tablet only gets display fields + an opaque session id.
    const session = createTuitionSession({
      campaignId: campaign.id,
      deviceId: d.id,
      familyId: r.family.id,
      studentId: r.matchedStudentId,
      familyLabel: r.family.label,
      currency: r.family.currency,
      balanceCents: r.family.balanceCents,
      invoices: r.family.openInvoices.map((i) => ({ id: i.id, balanceCents: i.balanceCents })),
    });
    return {
      data: {
        found: true,
        session: session.id, // opaque; the family/student ids stay on the server
        family: {
          label: r.family.label,
          students: r.family.students, // firstName + lastInitial only (per contract)
          balanceCents: r.family.balanceCents,
          currency: r.family.currency,
          openInvoices: r.family.openInvoices, // id (for selection) + label + dueDate + balanceCents
        },
      },
    };
  });

  // Mint the card-present PaymentIntent for the full balance or the ticked invoices. Amount + family
  // are recomputed SERVER-SIDE from the held session — the tablet only sends the session id + selection.
  const TuitionIntentBody = z.object({
    session: z.string().trim().min(1).max(64),
    selection: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('full') }),
      z.object({ kind: z.literal('invoices'), invoiceIds: z.array(z.string().max(128)).min(1).max(60) }),
    ]),
    idempotencyKey: z.string().trim().min(8).max(255).optional(),
  });
  app.post('/api/kiosk/tuition/payment-intents', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const parsed = TuitionIntentBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'That payment request wasn’t valid.' });
    const session = getTuitionSession(parsed.data.session);
    if (!session || session.deviceId !== d.id) {
      return reply.code(400).send({ error: 'Your session expired — please look up the balance again.' });
    }
    const campaign = store.getCampaign(session.campaignId);
    if (!campaign || campaign.type !== 'tuition') return reply.code(400).send({ error: 'That isn’t a tuition appeal.' });
    const amt = computeTuitionAmount(session, parsed.data.selection);
    if ('error' in amt) return reply.code(400).send({ error: 'Please choose what to pay.' });
    // Tuition is card-present on the reader's (primary) account — which MUST be the school's account so
    // Students' reconciliation finds it (contract §4). We charge the primary account here.
    const acct = await resolveAccount();
    if (!acct) return reply.code(400).send({ error: 'Payments aren’t set up yet.' });
    const currency = session.currency || store.getCurrency();
    const metadata: Record<string, string> = {
      purpose: 'students-billing', // §11.3 reconciliation discriminator (REQUIRED)
      omos_app: 'kiosk',
      app: 'kiosk',
      kind: 'tuition',
      students_family_id: session.familyId, // REQUIRED, from the held session — never the tablet
      deviceId: d.id,
      campaignId: campaign.id,
      stripeAccountId: acct.id,
    };
    if (session.studentId) metadata.students_student_id = session.studentId;
    const piInput = {
      amountMinor: amt.amountCents,
      currency,
      description: `School balance — ${session.familyLabel}`.slice(0, 200), // never the PIN/typed name
      metadata,
    };
    try {
      const pi = await createCardPresentPaymentIntent(acct.keys.secretKey, piInput, parsed.data.idempotencyKey);
      store.rememberPiAccount(pi.id, acct.id);
      // Enqueue in the tuition outbox (pending) — recorded to Students AFTER the charge verifies.
      store.enqueueTuitionPayment({
        paymentIntentId: pi.id,
        deviceId: d.id,
        campaignId: campaign.id,
        stripeAccountId: acct.id,
        familyId: session.familyId,
        studentId: session.studentId,
        familyLabel: session.familyLabel,
        amountMinor: amt.amountCents,
        currency,
        allocations: amt.allocations,
      });
      return { data: { paymentIntentId: pi.id, clientSecret: pi.clientSecret, chargeMinor: amt.amountCents, currency } };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const why = `${e.code ?? ''} ${e.message ?? ''}`.trim().slice(0, 300);
      log.warn(`tuition payment-intent create failed: ${why}`);
      store.addLogs(d.id, [{ level: 'warn', event: 'tuition_pi_failed', detail: why.slice(0, 200) }]);
      return reply.code(502).send({ error: 'Couldn’t start the payment. Please try again.' });
    }
  });

  // Finish a tuition payment: verify the PI with Stripe, then record it in Students (idempotent, with
  // the outbox as backstop). NEVER recorded as a kiosk donation (contract §5).
  app.post('/api/kiosk/tuition/payment-intents/:id/complete', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const id = (req.params as { id: string }).id;
    if (!/^pi_[A-Za-z0-9_]+$/.test(id)) return reply.code(400).send({ error: 'That payment wasn’t valid.' });
    const acct = await resolveAccountById(store.getPiAccount(id));
    if (!acct) return reply.code(400).send({ error: 'Payments aren’t set up yet.' });
    try {
      const result = await completeCardPresentPaymentIntent(acct.keys.secretKey, id);
      store.markTuitionPaid(
        id,
        result.succeeded ? 'succeeded' : 'failed',
        result.chargeId,
        new Date(result.createdSec * 1000).toISOString(),
      );
      if (result.succeeded) {
        await tryRecordTuition(id); // best-effort now; the outbox retries if Students is unreachable
        void notify({
          text: `${formatMoney(result.amountMinor, result.currency)} tuition payment at ${d.name || 'the kiosk'}.`,
          level: 'success',
        });
      }
      return { data: { status: result.status, succeeded: result.succeeded, amountMinor: result.amountMinor, currency: result.currency } };
    } catch {
      return reply.code(502).send({ error: 'Couldn’t confirm the payment with Stripe.' });
    }
  });

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
    await app.register(fastifyStatic, { root: config.publicDir, index: false });
  } else {
    log.warn(`no built web app at ${config.publicDir} — run "cd web && npm run build" (dev uses the Vite server on :5173)`);
  }

  const rawIndex = havePublic ? fs.readFileSync(indexPath, 'utf8') : '';
  // The tunnel base-path injection below hangs off a literal `<head>` in the built HTML. Guard against
  // a future build that renames/minifies it (the injection would silently no-op → the SPA drops the
  // prefix and breaks over the tunnel). LAN is unaffected either way.
  if (havePublic && !rawIndex.includes('<head>')) {
    log.warn('index.html has no literal <head> — remote (tunnel) base-path injection will not apply');
  }
  // Serve index.html with the tunnel base path injected — but ONLY for a request that actually
  // arrived over the tunnel (it carries the prefix, flagged in rewriteUrl as omosViaTunnel). A LAN
  // or per-app-HTTPS-proxy request arrives at the root, so it gets the verbatim file and the SPA
  // uses root paths — critical, so the LAN admin panel keeps working when remote access is on.
  // When injected: a `<base href>` (relative-built Vite assets resolve under the prefix) plus
  // `window.__OMOS_BASE__` (web/src/base.ts prefixes API/nav/asset URLs). basePath is already a
  // safe URL-path charset (normBasePath), re-sanitised here defensively.
  const sendIndexHtml = (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const viaTunnel = (req.raw as unknown as { omosViaTunnel?: boolean }).omosViaTunnel === true;
    const base = viaTunnel ? cachedFabricSite().basePath.replace(/[^\w/-]/g, '') : '';
    if (!base) return reply.type('text/html').send(rawIndex);
    const head = `<base href="${base}/">\n    <script>window.__OMOS_BASE__=${JSON.stringify(base)}</script>`;
    return reply.type('text/html').send(rawIndex.replace('<head>', `<head>\n    ${head}`));
  };
  if (havePublic) app.get('/', async (req, reply) => sendIndexHtml(req, reply));

  // SPA fallback: client-side routes (/new, /admin) resolve to index.html; requests that
  // look like a file still 404; unknown API/health routes return JSON.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    const pathname = url.split('?')[0];
    const looksLikeFile = path.extname(pathname) !== '';
    if (req.method === 'GET' && havePublic && !looksLikeFile && !url.startsWith('/api') && !url.startsWith('/healthz')) {
      return sendIndexHtml(req, reply);
    }
    return reply.code(404).send({ error: 'Not found.' });
  });

  // Consistent JSON error envelope; never leak a stack trace or framework-internal text.
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { message?: string; statusCode?: number; expose?: boolean };
    log.error('request error', e.message ?? 'unknown');
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    const friendly =
      status === 413 ? 'That request was too large.' : status < 500 ? 'We couldn’t process that request.' : 'Something went wrong. Please try again.';
    reply.code(status).send({ error: e.expose && e.message ? e.message : friendly });
  });

  // Keep our public base path warm (manifest `domain: true`) so the base-path rewrite + the
  // remote-adoption page are accurate without a per-request network call. Best-effort; when the
  // Fabric is absent or remote access is off, this stays "" and we behave exactly as a LAN app.
  await fetchFabricSite().catch(() => {});
  setInterval(() => { void fetchFabricSite(); }, 60_000).unref();

  // Tuition (students/billing): keep availability warm so the tile shows/hides correctly, and drain the
  // record-payment outbox so a dropped push after a successful charge is retried (Students' daily
  // reconciliation is the ultimate backstop). Only when the Fabric is configured.
  if (billingConfigured()) {
    void studentsInfo().catch(() => {});
    setInterval(() => { void studentsInfo(true); }, 5 * 60_000).unref();
    setInterval(() => { void drainTuitionOutbox(); }, 60_000).unref();
  }

  await app.listen({ port: config.port, host: config.host });
  log.info(`OpenMasjid Kiosk listening on http://${config.host}:${config.port}`);
  log.info(ssoConfigured() ? 'running embedded under OpenMasjidOS (Fabric available)' : 'running standalone (local admin, Fabric absent)');

  const shutdown = (code = 0) => {
    log.info('shutting down');
    try { store.close(); } catch { /* already closed */ }
    app.close().finally(() => setTimeout(() => process.exit(code), 200));
    setTimeout(() => process.exit(code), 2000).unref?.();
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

main().catch((err) => {
  log.error('fatal startup error', err instanceof Error ? err.message : err);
  process.exit(1);
});
