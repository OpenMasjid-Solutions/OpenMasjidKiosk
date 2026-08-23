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
import { MAX_ALERT_RECIPIENTS, Store, grossUpForFees, type Device, type DonationRecord, type EmailReceipt, type PlanRecord } from './store';
import { COOKIE, cookieOptions, hashPassword, hashPin, makeDeviceToken, makePairingCode, makeToken, verifyPassword, verifyToken, SSO_SESSION_MS } from './auth';
import { notify, probePlatform, fetchAppearance, fetchFabricStripe, fetchFabricStripeAccounts, clearFabricStripeCache, fetchFabricSite, cachedFabricSite, fabricEmail, fabricAlert, fabricWhatsApp, fabricWhatsAppGroup, fabricWhatsAppGroups, fabricWhatsAppSuspect, fabricWhatsAppStatus, fabricWhatsAppOutcome, clearWhatsAppCache, emailStatus, emailCanSend } from './fabric';
import {
  ALERT_IDS,
  ALERT_META,
  DEFAULT_ROUTE,
  PACING_LIMITS,
  alertDelivery,
  alertEmailLooksValid,
  bodyForRecipient,
  groupIdLooksValid,
  isAlertId,
  newRecipient,
  pacingUsage,
  permitReasonText,
  phoneLooksValid,
  recipientsFor,
  recordWhatsAppSends,
  whatsappPermit,
  withSuppressedNote,
  type AlertId,
} from './alerts';
import { escapeHtml, renderMonthlyStarted, renderReceipt, renderRefund, type ReceiptContext } from './email';
import { studentsInfo, studentsIdentify, studentsLookup, recordStudentPayment, checkStudentPayment, createTuitionSession, getTuitionSession, computeTuitionAmount, studentKey, dueCents, billingConfigured, grossUpForStudentsFee, kioskFeeRate, MIN_TUITION_CENTS, MAX_TUITION_CENTS } from './students';
import { GlobalAttemptBudget, LoginLimiter } from './rateLimit';
import { authorizeCommandCall, buildCommands, findCommand, runCommand, tidyReply, validFollowUpToken } from './commands';
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

/** A kiosk that hasn't checked in within this window is reported offline. Check-ins are every 10s,
 *  so ~35s is three missed beats — long enough not to flap on one dropped packet. Module-level so
 *  the Devices page and the WhatsApp `kiosks` command can never disagree about who is online. */
const ONLINE_MS = 35_000;

/** The download filenames we hand the device — versioned so a stale cached copy is obvious.
 *  The URL paths stay stable at /download/openmasjidkiosk.apk and /download/openmasjidmobile.apk. */
