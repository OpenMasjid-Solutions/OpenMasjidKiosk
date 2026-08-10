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
import { Store, grossUpForFees, type Device, type DonationRecord, type EmailReceipt } from './store';
import { COOKIE, cookieOptions, hashPassword, hashPin, makeDeviceToken, makePairingCode, makeToken, verifyPassword, verifyToken, SSO_SESSION_MS } from './auth';
import { notify, probePlatform, fetchAppearance, fetchFabricStripe, fetchFabricStripeAccounts, clearFabricStripeCache, fetchFabricSite, cachedFabricSite, fabricEmail, fabricAlert, emailStatus, emailCanSend } from './fabric';
import { renderReceipt, renderRefund, type ReceiptContext } from './email';
import { studentsInfo, studentsIdentify, studentsLookup, recordStudentPayment, checkStudentPayment, createTuitionSession, getTuitionSession, computeTuitionAmount, studentKey, dueCents, billingConfigured, MIN_TUITION_CENTS, MAX_TUITION_CENTS } from './students';
import { GlobalAttemptBudget, LoginLimiter } from './rateLimit';
import { blockedOverTunnel } from './tunnel';
import { toCsv } from './csv';
import {
  completeCardPresentPaymentIntent,
  createCardPaymentIntent,
  createCardPresentPaymentIntent,
  cancelPlan,
  createConnectionToken,
  createLocation,
  createDonorCustomer,
  createMonthlySubscription,
  listLocations,
  listPlanInvoices,
  listPlans,
  pausePlan,
  refundPayment,
  retrievePlan,
  schedulePlanEnd,
  type StripePlan,
  looksLikePublishable,
  looksLikeSecret,
  publicStripeStatus,
  retrieveLocation,
  sendStripeReceipt,
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

  // ── Baseline security headers ────────────────────────────────────────────────
  // `nosniff` is the one that earns its keep: /uploads/* serves admin-uploaded files, and although
  // the upload route allow-lists the MIME type and assigns its own random name and extension,
  // nosniff is what stops a browser reinterpreting a "PNG" whose bytes begin with markup.
  //
  // NO framing header here on purpose. X-Frame-Options / frame-ancestors would close the
  // clickjacking gap, but I could not confirm whether OpenMasjidOS ever renders an installed app
  // inside an iframe, and a framing denial that breaks the dashboard would be worse than the gap it
  // closes. See docs/audit/ACTION_REQUIRED.md.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

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
  //
  // The rule itself lives in ./tunnel because it has to canonicalise the path the way the ROUTER
  // resolves it, not the way it arrived: Fastify percent-decodes path segments before matching, so
  // the previous inline `startsWith('/api/')` on the raw url was walked past by encoding one letter
  // ('/%61pi/login' reached the real password login over the tunnel). See tunnel.test.ts.
  app.addHook('onRequest', async (req, reply) => {
    if ((req.raw as unknown as { omosViaTunnel?: boolean }).omosViaTunnel !== true) return;
    if (blockedOverTunnel(req.raw.url ?? '/')) {
      return reply.code(404).send({ error: 'Not found.' });
    }
  });

  /** A request is authenticated if it carries a valid local session cookie — minted by
   *  first-run setup, password login, or a confirmed OpenMasjidOS SSO check. */
  const isAuthed = (cookie: string | undefined): boolean => verifyToken(store.secret, cookie, 'admin');

  /** Note an admin action that reaches OUTSIDE this app — ending or altering a donor's standing
   *  order, cutting a kiosk off, rotating the exit PIN. Best-effort by construction (store.recordAudit
   *  never throws), so it can be called on the success path without risking the action itself.
   *
   *  `actor` is as good as we can honestly make it: our session cookie carries no identity (it is an
   *  assertion that SOMEONE signed in), so when the platform can name the signed-in user we record
   *  that, and otherwise we say plainly that we don't know rather than inventing a name. */
  const audit = async (
    req: import('fastify').FastifyRequest,
    action: string,
    target: string,
    detail: string,
  ): Promise<void> => {
    let actor = 'admin (local password)';
    if (ssoConfigured()) {
      const who = await probePlatform(req.headers.cookie).catch(() => null);
      actor = who?.username ? `${who.username} (OpenMasjidOS)` : 'admin (signed in, name unknown)';
    }
    store.recordAudit({ action, target, detail, actor, source: req.socket.remoteAddress ?? '' });
  };
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

  // ── "What's new": the release notes THIS build shipped with ─────────────────
  // Read from the CHANGELOG.md copied into the image, not fetched from GitHub — an admin
  // panel that describes a release the container isn't running is worse than none, and a
  // masjid server has no business making an outbound call to render a menu. Admin-gated
  // (so it stays off the tunnel with the rest of /api/admin) and capped, since it is a
  // file that grows by a section every release.
  const CHANGELOG_MAX = 256 * 1024;
  app.get('/api/admin/changelog', { preHandler: requireAdmin }, async () => {
    let markdown = '';
    try {
      markdown = fs.readFileSync(config.changelogPath, 'utf8').slice(0, CHANGELOG_MAX);
    } catch {
      // Not fatal: an image built without it just shows "no release notes".
      log.debug('changelog not readable');
    }
    return { data: { version: config.version, markdown } };
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
  app.get('/api/admin/masjid', { preHandler: requireAdmin }, async () => ({ data: store.getMasjid() }));
  app.put('/api/admin/masjid', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().max(160).optional(),
        address: AddressBody.optional(),
        // Optional branding/contact for the emailed receipt (logo + a contact line). A logo is an
        // uploaded '/uploads/…' path or an external https URL; contact fields are shown as-is.
        logo: z.string().max(500).optional(),
        email: z.string().max(200).optional(),
        phone: z.string().max(60).optional(),
        website: z.string().max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details.' });
    return { data: store.setMasjid(parsed.data) };
  });

  // ── Emailed donation receipt (via the OpenMasjidOS Fabric email provider) ────
  // Design (subject/heading/body/accent) is admin-editable; the amount/date/method/fund details,
  // masjid logo + contact are filled in automatically (email.ts renderReceipt). Off by default;
  // nothing is emailed until the admin enables it AND the OS has an email provider set up.
  const EmailReceiptBody = z.object({
    enabled: z.boolean().optional(),
    subject: z.string().max(200).optional(),
    heading: z.string().max(200).optional(),
    body: z.string().max(4000).optional(),
    accent: z.string().max(40).optional(),
  });
  // `embedded` + `emailStatus` let the UI show whether OS email is set up WITHOUT a probe on load
  // (emailStatus is the last real send outcome; 'ok' once a send succeeded).
  const emailReceiptView = (cfg: EmailReceipt) => ({ ...cfg, embedded: ssoConfigured(), emailStatus: emailStatus() });
  app.get('/api/admin/email-receipt', { preHandler: requireAdmin }, async () => ({ data: emailReceiptView(store.getEmailReceipt()) }));
  app.put('/api/admin/email-receipt', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = EmailReceiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please check the details and try again.' });
    return { data: emailReceiptView(store.setEmailReceipt(parsed.data)) };
  });
  // In-app "send me a test": fire the declared `test` alert. The platform delivers it to the ADMIN's
  // own email + webhook (per their Settings → Alerts matrix) — the app never learns the admin's
  // address. (Donor receipts still go via /api/fabric/email with the donor's address; the admin's
  // email is never exposed to apps, so this alert is the only way the app can reach the admin.)
  app.post('/api/admin/test-alert', { preHandler: requireAdmin }, async () => {
    const res = await fabricAlert(
      'test',
      'Test from OpenMasjid Kiosk',
      'If you received this, OpenMasjidOS is reaching you by email/webhook. Your donation receipts go to donors through the same email provider.',
      'info',
    );
    return { data: res };
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
  const pairLimiter = new LoginLimiter(); // per-peer brute-force guard for 6-digit pairing codes
  // …and a budget shared across every peer. The per-peer limiter hands out 5 free guesses each, so
  // an attacker with many source addresses (a /64 of IPv6 is one host's worth on a LAN) multiplies
  // its way through the million-code space while no single bucket ever trips. 50 wrong codes in ten
  // minutes across the whole network is already far beyond a volunteer mistyping one.
  const pairBudget = new GlobalAttemptBudget(50, 10 * 60_000);
  // Tuition Student-ID lookups (identify + lookup SHARE this bucket, as they do at Students): a fixed
  // rolling window per peer (20 / 60s), capped regardless of success or failure — a valid lookup must
  // NOT refill the brute-force budget (a shared-IP attacker with one good ID could otherwise reset the
  // backoff), and splitting the budget per endpoint would just let a sweep alternate between them.
  // Students locks a Student ID after 6 failed probes an hour (contract §11.0/§14); this is
  // defence-in-depth so the kiosk is never the open relay. Well above any real kiosk's lookup rate.
  const tuitionLookupHits = new Map<string, { count: number; resetAt: number }>();
  const tuitionLookupOk = (ip: string): boolean => {
    const now = Date.now();
    if (tuitionLookupHits.size > 5000) for (const [k, w] of tuitionLookupHits) if (w.resetAt <= now) tuitionLookupHits.delete(k);
    const w = tuitionLookupHits.get(ip);
    if (!w || w.resetAt <= now) { tuitionLookupHits.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
    if (w.count >= 20) return false;
    w.count += 1;
    return true;
  };

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
        // Which side the reader sits on ('off'/'left'/'right'); normalised in the store.
        nfcSide: z.string().max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success || (parsed.data.name === undefined && parsed.data.orientation === undefined && parsed.data.nfcSide === undefined)) {
      return reply.code(400).send({ error: 'Please enter a name, orientation, or reader side.' });
    }
    const id = (req.params as { id: string }).id;
    let d = store.getDevice(id);
    if (!d) return reply.code(404).send({ error: 'Kiosk not found.' });
    if (parsed.data.name !== undefined) d = store.renameDevice(id, parsed.data.name.trim()) ?? d;
    if (parsed.data.orientation !== undefined) d = store.setDeviceOrientation(id, parsed.data.orientation) ?? d;
    if (parsed.data.nfcSide !== undefined) d = store.setDeviceNfcSide(id, parsed.data.nfcSide) ?? d;
    return { data: deviceView(d) };
  });

  app.delete('/api/admin/devices/:id', { preHandler: requireAdmin }, async (req) => {
    const id = (req.params as { id: string }).id;
    const name = store.getDevice(id)?.name ?? '';
    store.revokeDevice(id);
    await audit(req, 'device.revoke', id, name ? `kiosk "${name}" removed — its token no longer works` : 'kiosk removed');
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
      // The PIN itself is never recorded, here or anywhere — only that it changed.
      await audit(req, 'pin.clear', '', 'kiosk exit PIN removed — the maintenance screen is no longer PIN-gated');
      return { data: { set: false } };
    }
    if (!/^\d{4,8}$/.test(pin)) return reply.code(400).send({ error: 'The PIN must be 4 to 8 digits.' });
    store.setPinHash(hashPin(pin));
    await audit(req, 'pin.set', '', 'kiosk exit PIN changed — takes effect on each kiosk’s next heartbeat');
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
      tabSize: z.enum(['small', 'medium', 'large', 'xlarge']).optional(),
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

  // ── Recurring plans (monthly donations) ─────────────────────────────────────
  // STRIPE IS THE SOURCE OF TRUTH. There are no webhooks here (LAN-only, §4), so we hold no copy of
  // a plan's status, next charge or renewals and read them live instead — a cached status on a screen
  // an admin uses to cancel someone's standing order would be worse than no screen. The local `plans`
  // table supplies only what Stripe cannot know: the campaign, the account, and month one (which was
  // card-present, so it is not an invoice).

  const SUB_ID_RE = /^sub_[A-Za-z0-9_]+$/;

  /** How many locally-recorded plans the Recurring list will look up one-by-one when the account scan
   *  didn't return them. Only ever spent on plans the scan MISSED, so on a healthy install it is zero
   *  requests; the cap just stops a pathological data volume from turning one page load into a
   *  thousand Stripe calls. Well above any real masjid's number of standing orders. */
  const PLAN_RECORD_LOOKUP_CAP = 300;

  /** Every Stripe account a plan could live on: the primary, any campaign's own, and any we have
   *  recorded. Deduped by resolved account id — '' and 'local' can be the very same keys. */
  const planAccounts = async (): Promise<ResolvedAccount[]> => {
    const wanted = new Set<string>(['']);
    for (const c of store.listCampaigns()) if (c.stripeAccountId) wanted.add(c.stripeAccountId);
    for (const a of store.listPlanAccountIds()) wanted.add(a);
    const out: ResolvedAccount[] = [];
    const seen = new Set<string>();
    for (const id of wanted) {
      const acct = await resolveAccountById(id).catch(() => null);
      if (!acct || seen.has(acct.id)) continue;
      seen.add(acct.id);
      out.push(acct);
    }
    return out;
  };

  /** Join Stripe's live view of a plan to the local record. */
  const toPlan = (sp: StripePlan, accountId: string) => {
    const rec = store.getPlanRecord(sp.id);
    // Month one never appears in `invoices.list` — it was a card-present PaymentIntent on the reader.
    // Without the local record we cannot know it, so the total is flagged short rather than quietly
    // under-reported: "this plan has raised £X" being wrong by a month is the kind of number an
    // admin repeats to a committee.
    const first = rec?.firstAmountMinor ?? 0;
    return {
      ...sp,
      accountId,
      // The local row first, then what we stamped on the subscription itself — that copy is the one
      // that survives restoring the data volume from a backup older than the plan.
      campaignId: rec?.campaignId || sp.campaignId || '',
      campaignTitle: rec?.campaignTitle || sp.campaignTitle || '',
      totalMinor: sp.totalMinor + first,
      totalPartial: first <= 0,
      donorName: sp.donorName || rec?.donorName || '',
      donorEmail: sp.donorEmail || rec?.donorEmail || '',
      deviceId: sp.deviceId || rec?.deviceId || '',
    };
  };

  /** Find the account a subscription lives on and run something against it. Prefers the recorded
   *  account (one API call); otherwise asks each account in turn, because acting on the wrong one
   *  would at best 404 and at worst touch a same-id object elsewhere. */
  const withPlan = async <T,>(
    id: string,
    fn: (keys: StripeKeys, accountId: string) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: 'not-found' | 'no-account' }> => {
    const accounts = await planAccounts();
    if (!accounts.length) return { ok: false, reason: 'no-account' };
    const rec = store.getPlanRecord(id);
    const recorded = rec?.stripeAccountId ?? '';
    const ordered = recorded ? [...accounts].sort((a, b) => (a.id === recorded ? -1 : b.id === recorded ? 1 : 0)) : accounts;
    for (const acct of ordered) {
      // Holding a local row for this id is proof it is ours, so don't also demand the metadata tag —
      // otherwise a plan the list can now show would still refuse to pause or cancel, which is the
      // worse half of the same bug (an admin can see the standing order but not stop it).
      const found = await retrievePlan(acct.keys.secretKey, id, { ownedLocally: !!rec }).catch(() => null);
      if (!found) continue;
      return { ok: true, value: await fn(acct.keys, acct.id) };
    }
    return { ok: false, reason: 'not-found' };
  };

  app.get('/api/admin/plans', { preHandler: requireAdmin }, async () => {
    const accounts = await planAccounts();
    if (!accounts.length) return { data: { plans: [], unavailable: 'Payments aren’t set up yet.' } };
    const byId = new Map<string, ReturnType<typeof toPlan>>();
    let failures = 0;
    let truncated = false;
    let totalsCapped = false;
    for (const acct of accounts) {
      try {
        const res = await listPlans(acct.keys.secretKey);
        truncated = truncated || res.truncated;
        totalsCapped = totalsCapped || res.totalsCapped;
        for (const sp of res.plans) {
          if (!byId.has(sp.id)) byId.set(sp.id, toPlan(sp, acct.id));
        }
      } catch (e) {
        failures++;
        log.warn(`plans list failed for one account: ${e instanceof Error ? e.message : 'error'}`);
      }
    }
    // THE INDEX IS LOCAL, the state is live. Everything above discovers plans by SCANNING each Stripe
    // account and keeping those tagged `app=kiosk` — good for finding a plan we have no row for (a
    // restored volume, a rebuilt box), but it cannot be the index: a scan reaches an account we can
    // resolve today, filters on metadata that must still be intact, and a full page cuts the oldest
    // off the end. Miss on any of those and a live standing order silently disappears from the only
    // screen that can cancel it, under the words "No recurring plans yet".
    //
    // So every plan WE recorded is also fetched directly by id — one call, no scan, no metadata gate
    // (see retrievePlan's ownedLocally). This is how OpenMasjidDonations has always done it: the index
    // is the local rows, Stripe supplies each plan's live state. In the healthy case the scan already
    // returned these, so this loop makes no calls at all; it only spends a request on a plan the scan
    // failed to bring back — exactly the case that was broken.
    let unconfirmed = 0;
    for (const rec of store.listPlanRecords().slice(0, PLAN_RECORD_LOOKUP_CAP)) {
      if (byId.has(rec.subscriptionId)) continue;
      const ordered = rec.stripeAccountId
        ? [...accounts].sort((a, b) => (a.id === rec.stripeAccountId ? -1 : b.id === rec.stripeAccountId ? 1 : 0))
        : accounts;
      let found = false;
      for (const acct of ordered) {
        let sp: StripePlan | null = null;
        try {
          sp = await retrievePlan(acct.keys.secretKey, rec.subscriptionId, { ownedLocally: true });
        } catch (e) {
          // A bad key or an unreachable Stripe — NOT "this plan is gone". Counting it as missing would
          // tell the admin a live plan had vanished; count it as a failure so the list says it's short.
          failures++;
          log.warn(`plan lookup failed for one account: ${e instanceof Error ? e.message : 'error'}`);
          continue;
        }
        if (!sp) continue; // resource_missing on this account — try the next one
        byId.set(sp.id, toPlan(sp, acct.id));
        found = true;
        break;
      }
      if (!found) unconfirmed++;
    }
    // A capped invoice scan means every total on this screen is a floor. Mark them all partial so
    // the list uses the footnote it already has, rather than showing a confident number that is
    // quietly short — opening a plan re-totals it exactly.
    const plans = [...byId.values()]
      .map((p) => (totalsCapped ? { ...p, totalPartial: true } : p))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    // Say so when a whole account couldn't be read, or when the scan filled up — an admin looking at
    // a short list needs to know it's short, not assume those donors cancelled.
    const unavailable =
      failures && !plans.length
        ? 'Couldn’t reach Stripe just now — please try again.'
        : failures
          ? 'Some plans couldn’t be loaded — this list may be incomplete.'
          : // We hold a row saying we set this plan up, and Stripe says it does not exist on any account
            // we can reach. Never silent: either it was deleted in the dashboard (fine, but the admin
            // should know the record is stale) or it lives on an account this app can no longer resolve,
            // in which case a donor is still being charged somewhere this screen cannot show or cancel.
            unconfirmed
            ? `${unconfirmed} plan${unconfirmed === 1 ? '' : 's'} we set up couldn’t be found in Stripe — ${unconfirmed === 1 ? 'it was' : 'they were'} either cancelled in the Stripe dashboard, or ${unconfirmed === 1 ? 'it lives' : 'they live'} on a Stripe account this app can no longer reach.`
            : truncated
              ? 'This Stripe account has more subscriptions than we can scan at once, so this list may be incomplete.'
              : '';
    return { data: { plans, unavailable } };
  });

  app.get('/api/admin/plans/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!SUB_ID_RE.test(id)) return reply.code(400).send({ error: 'That plan wasn’t valid.' });
    const r = await withPlan(id, async (keys, accountId) => {
      const sp = await retrievePlan(keys.secretKey, id);
      if (!sp) return null;
      return { plan: toPlan(sp, accountId), invoices: await listPlanInvoices(keys.secretKey, id) };
    });
    if (!r.ok || !r.value) return reply.code(404).send({ error: 'That plan couldn’t be found in Stripe.' });
    return { data: r.value };
  });

  /** The three write actions. Each re-reads the plan from Stripe afterwards and returns it, so the
   *  screen shows what Stripe actually did rather than what we asked for. */
  const planAction = async (
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    act: (keys: StripeKeys, id: string) => Promise<unknown>,
  ) => {
    const id = (req.params as { id: string }).id;
    if (!SUB_ID_RE.test(id)) return reply.code(400).send({ error: 'That plan wasn’t valid.' });
    try {
      const r = await withPlan(id, async (keys, accountId) => {
        await act(keys, id);
        const sp = await retrievePlan(keys.secretKey, id);
        return sp ? toPlan(sp, accountId) : null;
      });
      if (!r.ok || !r.value) return reply.code(404).send({ error: 'That plan couldn’t be found in Stripe.' });
      return { data: { plan: r.value } };
    } catch (e) {
      const why = e instanceof Error ? e.message : 'error';
      log.warn(`plan action failed: ${why}`);
      return reply.code(502).send({ error: 'Stripe wouldn’t accept that change. Please try again, or check the Stripe dashboard.' });
    }
  };

  const CancelBody = z.object({ immediately: z.boolean().optional() });
  app.post('/api/admin/plans/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CancelBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'That request wasn’t valid.' });
    const now = body.data.immediately === true;
    return planAction(req, reply, async (keys, id) => {
      const r = await cancelPlan(keys.secretKey, id, now);
      await audit(req, 'plan.cancel', id, now ? 'ended immediately' : 'ends at the end of the paid period');
      return r;
    });
  });

  const PauseBody = z.object({ paused: z.boolean() });
  app.post('/api/admin/plans/:id/pause', { preHandler: requireAdmin }, async (req, reply) => {
    const body = PauseBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'That request wasn’t valid.' });
    return planAction(req, reply, async (keys, id) => {
      const r = await pausePlan(keys.secretKey, id, body.data.paused);
      await audit(req, 'plan.pause', id, body.data.paused ? 'paused — nothing collected until resumed' : 'resumed');
      return r;
    });
  });

  // End on a date, or after a fixed number of further charges. Both empty clears the schedule.
  const ScheduleBody = z.object({
    endAt: z.string().max(40).nullish(),
    charges: z.number().int().min(1).max(600).nullish(),
  });
  app.post('/api/admin/plans/:id/schedule', { preHandler: requireAdmin }, async (req, reply) => {
    const body = ScheduleBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'That request wasn’t valid.' });
    const { endAt, charges } = body.data;
    if (endAt && charges) return reply.code(400).send({ error: 'Choose an end date or a number of payments, not both.' });
    let endSec: number | null = null;
    if (endAt) {
      const t = Date.parse(endAt);
      if (Number.isNaN(t)) return reply.code(400).send({ error: 'That date wasn’t valid.' });
      if (t <= Date.now()) return reply.code(400).send({ error: 'Pick a date in the future.' });
      endSec = Math.floor(t / 1000);
    }
    return planAction(req, reply, async (keys, id) => {
      const r = await schedulePlanEnd(keys.secretKey, id, { endAt: endSec, charges: charges ?? null });
      const what = endSec ? `ends on ${new Date(endSec * 1000).toISOString().slice(0, 10)}` : charges ? `stops after ${charges} more charge(s)` : 'end date cleared — carries on';
      await audit(req, 'plan.schedule', id, what);
      return r;
    });
  });

  // The audit trail itself. Read-only by construction — there is no route that edits or deletes a
  // row, which is the point of keeping one.
  app.get('/api/admin/audit', { preHandler: requireAdmin }, async (req) => {
    const q = (req.query ?? {}) as { limit?: string };
    return { data: { entries: store.listAudit(Number(q.limit) || 200) } };
  });

  // CSV export — behind admin auth (it exposes donor PII). Every cell is escaped against CSV formula
  // injection (donor name/email are attacker-controllable). Amounts are in major units for humans.
  // Exports the FULL history (limit -1 = no SQLite limit), not just the on-screen page.
  /**
   * Refund a donation, in full or in part, and tell everyone who needs to know.
   *
   * Stripe is the only authority on whether money moved, so nothing is recorded, emailed or alerted
   * until `refunds.create` has come back. The order matters: refund → record → notify. A crash after
   * the refund leaves Stripe and our row disagreeing for one screen refresh, which the admin can see
   * and re-run; notifying first would tell a donor about money that never left.
   */
  app.post('/api/admin/donations/:id/refund', { preHandler: requireAdmin }, async (req, reply) => {
    const id = String((req.params as { id: string }).id || '');
    const parsed = z
      .object({
        // Omitted = refund whatever is left. Present = a partial, in minor units.
        amountMinor: z.number().int().positive().max(100_000_000).optional(),
        reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent']).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'That refund wasn’t valid.' });

    const don = store.getDonation(id);
    if (!don) return reply.code(404).send({ error: 'That donation couldn’t be found.' });
    // Only real money can be given back. A failed or pending donation never left the donor's account.
    if (don.status !== 'succeeded') return reply.code(400).send({ error: 'Only a successful donation can be refunded.' });
    const remaining = don.amountMinor - don.refundedMinor;
    if (remaining <= 0) return reply.code(409).send({ error: 'This donation has already been refunded in full.' });
    const want = parsed.data.amountMinor ?? remaining;
    if (want > remaining) {
      return reply.code(400).send({ error: `That’s more than is left to refund (${formatMoney(remaining, don.currency)}).` });
    }

    // The PaymentIntent may live on a campaign's own Stripe account, not the primary one.
    const acct = await resolveAccountById(store.getPiAccount(don.paymentIntentId)).catch(() => null);
    if (!acct) return reply.code(400).send({ error: 'Payments aren’t set up yet.' });

    let refund: Awaited<ReturnType<typeof refundPayment>>;
    try {
      refund = await refundPayment(acct.keys.secretKey, {
        paymentIntentId: don.paymentIntentId,
        // Always explicit, even for a full refund: "the rest" is computed from OUR row, and if that
        // ever disagrees with Stripe we want Stripe to reject the number rather than silently give
        // back more than the admin saw on screen.
        amountMinor: want,
        reason: parsed.data.reason,
        // Keyed to the donation AND the running total, so a double-clicked button returns the same
        // refund while a genuine second partial later is still allowed through.
        idempotencyKey: `refund_${don.id}_${don.refundedMinor}_${want}`,
        metadata: { donationId: don.id, deviceId: don.deviceId, campaignId: don.campaignId },
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log.warn(`refund failed for ${don.paymentIntentId}: ${why}`);
      // Loud on purpose. A refund the admin believes happened but didn't is how a donor gets told
      // they've been repaid and then isn't.
      return reply.code(502).send({ error: `Stripe couldn’t refund this donation: ${why.slice(0, 200)}` });
    }
    // Trust Stripe's figure over ours — a partial it adjusted is still what actually left the account.
    const total = store.recordRefund(don.id, {
      refundId: refund.refundId,
      amountMinor: refund.amountMinor || want,
      reason: parsed.data.reason,
    });
    const after = store.getDonation(don.id) ?? don;
    const fullyRefunded = after.refundedMinor >= after.amountMinor;

    // A refunded FIRST payment does not stop a monthly plan — Stripe keeps collecting next month.
    // The admin has to be told, or a donor gets their £10 back and is charged again in four weeks.
    const monthlyStillLive = don.kind === 'monthly';

    // ── The donor (only if they gave us an address) ──
    let donorEmailed = false;
    const addr = (after.donorEmail || '').trim();
    if (looksLikeEmail(addr) && emailCanSend()) {
      try {
        const rendered = renderRefund(store.getEmailReceipt(), {
          ...receiptContext(after),
          refundAmountText: formatMoney(refund.amountMinor || want, after.currency),
          full: fullyRefunded,
          dateRefunded: fmtReceiptDate(after.refundedAt || new Date().toISOString()),
        });
        const res = await fabricEmail({ to: addr, subject: rendered.subject, text: rendered.text, html: rendered.html });
        donorEmailed = res.sent;
      } catch {
        donorEmailed = false; // never let a mail problem undo a refund that has already happened
      }
    }

    // ── The admin: one alert, which OpenMasjidOS fans out to email and/or webhook per their choice ──
    void fabricAlert(
      'donation-refunded',
      'A donation was refunded',
      [
        `${formatMoney(refund.amountMinor || want, after.currency)} was refunded to ${after.donorName || 'a donor'}${addr ? ` (${addr})` : ''}`,
        `from ${after.deviceName || 'the kiosk'}${after.campaignTitle ? ` · ${after.campaignTitle}` : ''}.`,
        fullyRefunded ? 'This was the full donation.' : `This was part of ${formatMoney(after.amountMinor, after.currency)}.`,
        addr ? (donorEmailed ? 'The donor has been emailed.' : 'The donor could NOT be emailed — please contact them.') : 'No donor email was given, so they have not been told.',
        monthlyStillLive
          ? 'NOTE: this donor has a MONTHLY plan. Refunding this payment does NOT cancel it — end it on the Recurring page if they asked to stop.'
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      'warning',
    ).catch(() => {});

    log.info(`refunded ${refund.amountMinor || want} ${after.currency} of donation ${after.id} (${refund.refundId})`);
    return {
      data: {
        donation: after,
        refundedMinor: total ?? after.refundedMinor,
        fullyRefunded,
        donorEmailed,
        donorEmailAddress: addr,
        monthlyStillLive,
        status: refund.status,
      },
    };
  });

  app.get('/api/admin/donations.csv', { preHandler: requireAdmin }, async (_req, reply) => {
    // 'Amount' stays the amount GIVEN, so an export never rewrites history; 'Refunded' and 'Net' carry
    // what came back and what was kept. A spreadsheet summing the wrong column would otherwise report
    // money the masjid no longer has — so Net is provided rather than left as an exercise.
    const rows: string[][] = [
      ['Date', 'Amount', 'Refunded', 'Net', 'Currency', 'Type', 'Campaign', 'Status', 'Donor name', 'Donor email', 'Kiosk', 'PaymentIntent', 'Refund ID', 'Refunded at'],
    ];
    for (const d of store.listDonations(-1)) {
      rows.push([
        d.createdAt,
        String(toMajor(d.amountMinor, d.currency)),
        String(toMajor(d.refundedMinor, d.currency)),
        String(toMajor(d.amountMinor - d.refundedMinor, d.currency)),
        d.currency,
        d.kind === 'monthly' ? 'Monthly' : 'One-time',
        d.campaignTitle,
        d.status,
        d.donorName,
        d.donorEmail,
        d.deviceName || '',
        d.paymentIntentId,
        d.refundId,
        d.refundedAt,
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
    const wait = Math.max(pairLimiter.retryAfterMs(peer), pairBudget.retryAfterMs());
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
      pairBudget.fail(); // a wrong code costs the shared budget too, whoever sent it
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
  // ── Reader-offline alert (derived from the heartbeat's readerStatus) ─────────
  // The tablet already reports its reader status every heartbeat, so we detect a real outage here —
  // no extra tablet endpoint (and no tablet update) needed. We DEBOUNCE (a brief BT/USB blip or an
  // auto-reconnect must not alert) and LATCH (one alert per outage), and only for a kiosk that has
  // actually had a reader (a remembered serial, or a 'connected' seen this process) — a brand-new
  // kiosk with no reader stays quiet. On recovery we send a friendly "back online" note. State is
  // in-memory (a restart just re-arms the debounce). readerStatus values come from the Android app:
  // 'connected' | 'updating' (healthy), 'not_connected' | 'error' (offline), 'connecting' |
  // 'discovering' (transient auto-reconnect — hold).
  const READER_OFFLINE_DEBOUNCE_MS = 120_000; // ~2 min sustained before alerting
  const readerAlert = new Map<string, { offlineSince: number | null; alerted: boolean; everConnected: boolean }>();
  const noteReaderStatus = (deviceId: string, deviceName: string, status: string, readerSerial: string): void => {
    const now = Date.now();
    const st = readerAlert.get(deviceId) ?? { offlineSince: null, alerted: false, everConnected: false };
    const everConnected = st.everConnected || status === 'connected' || status === 'updating' || !!readerSerial.trim();
    if (status === 'connected' || status === 'updating') {
      if (st.alerted) {
        void fabricAlert('reader-offline', 'Card reader back online', `The card reader on ${deviceName || 'a kiosk'} is connected again — donations can be taken.`, 'info').catch(() => {});
      }
      readerAlert.set(deviceId, { offlineSince: null, alerted: false, everConnected: true });
      return;
    }
    if ((status === 'not_connected' || status === 'error') && everConnected) {
      const offlineSince = st.offlineSince ?? now;
      if (!st.alerted && now - offlineSince >= READER_OFFLINE_DEBOUNCE_MS) {
        void fabricAlert('reader-offline', 'Card reader offline', `The card reader on ${deviceName || 'a kiosk'} stopped responding — donations can't be taken until it's back. Check the reader is powered on and paired.`, 'warning').catch(() => {});
        readerAlert.set(deviceId, { offlineSince, alerted: true, everConnected: true });
      } else {
        readerAlert.set(deviceId, { offlineSince, alerted: st.alerted, everConnected });
      }
      return;
    }
    // 'connecting' / 'discovering' (or anything else) — transient; keep the current debounce state.
    readerAlert.set(deviceId, { ...st, everConnected });
  };

  app.post('/api/kiosk/heartbeat', async (req, reply) => {
    const d = resolveDevice(req);
    if (!d) return reply.code(401).send({ error: 'This kiosk isn’t paired.' });
    // A revoked device gets a clean signal (not a 401) so the tablet wipes + re-pairs.
    if (d.revoked) return { data: { configVersion: store.getConfigVersion(), identify: false, latestAppVersion: config.version, revoked: true } };
    const parsed = HeartbeatBody.safeParse(req.body ?? {});
    if (parsed.success) {
      store.updateHeartbeat(d.id, parsed.data);
      // Watch the reported reader status for a sustained outage (fail-soft; never blocks the beat).
      if (parsed.data.readerStatus) noteReaderStatus(d.id, d.name, parsed.data.readerStatus, d.readerSerial);
    }
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

  // ── Emailed donation receipt: build the context + send via the Fabric ────────
  // Resolve the masjid logo to an ABSOLUTE url an email client can load: an http(s) URL is used
  // as-is; an uploaded /uploads/… file only works when the app is publicly reachable, so we prefix
  // the Fabric public URL and drop it otherwise (the email just has no image).
  const resolveEmailImage = (image: string): string => {
    const v = (image ?? '').trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/uploads\//.test(v)) {
      const pub = cachedFabricSite().publicUrl;
      return pub ? `${pub}${v}` : '';
    }
    return '';
  };
  /** Format the receipt "date paid" using the server locale + timezone (best-effort). */
  const fmtReceiptDate = (iso: string): string => {
    const d = new Date(iso);
    try {
      return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' }).format(d);
    } catch {
      return d.toISOString();
    }
  };
  /** "Visa •••• 4242" (or "Card") from the captured card brand + last 4. */
  const paymentMethodLabel = (brand: string, last4: string): string => {
    const b = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : '';
    if (b && last4) return `${b} •••• ${last4}`;
    if (last4) return `Card •••• ${last4}`;
    return 'Card';
  };
  /** Build the Stripe-style receipt context for a recorded donation (from the row + masjid). */
  const receiptContext = (don: DonationRecord): ReceiptContext => {
    const m = store.getMasjid();
    return {
      name: don.donorName || '',
      amountText: formatMoney(don.amountMinor, don.currency),
      campaignTitle: don.campaignTitle || '',
      masjidName: m.name || '',
      masjidLogo: resolveEmailImage(m.logo),
      datePaid: fmtReceiptDate(don.createdAt),
      paymentMethod: paymentMethodLabel(don.cardBrand, don.cardLast4),
      reference: don.paymentIntentId.replace(/^pi_/, '').slice(0, 10).toUpperCase(),
      contactEmail: m.email || '',
      contactPhone: m.phone || '',
      contactWebsite: m.website || '',
    };
  };
  /** Render + send a donor's branded receipt. Returns whether it {sent} and whether a failure is
   *  worth a {retry} (transient/system) vs permanent (no/invalid email, or the provider rejected
   *  the recipient). NEVER throws. Does NOT re-check the enabled toggle — the CALLER gates on the
   *  donation's recorded decision (receipt==='pending'). */
  const sendDonationReceipt = async (don: DonationRecord): Promise<{ sent: boolean; retry: boolean }> => {
    const addr = (don.donorEmail || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { sent: false, retry: false }; // no/invalid email → never sendable
    try {
      const rendered = renderReceipt(store.getEmailReceipt(), receiptContext(don));
      const res = await fabricEmail({ to: addr, subject: rendered.subject, text: rendered.text, html: rendered.html });
      if (res.sent) return { sent: true, retry: false };
      // Permanent = the recipient is unusable, OR the platform has just told us no mail will ever
      // leave here (emailCanSend flips false the moment fabricEmail latches 'not_configured' /
      // 'no-fabric'). Both must be permanent, because a branded row that keeps "retrying" for ever
      // never reaches the Stripe hand-back and the donor ends up with NOTHING. 'bad_recipient'
      // alone was not enough: it is the one reason our own address check almost never lets through.
      const permanent = res.reason === 'bad_recipient' || !emailCanSend();
      return { sent: false, retry: !permanent };
    } catch {
      return { sent: false, retry: true };
    }
  };

  /**
   * Give a donation's receipt back to Stripe, for a branded one we can no longer deliver.
   *
   * The branded path omits `receipt_email` at intent so Stripe stays quiet. Whenever we give up —
   * permanently at /complete, permanently in the outbox, or by ageing out of it — that silence has
   * to be undone or the donor is left with no record of their gift at all. Resolves the account the
   * PaymentIntent was actually created on, so a campaign on its own Stripe account still works.
   * Never throws.
   */
  const handReceiptBackToStripe = async (don: DonationRecord): Promise<void> => {
    try {
      const addr = (don.donorEmail || '').trim();
      if (!don.chargeId || !addr) return;
      const acct = await resolveAccountById(store.getPiAccount(don.paymentIntentId));
      if (!acct) return;
      await sendStripeReceipt(acct.keys.secretKey, don.chargeId, addr);
    } catch {
      /* a failed hand-back must never disturb a donation that already succeeded */
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
    // A tuition appeal is NOT paid through the donation flow — it has its own Student ID → balance →
    // record-to-Students path (/api/kiosk/tuition/*). Reject it here so a crafted tablet can't mint a
    // tuition charge as a plain donation (wrong metadata, polluted totals, no Students record).
    if (campaign.type === 'tuition') return reply.code(400).send({ error: 'Tuition is paid on its own screen (Student ID).' });
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
    // Receipt strategy — DECIDED ONCE here and carried in PI metadata (`brandedReceipt`), so the
    // /complete recording + retry outbox stay consistent with whether we suppressed Stripe's receipt:
    //   • branded → suppress Stripe's built-in receipt + WE send our branded one (receipt:'pending').
    //   • else    → let Stripe send its receipt; we send nothing (receipt:'stripe') → never a double.
    // We go branded unless the platform has told us mail can never leave (emailCanSend — see the
    // long note there: the old `emailStatus() === 'ok'` was unsatisfiable, so branded receipts had
    // never once been sent). Require a VALID-looking email, not just a non-empty one: a branded PI
    // must actually be sendable. The "never zero receipts" guarantee now lives at /complete, where a
    // permanently failed branded send hands the job back to Stripe.
    const branded = looksLikeEmail(donorEmail) && store.getEmailReceipt().enabled && ssoConfigured() && emailCanSend();
    const metadata: Record<string, string> = {
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
      brandedReceipt: branded ? '1' : '0',
    };
    // MONTHLY NEEDS THE CARD TO SURVIVE THE PAYMENT, and that has to be arranged BEFORE it, not after.
    // Stripe only saves a card when the PaymentIntent asks (`setup_future_usage`), and it attaches the
    // saved card to the customer named ON THAT INTENT. We used to ask for neither and then look for
    // `generated_card` afterwards — which is why every monthly donation took the money and then found
    // no card to build the plan from. If making the customer fails we still take the donation as a
    // one-off rather than losing the gift; /complete then reports that monthly couldn't be arranged.
    let monthlyCustomer = '';
    if (monthly) {
      try {
        monthlyCustomer = await createDonorCustomer(acct.keys.secretKey, {
          name: donorName || undefined,
          email: donorEmail || undefined,
          deviceId: d.id,
          campaignId: campaign.id,
          idempotencyKey,
        });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        log.warn(`monthly customer create failed: ${why}`);
        store.addLogs(d.id, [{ level: 'warn', event: 'monthly_customer_failed', detail: why.slice(0, 200) }]);
      }
    }
    if (monthlyCustomer) metadata.monthlyCustomer = monthlyCustomer;
    const piInput = {
      amountMinor: chargeMinor,
      currency,
      description: `${monthly ? 'Monthly donation' : 'Donation'} — ${campaign.title || store.getMasjid().name || 'OpenMasjid Kiosk'}`,
      // Stripe emails its built-in receipt on success (if enabled) — UNLESS we're sending our own
      // branded one, in which case we suppress Stripe's so the donor doesn't get two.
      receiptEmail: branded ? undefined : donorEmail || undefined,
      // Only ever set for monthly. A one-off donation stays anonymous to Stripe and saves nothing.
      customerId: monthlyCustomer || undefined,
      setupFutureUsage: monthlyCustomer ? ('off_session' as const) : undefined,
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
      // Alert the admin donations are broken (bad/expired keys, Stripe down). Fire-and-forget; the
      // .catch() is REQUIRED — an unhandled async rejection would crash the process.
      void fabricAlert('payment-failed', 'A donation payment failed to start', 'Stripe rejected a payment setup — donors can’t give until it’s fixed. Check your Stripe keys/status in OpenMasjidOS → Settings → Payments.', 'error').catch(() => {});
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
      // A tuition PaymentIntent (purpose=students-billing) is settled + recorded via the tuition path
      // (its own /complete drains to the Students app), and must NEVER land in the donations table or
      // totals (contract §5/§11.3: tuition is a "payment", not a deductible donation). If this donation
      // route is ever hit with one, we still return the verified outcome but skip recordDonation/notify.
      if (meta.purpose === 'students-billing') {
        return { data: { status: result.status, succeeded: result.succeeded, amountMinor: result.amountMinor, currency: result.currency, monthly: { requested: false, created: false } } };
      }
      const wantsMonthly = meta.kind === 'monthly';
      // For a successful monthly donation, set up the recurring Subscription from the reusable
      // card Stripe derived from this card-present charge. The first month is THIS payment; the
      // Subscription's first automatic charge is a month out (never double-charged). If the card
      // can't be reused (generated_card absent), the one-time gift still stands — we just report
      // that monthly couldn't be arranged so the tablet can say so kindly.
      const campaignLabel = meta.campaign || store.getMasjid().name || 'OpenMasjid Kiosk';
      let monthly = { requested: wantsMonthly, created: false };
      // Why a requested monthly plan did not get set up. Empty means it did (or none was asked for).
      // This used to go nowhere at all: the generated-card branch simply didn't run, and the throw
      // branch reached only the container log — so an admin saw a donation badged "Monthly", no plan
      // on the Recurring screen, and nothing anywhere saying why.
      let monthlyProblem = '';
      // The reusable card, whichever way it was taken: `generated_card` for a reader tap, or the
      // PaymentIntent's own payment_method for a keyed card (which has no generated_card at all).
      // Both exist only because the intent was created with setup_future_usage against a customer.
      const reusableCard = result.generatedCard || result.paymentMethodId || '';
      // Prefer the customer Stripe actually recorded on the PaymentIntent over our metadata copy —
      // metadata can be stale on a retried/duplicated intent, the PI cannot.
      const monthlyCustomer = result.customerId || meta.monthlyCustomer || '';
      if (result.succeeded && wantsMonthly && !reusableCard) {
        // Stripe returns no reusable card for some cards and networks (notably digital wallets, which
        // are excluded from generated_card by design). The gift stands; the standing order cannot be
        // created from it. Say which half is missing — this line is the whole diagnosis in the log.
        monthlyProblem = monthlyCustomer
          ? 'Stripe saved no reusable card for this charge, so no standing order could be created. Some cards, networks and digital wallets cannot be reused.'
          : 'This donation was taken before the card could be set up for reuse, so no standing order could be created. If the tablet was mid-donation during an update, the next monthly gift will work.';
      }
      if (result.succeeded && wantsMonthly && reusableCard) {
        // Two failure domains, deliberately not sharing a try. Stripe creating the plan and us writing
        // our note of it fail for unrelated reasons and mean opposite things: the first means no plan
        // exists, the second means one DOES exist that we have lost our pointer to. Sharing a catch
        // reported a database error as "Stripe refused to create the standing order" — the exact
        // opposite of the truth, sending an admin to look for a plan they'd have been told wasn't there.
        let sub: Awaited<ReturnType<typeof createMonthlySubscription>> | null = null;
        try {
          sub = await createMonthlySubscription(acct.keys.secretKey, {
            amountMinor: result.amountMinor,
            currency: result.currency,
            paymentMethod: reusableCard,
            customerId: monthlyCustomer,
            name: meta.donorName || undefined,
            email: meta.donorEmail || undefined,
            productName: `Monthly donation — ${campaignLabel}`,
            deviceId: d.id,
            campaignId: meta.campaignId || '',
            campaignTitle: meta.campaign || '',
            anchorSec: result.createdSec, // deterministic across retries (idempotency-safe)
            idempotencyKey: id,
          });
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          log.warn('monthly subscription failed: ' + why);
          monthlyProblem = `Stripe refused to create the standing order: ${why.slice(0, 200)}`;
        }
        if (sub?.created) {
          monthly = { requested: true, created: true };
          // Remember the half of this plan Stripe will never know: the campaign, the account it
          // lives on, and THIS charge — month one is card-present, so it is not an invoice and
          // adding up invoices alone under-reports what the plan has raised.
          if (sub.subscriptionId) {
            try {
              store.recordPlan({
                subscriptionId: sub.subscriptionId,
                customerId: sub.customerId,
                stripeAccountId: acct.id,
                campaignId: meta.campaignId || '',
                campaignTitle: meta.campaign || '',
                deviceId: d.id,
                firstPaymentIntentId: id,
                firstAmountMinor: result.amountMinor,
                currency: result.currency,
                donorName: meta.donorName || '',
                donorEmail: meta.donorEmail || '',
              });
            } catch (e) {
              // The donor HAS a standing order — this only lost our local note of it. Never silent and
              // never dressed up as a Stripe failure: the plan still reaches the Recurring screen via
              // the account scan, but the campaign, the account and month one are now unknown to us.
              const why = e instanceof Error ? e.message : String(e);
              log.error(`plan created at Stripe but not recorded locally (${sub.subscriptionId}): ${why}`);
              store.addLogs(d.id, [
                {
                  level: 'warn',
                  event: 'plan_record_failed',
                  detail: `The monthly plan ${sub.subscriptionId} was created at Stripe but could not be saved here: ${why.slice(0, 200)}`,
                },
              ]);
            }
          }
        }
      }
      // A monthly gift the donor asked for and did NOT get is the one outcome here that must never
      // be silent: the money was taken once, the donor believes they have set up a standing order,
      // and the admin has nothing to cancel because nothing exists. Put it where both can see it —
      // this kiosk's log, and an alert to the admin.
      if (result.succeeded && wantsMonthly && !monthly.created) {
        store.addLogs(d.id, [{ level: 'warn', event: 'monthly_setup_failed', detail: monthlyProblem || 'No standing order was created.' }]);
        void fabricAlert(
          'monthly-failed',
          'A monthly donation could not be set up',
          `${formatMoney(result.amountMinor, result.currency)} was taken once at ${d.name || 'the kiosk'}, but the donor's monthly plan could NOT be created, so nothing will be collected again and there is nothing to cancel. ${monthlyProblem} If the donor expected a standing order, please contact them.`,
          'warning',
        ).catch(() => {});
      }
      // Branded receipt owed ONLY when the PI was minted branded (Stripe's receipt suppressed at
      // intent) AND it succeeded AND the donor gave an email. recordDonation persists that decision
      // and reports whether THIS call first-recorded it, so we send exactly once (a retried /complete
      // never re-sends, and never regresses a row already 'sent'/'skipped').
      const oweBranded = result.succeeded && meta.brandedReceipt === '1' && !!(meta.donorEmail || '').trim();
      const rec = store.recordDonation({
        paymentIntentId: id,
        deviceId: d.id,
        campaignId: meta.campaignId || '',
        campaignTitle: meta.campaign || '',
        amountMinor: result.amountMinor,
        currency: result.currency,
        // What ACTUALLY happened, not what was asked for. Recording a requested-but-failed monthly
        // as 'monthly' is what put a "Monthly" badge in Donations with no matching plan on the
        // Recurring screen — an admin reasonably reads that as a live standing order they cannot
        // cancel, when in truth a single gift was taken and nothing recurs. A failed monthly IS a
        // one-off charge; the intent is preserved in the kiosk log and the alert raised above.
        kind: monthly.created ? 'monthly' : 'one_time',
        status: result.succeeded ? 'succeeded' : result.status,
        donorName: meta.donorName,
        donorEmail: meta.donorEmail,
        cardBrand: result.cardBrand,
        cardLast4: result.cardLast4,
        receipt: oweBranded ? 'pending' : 'stripe',
        chargeId: result.chargeId,
      });
      if (result.succeeded) {
        const label = monthly.created ? 'monthly donation set up' : 'donation received';
        void notify({
          text: `${formatMoney(result.amountMinor, result.currency)} ${label} at ${d.name || 'the kiosk'}.`,
          level: 'success',
        });
        // Send our branded receipt, but ONLY on the first recording of a 'pending' row (never a
        // double on a retried /complete). Non-blocking; a transient failure stays 'pending' for the
        // retry outbox, a permanent one (bad/no email) is marked 'skipped'. The .catch() is REQUIRED.
        if (rec.firstRecord && rec.receipt === 'pending') {
          const don = store.getDonationByPaymentIntent(id);
          if (don) {
            void sendDonationReceipt(don)
              .then(async (r) => {
                if (r.sent) return store.setDonationReceipt(id, 'sent');
                if (r.retry) return; // stays 'pending' for the outbox
                // Permanently unsendable, and we suppressed Stripe's receipt at intent — so the
                // donor currently has NOTHING. Hand it back to Stripe rather than leave them with
                // no record of their gift. Only then mark it settled.
                await handReceiptBackToStripe(don);
                store.setDonationReceipt(id, 'skipped');
              })
              .catch(() => {});
          }
        }
      }
      return { data: { status: result.status, succeeded: result.succeeded, amountMinor: result.amountMinor, currency: result.currency, monthly } };
    } catch {
      return reply.code(502).send({ error: 'Couldn’t confirm the payment with Stripe.' });
    }
  });

  // ── Tuition (students/billing) — a `tuition` campaign shells out to OpenMasjid Students ─────
  // The parent taps the tuition tile and types their child's Student ID; we `identify` it, the tablet
  // asks "is this <first name>?", and only on confirmation do we `lookup` the balance over the Fabric
  // broker. They then pay the full balance or pick invoices, the M2 reader takes the card, and we
  // record it into the Students ledger (never as a kiosk "donation"). Contract v2 (§11.0) — there is
  // no PIN any more; the name confirmation is what catches a mistyped ID. The app secret stays on the
  // server; the Student ID is inert input (body only, never logged/stored/in metadata); amounts are
  // computed server-side from a held session. Everything fails soft if Students is absent.

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
      // The per-child split of a "choose what to pay" charge (v2). Students derives its own when this
      // is absent, which is right for a pay-full charge and wrong for picked invoices.
      students: row.students ?? undefined,
      // The exact ticked bill lines (0.43.0). Supersedes both of the above — students.ts drops them
      // when this is set, so the wire never carries two answers to "what did they pay for?".
      lines: row.lines ?? undefined,
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
    return {
      data: {
        enabled: true,
        schoolName: r.info.schoolName,
        currency: r.info.currency,
        tagline: r.info.tagline,
        // 0.41.0 (§11.0a): whether a parent may pay when nothing is due, and the floor for a typed
        // amount. The tablet uses these to render; the server re-checks both at pay time.
        allowAdvance: r.info.allowAdvance,
        minAmountMinor: r.info.minAmountCents,
      },
    };
  });

  // Step 1 of the v2 flow: a typed Student ID → the child's first name, so the tablet can ask "is this
  // the right child?" BEFORE any balance appears. Returns a name and nothing else (§11.2) — no balance,
  // no invoices, no siblings, no ids. Unknown / withdrawn / locked / tuition-off all answer the same
  // uniform `found:false`. Rate-limited per peer on the same bucket as the lookup below.
  const TuitionCodeBody = z.object({
    campaignId: z.string().max(120),
    // Max 32 to match the provider's own cap; normalised (case/spaces/hyphens) in students.ts.
    studentCode: z.string().trim().min(1).max(32),
  });
  app.post('/api/kiosk/tuition/identify', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!tuitionLookupOk(peer)) return reply.code(429).send({ error: 'Too many tries. Please wait a moment and try again.' });
    const parsed = TuitionCodeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the Student ID.' });
    const campaign = store.getCampaign(parsed.data.campaignId);
    if (!campaign || campaign.type !== 'tuition') return reply.code(400).send({ error: 'That isn’t a tuition appeal.' });
    const r = await studentsIdentify(parsed.data.studentCode);
    if (r.status === 'unavailable') return reply.code(503).send({ error: 'Tuition is temporarily unavailable — please try again shortly.' });
    if (r.status === 'not-found') return { data: { found: false } };
    // First name + last initial only — exactly what the parent needs to say "yes, that's my child".
    return { data: { found: true, student: { firstName: r.student.firstName, lastInitial: r.student.lastInitial } } };
  });

  // Step 2: the parent has confirmed the name → resolve the SAME Student ID to the family + balance.
  // Rate-limited per peer; the ID is NEVER logged. Every mismatch returns the same `found:false`
  // (no enumeration oracle). There is no PIN at v2 — see §11.0.
  app.post('/api/kiosk/tuition/lookup', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!tuitionLookupOk(peer)) return reply.code(429).send({ error: 'Too many tries. Please wait a moment and try again.' });
    const parsed = TuitionCodeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the Student ID.' });
    const campaign = store.getCampaign(parsed.data.campaignId);
    if (!campaign || campaign.type !== 'tuition') return reply.code(400).send({ error: 'That isn’t a tuition appeal.' });
    const r = await studentsLookup(parsed.data.studentCode);
    if (r.status === 'unavailable') return reply.code(503).send({ error: 'Tuition is temporarily unavailable — please try again shortly.' });
    if (r.status === 'not-found') {
      // Uniform "not found" (no enumeration oracle); the rolling window already counted this attempt.
      return { data: { found: false } };
    }
    // The school's advance/floor policy, captured into the session so the pay step validates against
    // the server's copy. Cached ~5 min alongside the tile label; unavailable → no paying ahead.
    const info = await studentsInfo();
    const policy = info.available
      ? { allowAdvance: info.info.allowAdvance, minAmountCents: info.info.minAmountCents }
      : { allowAdvance: false, minAmountCents: MIN_TUITION_CENTS };
    // Stash the family + invoices server-side; the tablet only gets display fields + an opaque session id.
    const session = createTuitionSession({
      campaignId: campaign.id,
      deviceId: d.id,
      familyId: r.family.id,
      studentId: r.matchedStudentId,
      familyLabel: r.family.label,
      currency: r.family.currency,
      balanceCents: r.family.balanceCents,
      creditCents: r.family.creditCents,
      allowAdvance: policy.allowAdvance,
      minAmountCents: policy.minAmountCents,
      // The children, in the SAME order the response lists them — the tablet addresses one by its
      // position (`s0`, `s1`) so "add £50 for Maryam" can name her ledger without the device ever
      // holding the school's internal ids.
      students: r.family.students.map((s) => ({
        studentId: s.studentId,
        name: [s.firstName, s.lastInitial].filter(Boolean).join(' '),
        balanceCents: s.balanceCents,
        creditCents: s.creditCents,
      })),
      // studentId is held server-side only — it is what lets the pay step tell Students whose bill
      // each picked invoice is (contract v2). `items` is what a ticked bill LINE resolves against
      // (0.43.0); empty on an older Students, which falls the pay step back to whole invoices.
      invoices: r.family.openInvoices.map((i) => ({
        id: i.id,
        balanceCents: i.balanceCents,
        studentId: i.studentId,
        items: i.items.map((it) => ({ id: it.id, balanceCents: it.balanceCents })),
      })),
    });
    // The tablet renders the account CHILD BY CHILD (each with their own balance, credit and bills), so
    // group the invoices here rather than shipping one flat list for the device to untangle.
    const wireInvoice = (i: (typeof r.family.openInvoices)[number]) => ({
      id: i.id,
      label: i.label,
      dueDate: i.dueDate,
      balanceCents: i.balanceCents,
      studentName: i.studentName,
      // 0.43.0 (§11.0b): what this bill is MADE OF, so a parent can pay the book fee without the
      // month's tuition. Empty on an older Students → the bill stays one line, exactly as before.
      items: i.items.map((it) => ({ id: it.id, label: it.label, kind: it.kind, amountCents: it.amountCents, balanceCents: it.balanceCents })),
    });
    const byStudent = new Map<string, ReturnType<typeof wireInvoice>[]>();
    for (const i of r.family.openInvoices) {
      const list = byStudent.get(i.studentId) ?? [];
      list.push(wireInvoice(i));
      byStudent.set(i.studentId, list);
    }
    const known = new Set(r.family.students.map((s) => s.studentId));
    const sections = r.family.students.map((s, idx) => ({
      key: studentKey(idx), // the handle the pay step maps back to a real studentId
      name: [s.firstName, s.lastInitial].filter(Boolean).join(' '),
      // The pre-sections shape, still spelled out: an older APK reads these two off this same array.
      firstName: s.firstName,
      lastInitial: s.lastInitial,
      balanceCents: s.balanceCents,
      creditCents: s.creditCents,
      invoices: byStudent.get(s.studentId) ?? [],
    }));
    // Defensive: a bill for a child missing from the sibling list would otherwise vanish from a screen
    // that only renders sections. Show it under an unnamed section — still payable, just unattributed.
    const orphans = r.family.openInvoices.filter((i) => !known.has(i.studentId)).map(wireInvoice);
    if (orphans.length) sections.push({ key: '', name: '', firstName: '', lastInitial: '', balanceCents: 0, creditCents: 0, invoices: orphans });
    return {
      data: {
        found: true,
        session: session.id, // opaque; the family/student ids stay on the server
        // What the tablet needs to offer "pay ahead" and to floor a typed amount.
        allowAdvance: policy.allowAdvance,
        minAmountMinor: policy.minAmountCents,
        family: {
          label: r.family.label,
          // Per-child sections: name, that child's own balance/credit, and their bills. `key` is the
          // opaque handle for "pay towards this child"; the internal studentId never leaves the server.
          students: sections,
          balanceCents: r.family.balanceCents,
          // What is actually PAYABLE — the open bills added up. It differs from `balanceCents` the
          // moment a sibling is in credit, because the household figure Students reports is a NET:
          // a family with one child £340 ahead and another £160 behind reports a £0 balance. This is
          // the number the pay button spends, and the server re-derives it at pay time.
          dueCents: dueCents(session),
          // 0.41.0: money already paid ahead. A zero balance means "square" or "paid ahead", and the
          // parent should see which — once an advance settles its invoice this is the only signal left.
          creditCents: r.family.creditCents,
          currency: r.family.currency,
          // The same bills as one flat list. Kept because a kiosk in the field may still be running an
          // APK that predates the per-child sections, and a tablet update is a separate errand from a
          // server update — that build reads this and keeps working unchanged.
          openInvoices: r.family.openInvoices.map(wireInvoice),
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
      // Ticked bill LINES (0.43.0 §11.0b) — "just the book fee". Ids come from the lookup and are
      // resolved against the held session, same as invoice ids.
      z.object({ kind: z.literal('items'), itemIds: z.array(z.string().max(128)).min(1).max(200) }),
      // A typed amount — a part payment, or money paid ahead when nothing is due (§11.0a). Bounds are
      // re-derived from the SESSION in computeTuitionAmount; this only keeps junk out of the maths.
      // `studentKey` is the opaque per-session handle for WHICH child the money is for.
      z.object({
        kind: z.literal('amount'),
        amountMinor: z.number().int().positive().max(MAX_TUITION_CENTS),
        studentKey: z.string().max(8).optional(),
      }),
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
    const sel = parsed.data.selection;
    const amt = computeTuitionAmount(
      session,
      sel.kind === 'amount' ? { kind: 'amount', amountCents: sel.amountMinor, studentKey: sel.studentKey } : sel,
    );
    if ('error' in amt) {
      // Say which rule stopped it — a floor or a school that doesn't take money ahead is something the
      // parent can act on, unlike a generic "invalid".
      const message =
        amt.error === 'below-min'
          ? `The smallest payment is ${formatMoney(session.minAmountCents, session.currency || store.getCurrency())}.`
          : amt.error === 'too-large'
            ? 'That amount is too large to take here — please see the office.'
            : amt.error === 'advance-not-allowed'
              ? 'This school isn’t taking payments in advance right now.'
              : amt.error === 'nothing-due'
                ? 'There’s nothing due to pay.'
                : amt.error === 'unknown-item' || amt.error === 'unknown-invoice' || amt.error === 'unknown-student'
                  ? 'That’s out of date — please look up the balance again.'
                  : 'Please choose what to pay.';
      return reply.code(400).send({ error: message });
    }
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
    // The child this charge is for: the one the parent picked on the "add money for…" pad when there
    // was one, else the student whose ID was typed.
    const chargeStudentId = amt.studentId || session.studentId;
    if (chargeStudentId) metadata.students_student_id = chargeStudentId;
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
        studentId: chargeStudentId,
        familyLabel: session.familyLabel,
        amountMinor: amt.amountCents,
        currency,
        allocations: amt.allocations,
        students: amt.students, // per-child split (v2); null for a pay-full charge
        lines: amt.lines, // the ticked bill lines (0.43.0); supersedes both of the above
      });
      return { data: { paymentIntentId: pi.id, clientSecret: pi.clientSecret, chargeMinor: amt.amountCents, currency } };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const why = `${e.code ?? ''} ${e.message ?? ''}`.trim().slice(0, 300);
      log.warn(`tuition payment-intent create failed: ${why}`);
      store.addLogs(d.id, [{ level: 'warn', event: 'tuition_pi_failed', detail: why.slice(0, 200) }]);
      // Same admin alert as a failed donation — parents can't pay tuition until it's fixed. Fail-soft.
      void fabricAlert('payment-failed', 'A tuition payment failed to start', 'Stripe rejected a payment setup — parents can’t pay tuition until it’s fixed. Check your Stripe keys/status in OpenMasjidOS → Settings → Payments.', 'error').catch(() => {});
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

  // Branded-receipt retry outbox: any succeeded donation still owing a branded receipt (a transient
  // email failure at /complete) is retried until it lands. Bounded to recent donations so we don't
  // chase ancient ones; stops the pass on a system failure (email provider down) and resumes next
  // tick. Only when the Fabric is configured (email goes through it). Never lets the app crash.
  if (ssoConfigured()) {
    const RECEIPT_MAX_AGE_MS = 3 * 24 * 3600_000; // 3 days — don't chase ancient ones
    // Don't retry a row younger than this: the inline send fired at /complete owns it for the few
    // seconds its fabricEmail POST is in flight (8s timeout). A floor comfortably past that closes
    // the double-send race where an outbox tick re-sends a receipt the inline send is mid-delivering.
    const RECEIPT_MIN_AGE_MS = 120_000; // 2 min
    const receiptOutbox = async () => {
      try {
        // Rows that have run out of road. Before this they simply stopped being selected once they
        // passed RECEIPT_MAX_AGE_MS and were abandoned at 'pending' for ever — and since we had
        // silenced Stripe at intent, those donors never received anything at all. Give the receipt
        // back to Stripe and close the row out.
        for (const don of store.listExpiredPendingReceipts(RECEIPT_MAX_AGE_MS)) {
          await handReceiptBackToStripe(don);
          store.setDonationReceipt(don.paymentIntentId, 'skipped');
        }
        for (const don of store.listPendingReceipts(RECEIPT_MAX_AGE_MS, RECEIPT_MIN_AGE_MS)) {
          const r = await sendDonationReceipt(don);
          if (r.sent) store.setDonationReceipt(don.paymentIntentId, 'sent');
          else if (!r.retry) {
            // Permanent here too — same reasoning as at /complete: never close a branded row
            // without making sure the donor gets *a* receipt from somewhere.
            await handReceiptBackToStripe(don);
            store.setDonationReceipt(don.paymentIntentId, 'skipped');
          } else break; // email provider down / rate-limited — try again next tick
        }
      } catch { /* fail soft — never let the receipt outbox crash the app */ }
    };
    setInterval(() => { void receiptOutbox(); }, 60_000).unref();
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
