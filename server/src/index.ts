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
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { z } from 'zod';
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';
import { Store, type Device } from './store';
import { COOKIE, cookieOptions, hashPassword, hashPin, makeDeviceToken, makePairingCode, makeToken, verifyPassword, verifyToken, SSO_SESSION_MS } from './auth';
import { notify, probePlatform, fetchAppearance, fetchFabricStripe, fetchFabricStripeAccounts, clearFabricStripeCache } from './fabric';
import { LoginLimiter } from './rateLimit';
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
  });

  await app.register(fastifyCookie);

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
      const fab = await fetchFabricStripe(store.getFabricStripeChoice());
      if (fab && stripeConfigured(fab)) {
        return { keys: { publishableKey: fab.publishableKey, secretKey: fab.secretKey }, source: 'fabric', id: fab.id, label: fab.label };
      }
    }
    const local = store.getLocalStripe();
    if (stripeConfigured(local)) return { keys: local, source: 'local', id: 'local', label: 'Locally-entered keys' };
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

  app.put('/api/admin/devices/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ name: z.string().max(80) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter a name.' });
    const d = store.renameDevice((req.params as { id: string }).id, parsed.data.name.trim());
    if (!d) return reply.code(404).send({ error: 'Kiosk not found.' });
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
    const cfg = store.getKioskConfig();
    // When manual entry is on, include the publishable key (public) so the tablet can initialise
    // Stripe's PaymentSheet EARLY — the card form fails if PaymentConfiguration isn't set up first.
    if (store.getGiving().manualEntryEnabled) {
      const acct = await resolveAccount();
      if (acct?.keys.publishableKey) (cfg.config as Record<string, unknown>).publishableKey = acct.keys.publishableKey;
    }
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
    donorName: z.string().trim().max(120).optional(),
    donorEmail: z.string().trim().max(200).optional(),
    // Recurring monthly donation (sets up a Subscription from the card-present charge).
    monthly: z.boolean().optional(),
    // Keyed/manual card entry (Stripe's on-device card form) instead of the reader.
    manual: z.boolean().optional(),
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
    if (!store.isAllowedAmount(amountMinor)) return reply.code(400).send({ error: 'That amount isn’t available.' });
    // Keyed/manual entry must be enabled by the admin (gate on the tablet AND here).
    if (manual && !store.getGiving().manualEntryEnabled) {
      return reply.code(400).send({ error: 'Manual card entry isn’t available right now.' });
    }
    // Monthly giving needs name + email (to create the Customer/Subscription and send receipts).
    // Enforced on the tablet AND here — never trust the client. (Monthly is card-present only; the
    // reusable card comes from the reader, so it can't be combined with keyed entry.)
    if (monthly) {
      if (manual) return reply.code(400).send({ error: 'Monthly giving needs the card reader.' });
      if (!store.getGiving().monthlyEnabled) return reply.code(400).send({ error: 'Monthly giving isn’t available right now.' });
      if (!donorName || !donorName.trim()) return reply.code(400).send({ error: 'Monthly giving needs a name.' });
      if (!looksLikeEmail(donorEmail)) return reply.code(400).send({ error: 'Monthly giving needs a valid email for the receipt.' });
    }
    const acct = await resolveAccount();
    if (!acct) return reply.code(400).send({ error: 'Payments aren’t set up yet.' });
    const currency = store.getCurrency();
    const preset = store.getGiving().presetsMinor.includes(amountMinor) ? 'preset' : 'custom';
    const metadata = { app: 'kiosk', deviceId: d.id, kind: monthly ? 'monthly' : 'one_time', entry: manual ? 'manual' : 'reader', preset, donorName: donorName ?? '', donorEmail };
    const piInput = {
      amountMinor,
      currency,
      description: `${monthly ? 'Monthly donation' : 'Donation'} — ${store.getMasjid().name || 'OpenMasjid Kiosk'}`,
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
      return { data: { paymentIntentId: pi.id, clientSecret: pi.clientSecret, publishableKey: manual ? acct.keys.publishableKey : undefined } };
    } catch {
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
    const acct = await resolveAccount();
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
      let monthly = { requested: wantsMonthly, created: false };
      if (result.succeeded && wantsMonthly && result.generatedCard) {
        try {
          const masjidName = store.getMasjid().name || 'OpenMasjid Kiosk';
          const sub = await createMonthlySubscription(acct.keys.secretKey, {
            amountMinor: result.amountMinor,
            currency: result.currency,
            paymentMethod: result.generatedCard,
            name: meta.donorName || undefined,
            email: meta.donorEmail || undefined,
            productName: `Monthly donation — ${masjidName}`,
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
  const sendIndexHtml = (reply: import('fastify').FastifyReply) => reply.type('text/html').send(rawIndex);
  if (havePublic) app.get('/', async (_req, reply) => sendIndexHtml(reply));

  // SPA fallback: client-side routes (/new, /admin) resolve to index.html; requests that
  // look like a file still 404; unknown API/health routes return JSON.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    const pathname = url.split('?')[0];
    const looksLikeFile = path.extname(pathname) !== '';
    if (req.method === 'GET' && havePublic && !looksLikeFile && !url.startsWith('/api') && !url.startsWith('/healthz')) {
      return sendIndexHtml(reply);
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