const apkFilename = `openmasjidkiosk-${config.version}.apk`;
const mobileApkFilename = `openmasjid-mobile-donations-${config.version}.apk`;

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
  // FRAMING IS DENIED. This was deliberately left open by the 2026-08-04 audit, which could not
  // confirm whether OpenMasjidOS renders an installed app inside an iframe — and a framing denial
  // that broke the dashboard would have been worse than the clickjacking gap it closed. That is now
  // settled by reading the platform: `openApp()` in OpenMasjidOS `packages/ui/src/lib/apps.ts` calls
  // `window.open(target, '_blank', 'noopener,noreferrer')`, and the string "iframe" does not appear
  // anywhere in its source. The dashboard NAVIGATES to us; nothing frames us. So there is no
  // legitimate frame to break, and every surface here is worth protecting — the admin panel acts on
  // a session cookie, and the donor's cancel page is a one-press irreversible action.
  //
  // Both headers, on purpose: `frame-ancestors` is the modern rule and the only one that governs
  // nested/`<object>` embedding, while `X-Frame-Options` still covers browsers that never
  // implemented CSP level 2. They agree, so neither can weaken the other.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "frame-ancestors 'none'");
    reply.header('x-frame-options', 'DENY');
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

  // ── Admin commands from WhatsApp (platform → us) ────────────────────────────
  // The ONLY route the platform calls on us; everything else in fabric.ts is us calling it. An
  // admin messages the masjid's own WhatsApp number, the platform decides who may run what and
  // renders the menu from our manifest, and we are asked to execute one command we declared.
  //
  // Refused over the tunnel (tunnel.ts blocks all of /fabric), so the caller is always on the LAN.
  // See commands.ts for the two-header trust boundary and why an absent secret fails closed.
  //
  // `money` is passed as a closure rather than a value because formatMoney is defined further down
  // this function; it is only ever called while handling a request, long after startup.
  const commands = buildCommands({
    store,
    money: (minor, currency) => formatMoney(minor, currency),
    onlineWithinMs: ONLINE_MS,
  });
  app.post('/fabric/commands/run', async (req, reply) => {
    const auth = authorizeCommandCall(
      typeof req.headers['x-openmasjid-app-secret'] === 'string' ? (req.headers['x-openmasjid-app-secret'] as string) : undefined,
      typeof req.headers['x-openmasjid-caller-app'] === 'string' ? (req.headers['x-openmasjid-caller-app'] as string) : undefined,
      config.omosAppSecret,
    );
    if (!auth.ok) {
      // 503 for "we hold no secret": the platform is telling us to run something we were never
      // issued credentials for, which is a not-ready condition on THIS side, not a bad caller.
      if (auth.reason === 'not_configured') {
        return reply.code(503).send({ ok: false, code: 'not_ready', error: 'This app is not linked to OpenMasjidOS yet.' });
      }
      // Everything else is one flat 403 with no detail. Distinguishing "wrong secret" from "wrong
      // caller" on the wire would tell someone probing which half they had already got right.
      log.warn(`rejected a command call (${auth.reason})`);
      return reply.code(403).send({ ok: false, error: 'Not authorised.' });
    }

    const parsed = z
      .object({
        command: z.string().min(1).max(64),
        text: z.string().max(2000).optional(),
        requestId: z.string().max(120).optional(),
        locale: z.string().max(35).optional(),
        // The token WE handed back last turn. Shape-checked on the way IN as well as out: it
        // arrives in a request body and is compared against our own constants, so anything
        // malformed is simply not one of ours and starts a fresh turn.
        followUpToken: z.string().max(200).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'That command request wasn’t valid.' });

    const cmd = findCommand(commands, parsed.data.command);
    if (!cmd) {
      // 404 + unknown_command is the contract's own signal: the platform renders it rather than
      // leaving the sender with a menu entry that answers nothing.
      return reply.code(404).send({ ok: false, code: 'unknown_command' });
    }

    const token = parsed.data.followUpToken ?? '';
    const ctx = {
      text: (parsed.data.text ?? '').trim(),
      requestId: parsed.data.requestId ?? '',
      locale: parsed.data.locale ?? 'en',
      followUpToken: validFollowUpToken(token) ? token : '',
    };
    // The phone only ever gets a contentless apology, so this callback is the ONLY record that a
    // command threw. Without it a broken command is invisible on both ends at once.
    const result = await runCommand(cmd, ctx, (err) => log.error(`command ${cmd.id} threw:`, err));
    log.info(`command ${cmd.id} (${ctx.requestId || 'no id'}) -> ${result.ok ? 'ok' : 'failed'}`);
    if (!result.ok) return reply.code(200).send({ ok: false, error: tidyReply(result.error) });
    // Only echo a follow-up token we know the platform will accept. An invalid one is OUR bug, and
    // sending it would surface as a conversation that silently stops answering — the hardest thing
    // to diagnose from a chat window. Dropping it ends the exchange cleanly instead.
    const next = result.followUp?.token;
    if (next && !validFollowUpToken(next)) log.warn(`dropped a malformed follow-up token from ${cmd.id}`);
    return next && validFollowUpToken(next)
      ? { ok: true, text: tidyReply(result.text), followUp: { token: next } }
      : { ok: true, text: tidyReply(result.text) };
  });

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
      // The handheld app, offered beside the kiosk on /new. Checked separately: a build that
      // bundles one and not the other must offer exactly the one it has, never a dead button.
      mobileApkAvailable: fs.existsSync(config.mobileApkPath),
      mobileApkDownloadPath: '/download/openmasjidmobile.apk',
      mobileApkFilename,
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
  // ── Raising an alert: one entry point, many possible destinations ───────────
  // EVERY alert in this app goes through here rather than calling fabricAlert directly, so the
  // admin's choices (Settings → Notifications) are impossible to bypass by accident.
  //
  // The channels are ADDITIVE and independent, and each fails soft on its own. That is the whole
  // point: an alert exists to tell someone something is wrong, so one channel being broken must
  // never suppress the others, and none of them may ever disturb the donation, refund or reader
  // event that raised it. Hence every path is caught and nothing is awaited by the caller.
  //
  // The WhatsApp pacing ledger used to live in a Map here, in memory, on the argument that a
  // restart letting one extra message through is the safe direction to fail. That still holds for
  // the burst gap — but the admin can now set a DAILY cap, and an in-memory ledger would reset it
  // on every deploy, which on the dev channel is several times an afternoon. It is in the database
  // now (`store.getWhatsAppLedger`), and the burst gap rides along in the same record.

  /**
   * Ask the platform what became of a queued message, a little later (0.51.1+).
   *
   * Before this existed there was no way to find out: we were told `queued: true` and that was the
   * end of it. An admin whose alerts had silently stopped arriving had nothing to look at, and no
   * reason to suspect the platform rather than us — which is most of why this felt mysterious.
   *
   * Two quick goes for responsiveness: one after a minute (with the pacing gone, most messages are
   * sent within seconds) and one after ten. Anything still `queued` is then picked up by
   * [reconcileWhatsApp] below, which keeps asking for as long as the platform still has the record.
   *
   * THAT SECOND HALF IS NEW, and it exists because the reasoning here used to be wrong in a way
   * that only showed up once the platform changed. This gave up after ten minutes on the grounds
   * that "the platform keeps only the most recent 200 records" and that polling was not worth the
   * traffic. Both premises are gone as of 0.51.1-dev.8: the history is 500 PER APP kept for 24
   * hours (no other app can evict ours), and status reads have their own 600/min budget separate
   * from sending, so a poll can no longer cost a masjid an alert. Giving up at ten minutes left a
   * message that failed at twenty reading as `queued` in the admin panel for ever — which is
   * precisely the "accepted and silently lost" state this whole feature exists to end.
   *
   * Best-effort throughout. This is diagnostics; it must never disturb anything.
   */
  const scheduleWhatsAppFollowUp = (recipientId: string, alertId: AlertId, messageId: string): void => {
    const check = async (): Promise<boolean> => {
      const o = await fabricWhatsAppOutcome(messageId).catch(() => ({ state: 'unknown' as const, reason: undefined }));
      if (o.state === 'unknown' || o.state === 'queued') return false;
      const prev = store.getWhatsAppOutcomes()[recipientId];
      // Only overwrite the record we created — a newer message to the same recipient may have
      // replaced it while we were asking.
      if (prev && prev.messageId !== messageId) return true;
      store.setWhatsAppOutcome(recipientId, {
        state: o.state,
        at: Date.now(),
        messageId,
        reason: o.reason ?? '',
        suppressed: prev?.suppressed ?? 0,
        alertId,
      });
      if (o.state === 'failed' || o.state === 'expired') {
        log.warn(`WhatsApp for alert ${alertId} ended as ${o.state}${o.reason ? `: ${o.reason}` : ''}`);
      }
      return true;
    };
    setTimeout(() => {
      void check()
        .then((done) => {
          if (!done) setTimeout(() => void check().catch(() => {}), 9 * 60_000).unref();
        })
        .catch(() => {});
    }, 60_000).unref();
  };

  /**
   * Re-ask about anything still sitting at `queued`.
   *
   * At most one record per RECIPIENT — bounded by `MAX_ALERT_RECIPIENTS`, so at worst two dozen
   * reads a sweep against a 600/min read budget. Still far too small to matter, and it is what stops
   * a late failure being reported as `queued` for ever. Records older than the platform's 24-hour
   * window are left alone: it no longer has them, the lookup would 404, and `unknown` correctly
   * changes nothing.
   */
  const WA_HISTORY_MS = 24 * 60 * 60_000;
  const reconcileWhatsApp = async (): Promise<void> => {
    const now = Date.now();
    for (const [recipientId, rec] of Object.entries(store.getWhatsAppOutcomes())) {
      if (rec.state !== 'queued' || !rec.messageId) continue;
      if (now - rec.at > WA_HISTORY_MS) continue; // aged out of the platform's history
      const o = await fabricWhatsAppOutcome(rec.messageId).catch(() => ({ state: 'unknown' as const, reason: undefined }));
      if (o.state === 'unknown' || o.state === 'queued') continue;
      // Re-read: a newer message to this recipient may have replaced the record while we asked.
      const cur = store.getWhatsAppOutcomes()[recipientId];
      if (!cur || cur.messageId !== rec.messageId) continue;
      store.setWhatsAppOutcome(recipientId, {
        state: o.state,
        at: Date.now(),
        messageId: rec.messageId,
        reason: o.reason ?? '',
        suppressed: cur.suppressed,
        alertId: cur.alertId,
      });
      if (o.state === 'failed' || o.state === 'expired') {
        log.warn(`WhatsApp for alert ${cur.alertId || '?'} ended as ${o.state}${o.reason ? `: ${o.reason}` : ''} (late)`);
      }
    }
  };

  /**
   * Fan one alert out to every channel that wants it.
   *
   * THE ORDER OF BUSINESS: the OpenMasjidOS relay (per alert), then every subscribed email, then
   * every subscribed WhatsApp number and group. All of it is ADDITIVE and each leg fails soft on its
   * own — an alert exists to tell someone something is wrong, so one channel being broken must never
   * suppress another, and none of them may disturb the donation, refund or reader event that raised
   * it.
   *
   * `textWithoutNames` is the same message with the donor unnamed, and it is supplied by the CALL
   * SITE rather than derived here. Only two alerts need it (`donation-refunded`,
   * `monthly-cancelled`). Deriving it — regexing a name back out of finished prose — is the kind of
   * thing that works on the examples you tried it on and leaks on the one you did not.
   *
   * WHY THE WHATSAPP LEG IS THE COMPLICATED ONE. Ban risk attaches to the masjid's phone NUMBER,
   * that number is shared with every other app on the box, and a ban cannot be undone. So the
   * budget is checked before the loop, charged only for what actually went out, and every message
   * held back is counted so the next one that gets through can say how many were missed.
   */
  /**
   * Ask whether any WhatsApp we were told was `sent` may never have arrived.
   *
   * WHY THIS IS NOT AN HOURLY POLL, which is what the platform brief suggested. The endpoint
   * reports a window only while the platform's incident is still OPEN: `clearWhatsAppIncident()`
   * runs the moment an admin re-links the phone or releases the held queue, and from then on the
   * answer is `{windows: []}` for ever. So the window is visible during the outage and gone the
   * instant somebody fixes it — which is exactly when they would go looking for what they missed.
   * Polling hourly would be a coin flip on whether we ever see it. This rides the existing
   * 15-minute reconcile sweep, and whatever it sees is PERSISTED on sight, because there is no
   * asking again.
   *
   * WE DO NOT RESEND, and that is a domain decision rather than laziness. Every WhatsApp this app
   * sends is an ALERT about a moment: a reader went offline, a payment was refused, a donation was
   * refunded. Re-sending "the card reader is offline" a day late is worse than not sending it — the
   * reader is probably fine now, and the message would send someone to check hardware that works.
   * (This app also stores no message body, deliberately, so a faithful resend is not even possible.)
   * What IS useful is telling the admin which period is in doubt, so they can look at the Donations
   * and Devices pages themselves. That is what this records.
   *
   * Free of the send budget: this is on the platform's separate 600/min READ budget, so polling it
   * can never cost a masjid an actual alert.
   */
  const pollWhatsAppSuspect = async (): Promise<void> => {
    const r = await fabricWhatsAppSuspect().catch(() => ({ ok: false as const, reason: 'threw' }));
    if (!r.ok) return; // 404 = a platform too old to know; anything else is transient. Never an incident.
    for (const w of r.windows) {
      const isNew = store.addWhatsAppSuspectWindow(w.from, w.to, w.count);
      const flagged = store.markWhatsAppSuspect(w.from, w.to);
      if (isNew) {
        log.warn(
          `WhatsApp: the masjid's link was down from ${new Date(w.from).toISOString()} to ` +
            `${new Date(w.to).toISOString()} — ${w.count} message(s) reported sent may not have arrived ` +
            `(${flagged} of our records flagged). Shown in Settings -> Notifications.`,
        );
      }
    }
  };

  const raiseAlert = async (
    id: AlertId,
    title: string,
    text: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'warning',
    textWithoutNames?: string,
  ): Promise<{ os: boolean; email: number; whatsapp: number; reasons: string[] }> => {
    const route = store.getAlertRoutes()[id] ?? DEFAULT_ROUTE;
    const subscribed = recipientsFor(store.getAlertRecipients(), id);
    const reasons: string[] = [];
    let os = false;
    let email = 0;
    let whatsapp = 0;

    if (route.os) {
      const r = await fabricAlert(id, title, text, level).catch(() => ({ delivered: false, reason: 'threw' }));
      os = r.delivered;
      if (!r.delivered && r.reason) reasons.push(`OpenMasjidOS: ${r.reason}`);
    }

    // ── Email: no pacing, because there is nothing here to protect. A real provider, a real
    //    reputation that is not a single phone number, and no ban to be had.
    for (const r of subscribed.filter((x) => x.kind === 'email')) {
      // Plain text on purpose. An alert is one paragraph read on a phone at an awkward moment; a
      // branded HTML shell would add nothing and one more thing to render wrong.
      const body = bodyForRecipient(r, text, textWithoutNames);
      const sent = await fabricEmail({ to: r.address, subject: title, text: body }).catch(() => ({ sent: false, reason: 'threw' }));
      if (sent.sent) email += 1;
      else if (sent.reason) reasons.push(`email ${r.label || r.address}: ${sent.reason}`);
    }

    // ── WhatsApp: numbers and groups, inside one budget.
    const waTargets = subscribed.filter((x) => x.kind === 'phone' || x.kind === 'group');
    if (waTargets.length) {
      const pacing = store.getWhatsAppPacing();
      const now = Date.now();
      const permit = whatsappPermit(id, store.getWhatsAppLedger(), pacing, now);
      if (permit.allowed <= 0) {
        const why = permitReasonText(permit.reason, pacing);
        reasons.push(`WhatsApp: ${why}`);
        log.info(`alert ${id}: WhatsApp ${why}`);
        store.setWhatsAppLedger(recordWhatsAppSends(store.getWhatsAppLedger(), id, 0, now));
      } else {
        // The budget is in MESSAGES. When it cannot cover everyone, groups go first: one group send
        // reaches more people per message than any individual number, so under a squeeze it is the
        // channel that tells the most people. Say plainly who missed out rather than truncating in
        // silence.
        const ordered = [...waTargets].sort((a, b) => (a.kind === 'group' ? -1 : 0) - (b.kind === 'group' ? -1 : 0));
        const going = ordered.slice(0, permit.allowed);
        const skipped = ordered.length - going.length;
        if (skipped > 0) {
          reasons.push(`WhatsApp: ${skipped} recipient${skipped === 1 ? '' : 's'} not messaged — the hourly or daily limit was reached partway through`);
        }
        for (const r of going) {
          const body = withSuppressedNote(`${title}\n\n${bodyForRecipient(r, text, textWithoutNames)}`, permit.suppressedBefore);
          const sendIt =
            r.kind === 'group'
              ? fabricWhatsAppGroup(r.address, body)
              : fabricWhatsApp(r.address, body);
          const res = await sendIt.catch(() => ({ queued: false, id: undefined, reason: 'threw' }));
          if (res.queued) whatsapp += 1;
          // RECORD THE OUTCOME EITHER WAY, per recipient. A refusal used to reach nothing but a
          // debug line, so a message the platform rejected in a plain sentence — an unapproved
          // group, a number missing its country code, the masjid's own gateway number — looked
          // exactly like one that vanished into the queue. The settings screen reads this record and
          // shows the sentence on the row that caused it.
          store.setWhatsAppOutcome(r.id, {
            state: res.queued ? 'queued' : 'refused',
            at: Date.now(),
            messageId: res.queued ? (res.id ?? '') : '',
            reason: res.queued ? '' : (res.reason ?? 'refused'),
            suppressed: permit.suppressedBefore,
            alertId: id,
          });
          if (!res.queued && res.reason) reasons.push(`WhatsApp ${r.label || r.address}: ${res.reason}`);
          // Resolve queued -> sent/failed shortly afterwards, when the platform can say (0.51.1+).
          if (res.queued && res.id) scheduleWhatsAppFollowUp(r.id, id, res.id);
        }
        // Charge the budget for what was actually handed over, not for what was permitted.
        //
        // AND ONLY WHEN SOMETHING WENT. A run where every send was refused must leave the ledger
        // alone: nothing was handed over, so there is no budget to charge — and it is not
        // suppression either. Recording it as a hold would make the NEXT message say "3 alerts were
        // held back to protect the masjid's number" about three messages the platform rejected
        // outright, which is a confident, wrong answer to the one question the admin is asking.
        // Their real reasons are already on their rows.
        if (whatsapp > 0) {
          store.setWhatsAppLedger(recordWhatsAppSends(store.getWhatsAppLedger(), id, whatsapp, now));
        }
      }
    }

    if (reasons.length) log.warn(`alert ${id} partially undelivered — ${reasons.join('; ')}`);
    return { os, email, whatsapp, reasons };
  };

  // Fire-and-forget wrapper for the call sites that must never block on an alert.
  const alert = (
    id: AlertId,
    title: string,
    text: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'warning',
    textWithoutNames?: string,
  ): void => {
    void raiseAlert(id, title, text, level, textWithoutNames).catch(() => {});
  };

  // ── Notification settings: who gets told what ───────────────────────────────
  const alertsView = async () => {
    const routes = store.getAlertRoutes();
    const recipients = store.getAlertRecipients();
    // What actually became of the last WhatsApp to each RECIPIENT. Shown on the row that caused it,
    // because that is the only place the answer is any use — a refusal (unapproved group, missing
    // country code, the masjid's own gateway number) used to reach nothing but a debug log and was
    // indistinguishable from a message that simply vanished.
    const outcomes = store.getWhatsAppOutcomes();
    const pacing = store.getWhatsAppPacing();
    const wa = await fabricWhatsAppStatus();
    // Only ask for groups when WhatsApp is actually available — on a standalone install this would
    // be a guaranteed-failing request on every load of the screen.
    const groups = wa.available ? await fabricWhatsAppGroups() : ({ ok: false, reason: 'not-available' } as const);
    return {
      alerts: ALERT_META.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        carriesDonorIdentity: m.carriesDonorIdentity,
        os: (routes[m.id] ?? DEFAULT_ROUTE).os,
        delivery: alertDelivery(routes[m.id] ?? DEFAULT_ROUTE, recipients, m.id),
      })),
      recipients: recipients.map((r) => ({ ...r, lastWhatsApp: outcomes[r.id] ?? null })),
      maxRecipients: MAX_ALERT_RECIPIENTS,
      groups: groups.ok ? groups.groups : [],
      groupsProblem: groups.ok ? '' : groups.reason,
      pacing,
      pacingLimits: PACING_LIMITS,
      // Periods when the masjid's WhatsApp link was dead but messages were still being reported
      // sent. Persisted on sight because the platform stops reporting a window the moment the admin
      // re-links — see pollWhatsAppSuspect.
      suspectWindows: store.getWhatsAppSuspectWindows(),
      usage: pacingUsage(store.getWhatsAppLedger(), pacing, Date.now()),
      whatsapp: wa,
      embedded: ssoConfigured(),
      emailStatus: emailStatus(),
    };
  };
  app.get('/api/admin/alerts', { preHandler: requireAdmin }, async () => ({ data: await alertsView() }));

  /** The platform relay, per alert. The only thing still decided per alert rather than per person. */
  app.put('/api/admin/alerts/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = String((req.params as { id: string }).id || '');
    if (!isAlertId(id)) return reply.code(404).send({ error: 'No such notification.' });
    const parsed = z.object({ os: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Please check those details.' });
    store.setAlertRoute(id, parsed.data);
    await audit(req, 'alert-route-changed', id, `os=${parsed.data.os}`);
    return { data: await alertsView() };
  });

  app.post('/api/admin/alerts/recipients', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z
      .object({
        kind: z.enum(['email', 'phone', 'group']),
        address: z.string().min(1).max(200),
        label: z.string().max(80).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Please check those details.' });
    const { kind, address } = parsed.data;
    // Tell the admin WHY rather than saving a blank. A box that empties itself on save reads as the
    // app having lost the value, and they retype the very same thing.
    if (kind === 'email' && !alertEmailLooksValid(address)) {
      return reply.code(400).send({ error: 'That doesn’t look like an email address.' });
    }
    if (kind === 'phone' && !phoneLooksValid(address)) {
      return reply.code(400).send({ error: 'That number needs its country code and no leading zero — e.g. +1 555 010 1234.' });
    }
    if (kind === 'group') {
      if (!groupIdLooksValid(address)) return reply.code(400).send({ error: 'That isn’t a WhatsApp group.' });
      // Only a group the admin approved in OpenMasjidOS. The platform would refuse an unapproved one
      // with a 403 anyway, but refusing here means the admin finds out while they are looking at the
      // screen rather than when a real alert silently fails weeks later.
      const groups = await fabricWhatsAppGroups();
      if (!groups.ok) {
        return reply.code(503).send({ error: 'Couldn’t check your approved WhatsApp groups just now. Please try again.' });
      }
      if (!groups.groups.some((g) => g.id === address)) {
        return reply.code(400).send({ error: 'That group isn’t approved for apps in OpenMasjidOS → Settings → WhatsApp → Groups.' });
      }
    }
    const draft = newRecipient(kind, address, parsed.data.label ?? '');
    const row = store.addAlertRecipient(draft);
    if (!row) {
      const list = store.getAlertRecipients();
      return reply.code(400).send({
        error:
          list.length >= MAX_ALERT_RECIPIENTS
            ? `That’s the most recipients we can hold (${MAX_ALERT_RECIPIENTS}). To reach more people over WhatsApp, use a group — one message reaches everyone in it.`
            : 'That address is already on the list.',
      });
    }
    await audit(req, 'alert-recipient-added', row.id, `${row.kind}`);
    return { data: await alertsView() };
  });

  app.patch('/api/admin/alerts/recipients/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const rid_ = String((req.params as { id: string }).id || '');
    const parsed = z
      .object({
        label: z.string().max(80).optional(),
        alerts: z.array(z.string()).max(ALERT_IDS.length).optional(),
        includeNames: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Please check those details.' });
    const alertsPatch = parsed.data.alerts?.filter(isAlertId);
    const row = store.updateAlertRecipient(rid_, {
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      ...(alertsPatch ? { alerts: alertsPatch } : {}),
      ...(parsed.data.includeNames !== undefined ? { includeNames: parsed.data.includeNames } : {}),
    });
    if (!row) return reply.code(404).send({ error: 'That recipient is no longer on the list.' });
    await audit(req, 'alert-recipient-changed', row.id, `alerts=${row.alerts.length} names=${row.includeNames}`);
    return { data: await alertsView() };
  });

  app.delete('/api/admin/alerts/recipients/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const rid_ = String((req.params as { id: string }).id || '');
    if (!store.removeAlertRecipient(rid_)) return reply.code(404).send({ error: 'That recipient is no longer on the list.' });
    await audit(req, 'alert-recipient-removed', rid_, '');
    return { data: await alertsView() };
  });

  /** How hard we may lean on the masjid's WhatsApp number. Theirs to set — see alerts.ts. */
  app.put('/api/admin/alerts/pacing', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z
      .object({
        minGapMinutes: z.number().int().optional(),
        maxPerHour: z.number().int().optional(),
        maxPerDay: z.number().int().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter whole numbers.' });
    const next = store.setWhatsAppPacing(parsed.data);
    await audit(req, 'whatsapp-pacing-changed', '', `gap=${next.minGapMinutes}m hour=${next.maxPerHour} day=${next.maxPerDay}`);
    return { data: await alertsView() };
  });

  /** The admin has looked into a suspect window and is done with it. */
  app.delete('/api/admin/alerts/suspect/:from', { preHandler: requireAdmin }, async (req, reply) => {
    const from = Number((req.params as { from: string }).from);
    if (!Number.isFinite(from) || !store.dismissWhatsAppSuspectWindow(Math.trunc(from))) {
      return reply.code(404).send({ error: 'That period is no longer listed.' });
    }
    await audit(req, 'whatsapp-suspect-dismissed', String(Math.trunc(from)), '');
    return { data: await alertsView() };
  });

  app.post('/api/admin/alerts/whatsapp/refresh', { preHandler: requireAdmin }, async () => {
    clearWhatsAppCache();
    return { data: await alertsView() };
  });

  // In-app "send me a test": fire the declared `test` alert THROUGH THE SAME ROUTING as a real one,
  // so what it proves is the admin's actual configuration — not merely that the platform is up. A
  // test that took a different path would be the least useful kind of test.
  app.post('/api/admin/test-alert', { preHandler: requireAdmin }, async () => {
    const res = await raiseAlert(
      'test',
      'Test from OpenMasjid Kiosk',
      'If you received this, your kiosk notifications are reaching you on this channel. Nothing is wrong — you pressed Send test.',
      'info',
    );
    return { data: { ...res, delivered: res.os || res.email > 0 || res.whatsapp > 0 } };
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
  // defense-in-depth so the kiosk is never the open relay. Well above any real kiosk's lookup rate.
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
  // ONLINE_MS is module-level (top of file) so the WhatsApp `kiosks` command uses the same window.
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
        // A UI rotation in degrees ('0'/'90'/'180'/'270'); legacy named values are normalized in the store.
        orientation: z.string().max(20).optional(),
        // Which side the reader sits on ('off'/'left'/'right'); normalized in the store.
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
    store.setGiving(giving); // sanitizes (≤6 presets, sane bounds, known policies) + bumps configVersion
    if (attractTitle !== undefined) store.setAttractTitle(attractTitle.trim());
    if (masjidName !== undefined) {
      store.setMasjid({ name: masjidName.trim() });
      store.bumpConfigVersion(); // masjidName is in the kiosk config but setMasjid doesn't bump
    }
    return { data: { giving: store.getGiving(), currency: store.getCurrency(), masjidName: store.getMasjid().name, attractTitle: store.getAttractTitle() } };
  });

  // ── Campaigns (giving appeals shown as kiosk tabs) ───────────────────────────
  // Each campaign has its own amounts, color, background, thank-you, monthly/cover-fees, and
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
    // under-reported: "this plan has raised $X" being wrong by a month is the kind of number an
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
    // a short list needs to know it's short, not assume those donors canceled.
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
            ? `${unconfirmed} plan${unconfirmed === 1 ? '' : 's'} we set up couldn’t be found in Stripe — ${unconfirmed === 1 ? 'it was' : 'they were'} either canceled in the Stripe dashboard, or ${unconfirmed === 1 ? 'it lives' : 'they live'} on a Stripe account this app can no longer reach.`
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
    // The admin has to be told, or a donor gets their $10 back and is charged again in four weeks.
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

    // ── The admin: one alert, fanned out per Settings → Notifications (OpenMasjidOS, a direct
    //    email address, and/or WhatsApp — whichever they turned on for THIS alert) ──
    const refundAlertBody = (withNames: boolean): string =>
      [
        `${formatMoney(refund.amountMinor || want, after.currency)} was refunded to ${withNames ? after.donorName || 'a donor' : 'a donor'}${withNames && addr ? ` (${addr})` : ''}`,
        `from ${after.deviceName || 'the kiosk'}${after.campaignTitle ? ` · ${after.campaignTitle}` : ''}.`,
        fullyRefunded ? 'This was the full donation.' : `This was part of ${formatMoney(after.amountMinor, after.currency)}.`,
        addr ? (donorEmailed ? 'The donor has been emailed.' : 'The donor could NOT be emailed — please contact them.') : 'No donor email was given, so they have not been told.',
        monthlyStillLive
          ? 'NOTE: this donor has a MONTHLY plan. Refunding this payment does NOT cancel it — end it on the Recurring page if they asked to stop.'
          : '',
      ]
        .filter(Boolean)
        .join(' ');
    alert(
      'donation-refunded',
      'A donation was refunded',
      // TWO BODIES, and the second is not a nicety. A recipient can be a WhatsApp GROUP, and the
      // platform's rule for those is blunt: a group post must never carry one person's own
      // business, because everyone in a group can see everyone else's number. So the call site
      // builds the unnamed version too and `includeNames` on the recipient picks. Derived here
      // rather than regexed out of the finished sentence downstream, which is the version that
      // works on the examples you tried and leaks on the one you did not.
      refundAlertBody(true),
      'warning',
      refundAlertBody(false),
    );

    // The audit trail exists for "actions that reach outside the app". Refunding is the only admin
    // action that moves money OUT of the masjid's account, and it was the one financial write with
    // no entry — canceling a plan was recorded, giving $500 back was not. Recorded after the fact
    // on purpose: this row means "a refund happened", and Stripe has already confirmed it by here.
    await audit(
      req,
      'donation.refund',
      after.id,
      `${formatMoney(refund.amountMinor || want, after.currency)} of ${formatMoney(after.amountMinor, after.currency)} refunded` +
        `${fullyRefunded ? ' (in full)' : ' (part)'} · reason ${parsed.data.reason} · ${refund.refundId}`,
    );

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

  // ── The donor's own "stop my monthly donation" page ──────────────────────────
  // PUBLIC BY DESIGN, and the only public thing here that changes anything. It is reachable over the
  // masjid's Cloudflare tunnel because a donor is not on the masjid's wi-fi when they change their
  // mind — `/m/…` is not an `/api` path, and the cancel POST lives under `/api/public/`, both of
  // which the tunnel allowlist already permits (see tunnel.ts).
  //
  // What makes that safe:
  //   • the token is 256 bits of randomness and is stored ONLY as an HMAC, so reading the database
  //     does not let anyone cancel a donation;
  //   • it can do exactly one thing — end THIS plan. There is nothing here to read a donor list
  //     from, nothing to change an amount with, and no way to reach the admin API;
  //   • canceling is the safe direction. The worst a stolen link achieves is stopping a donation,
  //     which the donor can restart at the kiosk. Money can never move TO anyone through this;
  //   • the outbound Stripe traffic it can cause is bounded (donorLookups, below), and an unknown
  //     token gets the same answer as a used one.
  // Registered as an ENCAPSULATED plugin so the form-encoded body parser below exists for these two
  // routes and nowhere else.
  await app.register(async (donor) => {
    /**
     * Accept a plain HTML form submission.
     *
     * The cancel page is deliberately server-rendered with no JavaScript — a donor opening it from an
     * email on an unknown device should need nothing but a browser. A plain <form method="post"> sends
     * `application/x-www-form-urlencoded`, and this server only ever parses JSON, so Fastify rejected
     * the submission before the route ran:
     *
     *     415 FST_ERR_CTP_INVALID_MEDIA_TYPE — Unsupported Media Type
     *
     * The button looked right and did nothing useful. There are no fields to read (the token is in the
     * URL), so the body is discarded rather than parsed.
     *
     * Scoped to this plugin ON PURPOSE. Registering it globally would let every other POST route accept
     * a cross-origin form submission, and a form POST needs no CORS preflight — the admin API's only
     * other line of defense there is the SameSite=Lax cookie. Nothing outside these two routes gains
     * anything from urlencoded, so nothing outside them gets it.
     */
    donor.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => {
      done(null, {});
    });

    const PLAN_TOKEN_RE = /^[a-f0-9]{64}$/i;

    /** Statuses that mean "this is not collecting any more". `incomplete_expired` never got going. */
    const PLAN_OVER = new Set(['canceled', 'incomplete_expired']);

    /**
     * A ceiling on the outbound Stripe calls this public page can cause.
     *
     * Opening the page asks Stripe whether the plan is still live, so one link that reaches the wrong
     * hands — or simply a bot that follows every URL in a mailbox — turns unlimited page loads into
     * unlimited Stripe API calls, against the masjid's own account rate limit. Everything else about
     * the route is already cheap: an unknown token is a single indexed hash lookup and 404s before
     * any of this, so the budget only has to cover loads that present a REAL token.
     *
     * Deliberately a global counter and not a per-peer one: over the Cloudflare tunnel every donor
     * arrives from the same tunnel daemon, so a per-peer limit would lump them all together anyway.
     *
     * WHEN IT RUNS OUT NOBODY IS REFUSED. We skip the liveness check and show the button — exactly
     * what the page did before that check existed. A donor is never blocked from stopping a donation
     * to save an API call; the worst case is one press that turns out to be a no-op, and the POST
     * (which is the action that matters, and is far rarer) always checks properly.
     *
     * 120/min is far above real use — a donor opens this once — and far below anything Stripe minds.
     */
    const donorLookups = new GlobalAttemptBudget(120, 60_000);

    /**
     * Is this plan already finished, according to STRIPE? Unknown (unreachable, no account, no such
     * subscription) answers **false** on purpose: the cost of wrongly saying "already stopped" is a
     * donor walking away from a donation that is still running, which is the one outcome this whole
     * page exists to prevent. Wrongly showing the button costs a press that turns out to be a no-op.
     */
    const donorPlanIsOver = async (plan: PlanRecord): Promise<boolean> => {
      try {
        const acct = await resolveAccountById(plan.stripeAccountId);
        if (!acct) return false;
        const live = await retrievePlan(acct.keys.secretKey, plan.subscriptionId, { ownedLocally: true });
        // Gone from Stripe entirely — nothing is collecting, so it is over.
        if (!live) return true;
        return PLAN_OVER.has(live.status);
      } catch {
        return false;
      }
    };

    /** One page, two entry points: opening a spent link, and pressing a button that had already run. */
    const alreadyStoppedPage = (money: string): string =>
      cancelPage(
        `<h1>This monthly donation has already stopped</h1>
         <p class="muted">Your ${escapeHtml(money)} monthly donation is no longer being collected, so there is nothing
         left to cancel — you do not need to do anything.</p>
         <p class="muted">Nothing you have already given is affected. If you would like to give again,
         you can set it up at the kiosk any time, and thank you for your support.</p>`,
        'Already stopped',
      );

  /** The shared page shell — plain server-rendered HTML, no SPA. A donor opening this from an email
   *  on an unknown device should get something that works with nothing but a browser. */
  const cancelPage = (body: string, title: string): string => {
    const m = store.getMasjid();
    const name = escapeHtml(m.name || 'Our masjid');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;background:#f4f6f9;color:#16242b;font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
 .wrap{max-width:520px;margin:0 auto;padding:32px 16px}
 .card{background:#fff;border:1px solid #e6eaed;border-radius:14px;padding:28px 26px}
 h1{margin:0 0 6px;font-size:20px}
 .masjid{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#9aa7af;margin:0 0 18px}
 dl{margin:18px 0;padding:0;font-size:15px}
 dt{color:#7a8892;font-size:13px;margin-top:12px}
 dd{margin:2px 0 0;font-weight:600}
 button{width:100%;margin-top:22px;padding:13px;font:inherit;font-weight:600;border:0;border-radius:10px;background:#b3261e;color:#fff;cursor:pointer}
 button:disabled{opacity:.6;cursor:default}
 .muted{color:#7a8892;font-size:14px}
 .ok{color:#1f7a5c;font-weight:600}
 @media(prefers-color-scheme:dark){body{background:#0f1720;color:#e7edf3}.card{background:#16202b;border-color:#243240}.muted,.masjid,dt{color:#9fb0bf}}
</style></head><body><div class="wrap"><div class="card">
<p class="masjid">${name}</p>
${body}
</div></div></body></html>`;
  };

  donor.get('/m/:token', async (req, reply) => {
    const token = String((req.params as { token: string }).token || '');
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store');
    // Never let a cancel page be indexed or previewed — the link IS the credential.
    reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
    const plan = PLAN_TOKEN_RE.test(token) ? store.getPlanByCancelToken(token) : null;
    if (!plan) {
      return reply.code(404).send(
        cancelPage(
          `<h1>This link doesn’t work any more</h1>
           <p class="muted">It may already have been used to stop the donation, or it may have been mistyped.
           If you’re not sure whether your monthly donation is still running, please contact the masjid.</p>`,
          'Link not found',
        ),
      );
    }
    const money = formatMoney(plan.firstAmountMinor, plan.currency);

    // ALREADY STOPPED? Say so, rather than offering a button that would do nothing. A donor keeps this
    // email; they may well open the link again months later, or a second time because the first press
    // was not obviously acknowledged. Showing them "Stop your monthly donation" for a donation that
    // already stopped invites them to press it and wonder whether it worked either time.
    //
    // Asked live because Stripe is the truth: the plan may also have been ended from the admin panel,
    // or by the masjid in Stripe's own dashboard, neither of which touches our row. If Stripe cannot
    // be reached — or the lookup budget above is spent — we fall through and show the button. A donor
    // who wants to stop must never be blocked by our uncertainty, and the POST re-checks anyway.
    if (donorLookups.retryAfterMs() === 0) {
      donorLookups.fail();
      if (await donorPlanIsOver(plan)) return reply.send(alreadyStoppedPage(money));
    }

    return reply.send(
      cancelPage(
        `<h1>Stop your monthly donation</h1>
         <p class="muted">This ends the repeating payment. Nothing you have already given is affected, and you can start again at the kiosk whenever you like.</p>
         <dl>
           <dt>Amount</dt><dd>${escapeHtml(money)} each month</dd>
           ${plan.campaignTitle ? `<dt>Fund</dt><dd>${escapeHtml(plan.campaignTitle)}</dd>` : ''}
           <dt>Started</dt><dd>${escapeHtml(fmtReceiptDate(plan.createdAt))}</dd>
         </dl>
         <!-- RELATIVE, and one level up on purpose. The browser resolves this against the page's own
              address, which differs by route: on the LAN it is /m/<token>, and over the tunnel the OS
              forwards the full prefix so it is /<basePath>/m/<token>. "../api/…" lands on /api/… and
              /<basePath>/api/… respectively — both correct. A leading slash would break the tunnel
              case, and a bare "api/…" would resolve to /m/api/… and 404. -->
         <form method="post" action="${escapeHtml(`../api/public/monthly/${token}/cancel`)}">
           <button type="submit">Stop my monthly donation</button>
         </form>`,
        'Stop your monthly donation',
      ),
    );
  });

  donor.post('/api/public/monthly/:token/cancel', async (req, reply) => {
    const token = String((req.params as { token: string }).token || '');
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
    const plan = PLAN_TOKEN_RE.test(token) ? store.getPlanByCancelToken(token) : null;
    if (!plan) {
      return reply.code(404).send(cancelPage(`<h1>This link doesn’t work any more</h1><p class="muted">Please contact the masjid if you need help.</p>`, 'Link not found'));
    }
    // Already stopped — by an earlier press of this same link, by the admin panel, or in Stripe's own
    // dashboard. Say so plainly instead of "we've stopped it", which would credit this press with
    // something it didn't do, and instead of an error, which would suggest it is still running.
    // No alert is raised either: nothing changed, so there is nothing to tell the masjid.
    if (await donorPlanIsOver(plan)) {
      return reply.send(alreadyStoppedPage(formatMoney(plan.firstAmountMinor, plan.currency)));
    }
    const acct = await resolveAccountById(plan.stripeAccountId).catch(() => null);
    // immediately: the donor has already given this month at the kiosk and the next charge is still
    // ahead, so “stop it” means stop it — there is no remaining paid period to run out.
    const done = acct
      ? await cancelPlan(acct.keys.secretKey, plan.subscriptionId, true).then(() => true).catch(() => false)
      : false;
    if (!done) {
      // Never claim it stopped when it didn't — the donor would walk away and be charged again.
      return reply.code(502).send(
        cancelPage(
          `<h1>We couldn’t stop it just now</h1>
           <p class="muted">Something went wrong at our end and your monthly donation is still running.
           Please try this link again shortly, or contact the masjid and they will stop it for you.</p>`,
          'Couldn’t stop the donation',
        ),
      );
    }
    log.info(`donor canceled plan ${plan.subscriptionId} via their own link`);
    // Tell the masjid: a standing order ending is something an admin should know about, and the donor
    // did it outside the admin panel so nothing else would ever surface it.
    alert(
      'monthly-cancelled',
      'A donor stopped their monthly donation',
      `${plan.donorName || 'A donor'}${plan.donorEmail ? ` (${plan.donorEmail})` : ''} stopped their ${formatMoney(plan.firstAmountMinor, plan.currency)}/month donation${plan.campaignTitle ? ` to ${plan.campaignTitle}` : ''} using the link in their confirmation email. Nothing further will be collected.`,
      'info',
      // The same sentence with nobody named — for a recipient (typically a group) set not to
      // carry donor identity. See the note at the donation-refunded call site.
      `A donor stopped their ${formatMoney(plan.firstAmountMinor, plan.currency)}/month donation${plan.campaignTitle ? ` to ${plan.campaignTitle}` : ''} using the link in their confirmation email. Nothing further will be collected.`,
    );
    return reply.send(
      cancelPage(
        `<h1 class="ok">Your monthly donation has stopped</h1>
         <p class="muted">Nothing more will be taken. Thank you for what you have already given —
         you can start again at the kiosk any time.</p>`,
        'Monthly donation stopped',
      ),
    );
  });

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
        alert('reader-offline', 'Card reader back online', `The card reader on ${deviceName || 'a kiosk'} is connected again — donations can be taken.`, 'info');
      }
      readerAlert.set(deviceId, { offlineSince: null, alerted: false, everConnected: true });
      return;
    }
    if ((status === 'not_connected' || status === 'error') && everConnected) {
      const offlineSince = st.offlineSince ?? now;
      if (!st.alerted && now - offlineSince >= READER_OFFLINE_DEBOUNCE_MS) {
        alert('reader-offline', 'Card reader offline', `The card reader on ${deviceName || 'a kiosk'} stopped responding — donations can't be taken until it's back. Check the reader is powered on and paired.`, 'warning');
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
  /**
   * The Terminal Location for a Stripe account, creating one the first time that account is used.
   *
   * A Location belongs to ONE account, so a second account needs its own before a reader can be
   * registered against it. The admin already names/addresses a Location for the primary account on
   * the Payments screen; making a donor wait for that to be repeated per account would be a poor
   * trade, so a secondary account gets one created from the same masjid details, once, and remembered.
   */
  const locationForAccount = async (acct: ResolvedAccount): Promise<string> => {
    const key = acct.id === '' ? '' : acct.id;
    const existing = store.getLocation(key);
    if (existing) return existing.id;
    // Reuse the masjid address the admin already gave for the primary account's Location — the same
    // building, just registered on a second Stripe account. Without a usable address we throw, and the
    // caller falls back to whatever Location is stored rather than blocking the donation here.
    const m = store.getMasjid();
    const a = m.address;
    if (!a?.line1 || !a?.country) throw new Error('no masjid address for a Terminal location');
    const created = await createLocation(acct.keys.secretKey, (m.name || 'Masjid kiosk').slice(0, 160), {
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      postalCode: a.postalCode,
      country: a.country,
    });
    store.setLocation({ id: created.id, name: created.displayName }, key);
    return created.id;
  };

  /**
   * Mint a Terminal connection token — for a SPECIFIC Stripe account when the tablet names one.
   *
   * The token is what binds a reader to an account: connect with the primary account's token and the
   * reader cannot collect a PaymentIntent belonging to another account, which is why a campaign that
   * settles elsewhere used to be keyed-entry only. The tablet now asks for a token for the campaign
   * it is about to take money for, and re-registers the reader when that differs from the last one.
   *
   * `campaignId` omitted → the primary account, exactly as before, so an older tablet is unaffected.
   */
  const ConnTokenBody = z.object({ campaignId: z.string().max(120).optional() });
  app.post('/api/kiosk/connection-token', async (req, reply) => {
    const d = authDevice(req, reply);
    if (!d) return;
    const parsed = ConnTokenBody.safeParse(req.body ?? {});
    const campaignId = parsed.success ? (parsed.data.campaignId ?? '').trim() : '';
    const campaign = campaignId ? store.getCampaign(campaignId) : null;
    const acct = campaign?.stripeAccountId ? await resolveAccountById(campaign.stripeAccountId) : await resolveAccount();
    if (!acct) return reply.code(400).send({ error: 'Payments aren’t set up yet.' });
    try {
      const locationId = await locationForAccount(acct).catch(() => store.getLocation(acct.id)?.id);
      const secret = await createConnectionToken(acct.keys.secretKey, locationId);
      // The tablet needs to know WHICH account this token registers the reader to, so it can tell
      // when the next donation needs a different one. An account id is not a secret.
      return { data: { secret, accountId: acct.id, locationId: locationId ?? '' } };
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
  /**
   * The donor's public "stop my monthly donation" link, or '' when there is nowhere to point them.
   *
   * The address comes from the PLATFORM (Fabric `domain: true` → publicUrl), which is the masjid's
   * Cloudflare tunnel address — the same one remote kiosk adoption uses. We never guess it: a LAN
   * address in a donor's inbox is worse than no link, because it looks like it should work.
   */
  const donorCancelUrl = (token: string): string => {
    if (!token) return '';
    const pub = cachedFabricSite().publicUrl;
    return pub ? `${pub}/m/${token}` : '';
  };

  /**
   * Tell the donor their monthly giving is set up, and give them the way to stop it.
   *
   * Deliberately unconditional on the branded-receipt toggle: that setting is about receipts, and a
   * standing order is a commitment the donor must be told about regardless. Still needs the platform
   * to be able to send mail at all — with no provider there is simply no way to reach them, and the
   * admin alert already covers the masjid's side.
   */
  const sendMonthlyStartedEmail = async (paymentIntentId: string, token: string): Promise<void> => {
    const don = store.getDonationByPaymentIntent(paymentIntentId);
    if (!don) return;
    const addr = (don.donorEmail || '').trim();
    if (!looksLikeEmail(addr) || !emailCanSend()) return;
    // The first repeat charge is a month after the tap, matching what the subscription was given.
    const next = new Date(don.createdAt);
    const days = new Date(next.getFullYear(), next.getMonth() + 2, 0).getDate();
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    next.setDate(Math.min(day, days));
    const rendered = renderMonthlyStarted(store.getEmailReceipt(), {
      ...receiptContext(don),
      nextChargeDate: fmtReceiptDate(next.toISOString()),
      cancelUrl: donorCancelUrl(token),
    });
    await fabricEmail({ to: addr, subject: rendered.subject, text: rendered.text, html: rendered.html });
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
    // Donor opted to cover the estimated card fee (only honored if the campaign allows it).
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
    // NOTE: a cross-account campaign is no longer refused the reader here. A tablet that supports it
    // re-registers the reader against THIS campaign's Stripe account before collecting (see
    // ReaderManager.registerFor), so the old "primary account only" rule would now block something
    // that works. The campaign's account is already resolved above and 400s if it cannot be — which
    // is the check that actually matters. (`readerCapable` in the kiosk config is deliberately left
    // as it was, so an OLDER tablet still routes these to keyed entry rather than meeting a reader
    // registered to the wrong account.)
    //
    // Monthly giving needs name + email and the card reader — the reusable card comes from a
    // card-present charge, so it can't be set up from keyed entry.
    if (monthly) {
      if (manual) return reply.code(400).send({ error: 'Monthly giving needs the card reader.' });
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
      const create = (input: typeof piInput, key?: string) =>
        manual
          ? createCardPaymentIntent(acct.keys.secretKey, input, key)
          : createCardPresentPaymentIntent(acct.keys.secretKey, input, key);
      let pi: { id: string; clientSecret: string };
      try {
        pi = await create(piInput, idempotencyKey);
      } catch (err) {
        // SETTING UP MONTHLY MUST NEVER COST US THE DONATION. The card-saving fields (customer +
        // setup_future_usage) are the only thing here that a Stripe account can refuse while a plain
        // payment would have been accepted — an account without card-present saving enabled, a
        // restricted key, a currency or reader configuration Stripe won't save against. Failing the
        // whole request turns "we couldn't arrange monthly" into "Sorry — couldn't start the payment"
        // with the donor's card already out, which is what happened after dev.12.
        //
        // So on a monthly, fall back ONCE to the ordinary intent. The gift goes through as a one-off,
        // /complete reports that the standing order couldn't be created, and the real Stripe reason is
        // in the device log instead of being swallowed by a dead-end error screen.
        if (!monthlyCustomer) throw err;
        const e = err as { code?: string; type?: string; message?: string };
        const why = `${e.code ?? e.type ?? ''} ${e.message ?? ''}`.trim().slice(0, 300);
        log.warn(`monthly intent rejected, retrying as one-off: ${why}`);
        store.addLogs(d.id, [
          { level: 'warn', event: 'monthly_intent_rejected', detail: `Stripe refused the card-saving payment; taking it as a one-off instead · ${why}` },
        ]);
        alert(
          'monthly-failed',
          'Monthly donations are not being set up',
          `Stripe refused to set up a repeat payment at ${d.name || 'the kiosk'}, so this gift was taken as a ONE-OFF instead. Donors choosing "Monthly" are being charged once and no standing order is created. Reason: ${why}`,
          'warning',
        );
        // A DIFFERENT idempotency key: same key + different body is itself a Stripe error, and this
        // body deliberately differs (no customer, no setup_future_usage).
        pi = await create(
          { ...piInput, customerId: undefined, setupFutureUsage: undefined },
          idempotencyKey ? `${idempotencyKey}_nosave` : undefined,
        );
      }
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
      alert('payment-failed', 'A donation payment failed to start', 'Stripe rejected a payment setup — donors can’t give until it’s fixed. Check your Stripe keys/status in OpenMasjidOS → Settings → Payments.', 'error');
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
      /** The donor's one-time cancel token — only set when a plan was created AND recorded. */
      let monthlyCancelToken = '';
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
            // The donor's own way out. Minted here, hashed at rest, and sent ONCE in the
            // "monthly is set up" email — a standing order keeps taking money long after the donor
            // has left the building, so stopping it must not depend on reaching the right volunteer.
            monthlyCancelToken = crypto.randomBytes(32).toString('hex');
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
                cancelTokenHash: store.hashCancelToken(monthlyCancelToken),
              });
            } catch (e) {
              monthlyCancelToken = ''; // nothing stored → the link would 404; don't promise one
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
        alert(
          'monthly-failed',
          'A monthly donation could not be set up',
          `${formatMoney(result.amountMinor, result.currency)} was taken once at ${d.name || 'the kiosk'}, but the donor's monthly plan could NOT be created, so nothing will be collected again and there is nothing to cancel. ${monthlyProblem} If the donor expected a standing order, please contact them.`,
          'warning',
        );
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
        // "Your monthly donation is set up", carrying the donor's own cancel link. Sent ONCE, on the
        // first recording, so a retried /complete can't email twice. Separate from the receipt on
        // purpose: the receipt is about the payment just taken, this is about the ongoing commitment
        // and the one message the donor needs to keep. Fire-and-forget — a mail failure must never
        // disturb a donation and a plan that both already exist.
        if (rec.firstRecord && monthly.created && monthlyCancelToken) {
          void sendMonthlyStartedEmail(id, monthlyCancelToken).catch(() => {});
        }
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
    } catch (e) {
      // LOG IT. This catch wraps the whole handler, not just the Stripe call — `recordDonation`,
      // the plan write, the receipt decision and the device log all run AFTER the money has been
      // captured. So the case it silently hid is the worst one this app has: Stripe took the
      // donation, something downstream threw, and the only trace anywhere was a 502 the donor's
      // tablet renders as "that didn't complete". No log line, no donation row, no alert.
      const why = e instanceof Error ? e.message : String(e);
      log.error(`/complete failed for ${id}: ${why}`);
      // The device log is what an admin actually reads when a donor says they were charged, so put
      // it where they will look — best-effort, and never allowed to mask the original failure.
      try {
        store.addLogs(d.id, [{ level: 'error', event: 'complete_failed', detail: `${id}: ${why.slice(0, 300)}` }]);
      } catch {
        /* the container log above still has it */
      }
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
      // The TUITION. `row.amountMinor` is stored net for exactly this reason (§11.3) — Students'
      // ledger holds tuition only, and a gross here reads as an overpayment.
      amountCents: row.amountMinor,
      // Informational, and omitted when the school absorbed the fee (the usual case).
      feeCents: row.feeMinor > 0 ? row.feeMinor : undefined,
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

  // Should the tuition tile show, and how is it labeled? (Cached ~5 min in students.ts.)
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
    // Max 32 to match the provider's own cap; normalized (case/spaces/hyphens) in students.ts.
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
    // The school's advance/floor policy AND its processing-fee rate, captured into the session so the
    // pay step validates and prices against the server's copy. Cached ~5 min alongside the tile label;
    // unavailable → no paying ahead, and no fee (the school absorbs it, exactly as before 0.51.0).
    //
    // Pinning the RATE to the session is what makes the quote binding: `info` is cached and an office
    // can change the rate, so reading it again at charge time could hand a parent a total they were
    // never shown. The rate they were quoted on is the rate they pay.
    const info = await studentsInfo();
    const policy = info.available
      ? { allowAdvance: info.info.allowAdvance, minAmountCents: info.info.minAmountCents, feeRate: kioskFeeRate(info.info) }
      : { allowAdvance: false, minAmountCents: MIN_TUITION_CENTS, feeRate: null };
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
      feeRate: policy.feeRate,
      // The children, in the SAME order the response lists them — the tablet addresses one by its
      // position (`s0`, `s1`) so "add $50 for Maryam" can name her ledger without the device ever
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
          // a family with one child $340 ahead and another $160 behind reports a $0 balance. This is
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
    // WHO PAYS STRIPE'S CUT (Students 0.51.0, §11.2). Off for almost every install, and off means
    // change nothing: charge the tuition, report the tuition. When it IS on, the payer covers it, so
    // the charge is grossed up and the two numbers part company from here on — `amt.amountCents` is
    // the TUITION for the rest of this handler, `chargeMinor` is what the card is asked for.
    //
    // The rate comes from the SESSION, captured at lookup, so the total quoted is the total charged.
    const { grossCents: chargeMinor, feeCents: feeMinor } = grossUpForStudentsFee(amt.amountCents, session.feeRate);
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
    // §11.3: whenever we grossed up, say by how much. This is NOT bookkeeping. Students' daily
    // reconciliation reads succeeded PaymentIntents a day later, on a job that never saw this request
    // and may by then find the setting switched off or the rate changed — without this key it cannot
    // tell a $103.30 charge covering $100 of tuition from a family who genuinely paid $103.30, and
    // credits the difference. An amount identifies nobody, so this breaks no metadata privacy rule;
    // the standing ban still holds and is enforced above — never a Student ID, never a child's name.
    if (feeMinor > 0) metadata.students_fee_cents = String(feeMinor);
    // The child this charge is for: the one the parent picked on the "add money for…" pad when there
    // was one, else the student whose ID was typed.
    const chargeStudentId = amt.studentId || session.studentId;
    if (chargeStudentId) metadata.students_student_id = chargeStudentId;
    const piInput = {
      amountMinor: chargeMinor, // the GROSS — what the card is asked for
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
        // The TUITION, deliberately — this row is what `record-payment` is built from, and
        // `amountCents` there has always meant what the family owed. A gross here would be booked
        // as an overpayment and sit as a credit eating into their next bill.
        amountMinor: amt.amountCents,
        feeMinor,
        currency,
        allocations: amt.allocations,
        students: amt.students, // per-child split (v2); null for a pay-full charge
        lines: amt.lines, // the ticked bill lines (0.43.0); supersedes both of the above
      });
      // The tablet renders its confirm screen from THESE numbers, not from a rate of its own — which
      // is the whole reason no rate is sent to the device. The total a parent is shown is by
      // construction the total the card is asked for.
      return {
        data: {
          paymentIntentId: pi.id,
          clientSecret: pi.clientSecret,
          chargeMinor, // gross = tuition + fee; what the reader will take
          tuitionMinor: amt.amountCents,
          feeMinor,
          currency,
        },
      };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const why = `${e.code ?? ''} ${e.message ?? ''}`.trim().slice(0, 300);
      log.warn(`tuition payment-intent create failed: ${why}`);
      store.addLogs(d.id, [{ level: 'warn', event: 'tuition_pi_failed', detail: why.slice(0, 200) }]);
      // Same admin alert as a failed donation — parents can't pay tuition until it's fixed. Fail-soft.
      alert('payment-failed', 'A tuition payment failed to start', 'Stripe rejected a payment setup — parents can’t pay tuition until it’s fixed. Check your Stripe keys/status in OpenMasjidOS → Settings → Payments.', 'error');
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
      // The outbox row is the only place that knows how the charge splits: `result.amountMinor` is
      // the PaymentIntent's amount, which is the GROSS whenever the payer covered the processing fee.
      const row = store.getTuitionOutbox(id);
      const feeMinor = row?.feeMinor ?? 0;
      const tuitionMinor = row?.amountMinor ?? result.amountMinor;
      if (result.succeeded) {
        await tryRecordTuition(id); // best-effort now; the outbox retries if Students is unreachable
        void notify({
          // Say what the SCHOOL is owed and what the processor took, separately. A single grossed-up
          // figure in a dashboard notification reads as tuition and quietly overstates every payment.
          text:
            feeMinor > 0
              ? `${formatMoney(tuitionMinor, result.currency)} tuition at ${d.name || 'the kiosk'} (${formatMoney(result.amountMinor, result.currency)} charged — the payer covered the ${formatMoney(feeMinor, result.currency)} processing fee).`
              : `${formatMoney(result.amountMinor, result.currency)} tuition payment at ${d.name || 'the kiosk'}.`,
          level: 'success',
        });
      }
      // `amountMinor` stays the CHARGE — it is what the card was debited and what the thank-you
      // screen shows — with the split beside it so the tablet can itemize the receipt line.
      return {
        data: {
          status: result.status,
          succeeded: result.succeeded,
          amountMinor: result.amountMinor,
          tuitionMinor,
          feeMinor,
          currency: result.currency,
        },
      };
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

  // ── Download the bundled OpenMasjid Mobile Donations APK (served by /new) ───
  // The handheld app for fundraising events. Reachable over the Cloudflare tunnel like the kiosk
  // APK is, and deliberately so: a volunteer standing at an event opens this server's public
  // address on their own phone, downloads, installs and pairs — without ever being on the LAN.
  app.get('/download/openmasjidmobile.apk', async (_req, reply) => {
    if (!fs.existsSync(config.mobileApkPath)) {
      return reply.code(404).send({ error: 'The mobile donations app isn’t available yet on this server.' });
    }
    const stat = fs.statSync(config.mobileApkPath);
    reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="${mobileApkFilename}"`)
      .header('content-length', String(stat.size))
      .header('cache-control', 'no-cache');
    return reply.send(fs.createReadStream(config.mobileApkPath));
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
  // safe URL-path charset (normBasePath), re-sanitized here defensively.
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
  // Resolve any WhatsApp still reading `queued`. Cheap (at most one read per alert id) and only
  // useful when the Fabric is there at all.
  if (ssoConfigured()) {
    setInterval(() => { void reconcileWhatsApp().catch(() => {}); }, 15 * 60_000).unref();
    // Same sweep, same cadence: ask whether the masjid's WhatsApp link was dead while we were being
    // told messages went out. Once at startup too — a restart is a common moment to have missed one.
    void pollWhatsAppSuspect().catch(() => {});
    setInterval(() => { void pollWhatsAppSuspect().catch(() => {}); }, 15 * 60_000).unref();
  }

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
