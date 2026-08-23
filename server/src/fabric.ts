// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * OpenMasjidOS Fabric — single sign-on + notifications + Stripe (server→server), plus `domain`
 * (our public URL) for REMOTE kiosk adoption over the OS Cloudflare tunnel. Fabric calls stay
 * LAN-only (the OS refuses /api/fabric over the tunnel; we do too).
 *
 * When this app runs under OpenMasjidOS, the platform injects OPENMASJID_BASE_URL and a
 * per-app OPENMASJID_APP_SECRET, and the browser also sends the platform's `omos_session`
 * cookie to us (same host, different port = same-site). We NEVER trust that cookie
 * ourselves — we ask the platform to validate it, presenting our per-app secret so the
 * platform can confirm it's really us asking (identity-bound; it fails closed without it).
 *
 * Everything degrades gracefully: no base URL, no secret, no cookie, or an unreachable
 * platform all mean "no Fabric", and the app falls back to its own admin password.
 *
 * RESTORE/MIGRATION RESILIENCE (required): OPENMASJID_BASE_URL and OPENMASJID_APP_SECRET are
 * read from the environment on EVERY process start (config.ts) and NEVER persisted — the
 * platform rewrites the base URL when a backup is restored on a new machine and may rotate
 * the secret. Every call here fails soft (short timeout, redirect:'error'), so an
 * unreachable platform is "no Fabric this request", never a crash or a lock-out. The wire
 * identifiers (env vars, header, cookie, endpoints) are the shared contract — do not rename.
 */
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';

const log = makeLog('fabric');

export { ssoConfigured };

/** Is `host` a loopback / private / LAN address where sending our secret over plain HTTP is
 *  acceptable? Anything else is treated as PUBLIC (we err toward "public" if unsure). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.lan')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

let cleartextSecretWarned = false;
/** One-time warning when our per-app secret would be sent in cleartext to a PUBLIC host. The
 *  default LAN flow (http://openmasjidos.local, a 192.168.x.x box) is fine and stays silent. */
function warnIfCleartextSecret(): void {
  if (cleartextSecretWarned || !config.omosBaseUrl) return;
  let url: URL;
  try {
    url = new URL(config.omosBaseUrl);
  } catch {
    return;
  }
  if (url.protocol === 'https:') return;
  if (isPrivateHost(url.hostname)) return;
  cleartextSecretWarned = true;
  log.warn(
    `OPENMASJID_BASE_URL is a public address over plain http (${url.host}); this app's Fabric secret ` +
      `would be sent unencrypted. Over a trusted LAN, plain http is fine.`,
  );
}

export interface NotifyPayload {
  text: string;
  title?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
}

/** Relay a message to the masjid's configured webhook via the Fabric (server→server, with
 *  our per-app secret). FAILS SOFT: no platform / no secret / notifications off / any error
 *  → delivered:false and the app carries on. Never throws. */
export async function notify(payload: NotifyPayload): Promise<{ delivered: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { delivered: false, reason: 'no-fabric' };
  if (!payload.text?.trim()) return { delivered: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ text: payload.text, title: payload.title, level: payload.level ?? 'info' }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      log.warn(`Fabric notify not delivered: platform returned HTTP ${res.status}`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string };
    if (j.delivered !== true) {
      log.warn(`Fabric notify not delivered (reason: ${j.reason ?? 'unknown'}) — e.g. notifications not enabled in OpenMasjidOS.`);
    }
    return { delivered: j.delivered === true, reason: j.reason };
  } catch (err) {
    log.warn(`Fabric notify could not reach the platform: ${err instanceof Error ? err.message : String(err)}`);
    return { delivered: false, reason: 'unreachable' };
  }
}

// ── Fabric email (manifest `email: true`) — send a donor a receipt via the OS ──────
// The admin sets up ONE provider (SMTP/Resend) in OpenMasjidOS → Settings → Email; we send
// through the platform with our per-app secret and NEVER see the mail credentials or the From
// address. Server→server, LAN-only, not CORS-enabled. Fails soft: `not_configured` = the admin
// hasn't set up email yet → we just don't send (the donation is still recorded + Stripe's own
// receipt stays in place). NEVER throws; NEVER logs the recipient or the body.
export interface FabricEmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Last outcome of a Fabric email attempt, so the admin UI can show whether email is working in
 *  OpenMasjidOS WITHOUT sending a probe on every settings load. In-memory only (never persisted);
 *  resets to 'unknown' each process start per the restore-resilience rules — which is exactly why
 *  the receipt strategy must NOT require it to be 'ok'. See [emailCanSend]. */
export type EmailStatus = 'unknown' | 'ok' | 'not_configured' | 'rate_limited' | 'error' | 'no-fabric';
let lastEmailStatus: EmailStatus = 'unknown';
export function emailStatus(): EmailStatus {
  return lastEmailStatus;
}

/**
 * May we plan to send a branded receipt ourselves (and therefore suppress Stripe's)?
 *
 * This used to be `emailStatus() === 'ok'`, which could never be true. 'ok' is set in exactly one
 * place — a successful [fabricEmail] — and `fabricEmail` has exactly one caller, the branded-receipt
 * send, which only runs for donations already marked branded. Nothing could enter the cycle, and the
 * status resets to 'unknown' every process start anyway, so **no branded receipt has ever been sent**;
 * every donor silently got Stripe's built-in one instead, however the admin set the toggle.
 *
 * There is no probe to break the tie with: the platform's only email endpoint is a send
 * (POST /api/fabric/email), and it reports health solely as the outcome of a real message.
 *
 * So invert the default: assume we CAN until the platform says otherwise. 'not_configured' and
 * 'no-fabric' are the platform telling us plainly that no mail will ever leave, and those stick.
 * 'rate_limited' and 'error' are transient and must NOT latch — one bad night would otherwise turn
 * branded receipts off until the next restart.
 *
 * The safety property that gate was protecting — a donor never ends up with zero receipts — is kept,
 * but moved to where it can actually be enforced: if our own send fails for good, the caller asks
 * Stripe to send its receipt after the fact ([sendStripeReceipt]). Deciding up front could only ever
 * guess; deciding after the attempt knows.
 */
export function emailCanSend(): boolean {
  if (lastEmailStatus === 'not_configured' || lastEmailStatus === 'no-fabric') return false;
  // A provider that is CONFIGURED but broken (wrong SMTP password, a provider returning 401) reports
  // 'error' every time, which must not latch on its own — one blip would otherwise switch branded
  // receipts off until a restart, and nothing would switch them back on, since only a real send can
  // prove recovery. So count instead: after a run of failures, stop minting branded PaymentIntents
  // and let Stripe send, rather than silence Stripe for donation after donation that we then cannot
  // deliver. The retry outbox keeps working the already-pending rows, and the first of those to
  // succeed resets the counter and turns branded receipts straight back on.
  return consecutiveEmailFailures < EMAIL_FAILURE_LIMIT;
}

/** How many sends in a row may fail before we stop suppressing Stripe's receipt. Small, because
 *  each one is a real donor waiting on an email that is not coming. */
const EMAIL_FAILURE_LIMIT = 3;
let consecutiveEmailFailures = 0;

/** Send one email through the Fabric. Returns {sent} / {sent:false, reason}. NEVER throws;
 *  NEVER logs the recipient or the body (only a status code / reason on failure). */
export async function fabricEmail(msg: FabricEmailMessage): Promise<{ sent: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) {
    lastEmailStatus = 'no-fabric';
    return { sent: false, reason: 'no-fabric' };
  }
  if (!msg.to.trim() || !msg.subject.trim() || !msg.text.trim()) return { sent: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      lastEmailStatus = 'error';
      consecutiveEmailFailures++;
      return { sent: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { sent?: boolean; reason?: string };
    if (j.sent === true) {
      lastEmailStatus = 'ok';
      consecutiveEmailFailures = 0; // proven working — re-enable branded receipts immediately
      return { sent: true };
    }
    const reason = j.reason ?? 'unknown';
    lastEmailStatus = reason === 'not_configured' ? 'not_configured' : reason === 'rate_limited' ? 'rate_limited' : 'error';
    consecutiveEmailFailures++;
    return { sent: false, reason };
  } catch (err) {
    // Reached-but-failed / unreachable — NOT proof it's unconfigured, so don't claim so.
    log.debug(`Fabric email failed: ${err instanceof Error ? err.message : String(err)}`);
    lastEmailStatus = 'error';
    // COUNT IT. Every other failure path above increments; this one did not, and it is the most
    // likely failure there is — the platform being down or the request timing out. A breaker that
    // ignores "unreachable" never opens in the one situation it exists for: the server keeps
    // minting branded PaymentIntents, each of which suppresses Stripe's own receipt, so donors get
    // no receipt at all instead of falling back to Stripe's.
    consecutiveEmailFailures++;
    return { sent: false, reason: 'unreachable' };
  }
}

// ── Fabric alerts (manifest `alerts:`) — tell the ADMIN something's wrong ──────────
// The admin chooses the channel (email/webhook/both/off) per alert in OpenMasjidOS →
// Settings → Alerts; we never pick it. `alert` MUST be an id we declared in the manifest
// (or the platform 400s). Fails soft: `disabled_by_admin` (muted, or both channels off) is
// normal — never crash. This is the ONLY way we can reach the ADMIN (the platform never
// exposes the admin's email to us); donor receipts go via fabricEmail with the donor's address.
export async function fabricAlert(
  alert: string,
  title: string,
  text: string,
  level: 'info' | 'success' | 'warning' | 'error' = 'warning',
): Promise<{ delivered: boolean; reason?: string; email?: boolean; webhook?: boolean }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { delivered: false, reason: 'no-fabric' };
  if (!alert || !text.trim()) return { delivered: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/alert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ alert, title, text, level }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return { delivered: false, reason: `http_${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string; email?: boolean; webhook?: boolean };
    return { delivered: j.delivered === true, reason: j.reason, email: j.email, webhook: j.webhook };
  } catch (err) {
    log.debug(`Fabric alert failed: ${err instanceof Error ? err.message : String(err)}`);
    return { delivered: false, reason: 'unreachable' };
  }
}

// ── WhatsApp, through the platform's queue (manifest `whatsapp: true`) ──
// We never see the gateway, its credentials, or the masjid's number.
//
// WHAT THE PLATFORM USED TO DO FOR US, AND NO LONGER DOES (OpenMasjidOS 0.51.1). It used to pace
// everything: randomized gaps, per-recipient and per-group cooldowns, hourly and daily caps, a
// warm-up ramp on a new number, and quiet hours. All of that is gone. The only pause left is a
// typing indicator sized to the message. A message handed over now goes out within seconds.
//
// That removes a delay we were relying on without having decided to. Ban risk still attaches to the
// NUMBER, that number is shared by every app on the box, and a blocked number cannot be recovered —
// the masjid simply loses the number their community reaches them on. So the pacing is OUR job now:
// see `whatsappGate` in alerts.ts, which is what stops a Stripe outage turning forty failed
// donations into forty messages on one caretaker's phone.
//
// Two things that did NOT change: `202 { queued: true }` still means ACCEPTED, never delivered —
// there is no delivery receipt from WhatsApp — and nothing auth-critical may ever ride on it.
//
// What is NEW and worth using: the 202 carries an `id`, and `GET .../whatsapp/status/<id>` says
// what became of it. The queue is also persisted across restarts now; before 0.51.1 it lived in
// memory, so anything held for a retry was destroyed on every container restart while we had been
// told `queued: true`.

export type WhatsAppReason = 'ready' | 'not-configured' | 'not-linked' | 'unreachable';

export interface WhatsAppStatus {
  available: boolean;
  reason: WhatsAppReason;
  /** 0.51.1+: the platform can tell us what became of a message. ABSENT on an older platform, and
   *  an absent field must read as false — never assume the endpoint is there. */
  outcomes: boolean;
}

/** What became of one queued message. `queued` is the honest answer for most of a message's life. */
export type WhatsAppState = 'queued' | 'sent' | 'failed' | 'expired' | 'unknown';

export interface WhatsAppOutcome {
  state: WhatsAppState;
  /** Only on failed/expired, and only ever the platform's own words. */
  reason?: string;
}

let waCache: { at: number; value: WhatsAppStatus } | null = null;
const WA_CACHE_MS = 60_000;

/**
 * Can this masjid send WhatsApp at all?
 *
 * Asked before offering the feature, so a toggle is never live on an install where it could only
 * ever fail at the moment a real alert was due. Cached for a minute: the settings screen polls it
 * and a masjid does not link a phone twice a minute.
 */
export async function fabricWhatsAppStatus(force = false): Promise<WhatsAppStatus> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { available: false, reason: 'not-configured', outcomes: false };
  const now = Date.now();
  if (!force && waCache && now - waCache.at < WA_CACHE_MS) return waCache.value;
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    // A platform too old to know about WhatsApp 404s here. That is "not set up", not an error.
    if (!res.ok) {
      const value: WhatsAppStatus = { available: false, reason: res.status === 404 ? 'not-configured' : 'unreachable', outcomes: false };
      waCache = { at: now, value };
      return value;
    }
    const j = (await res.json().catch(() => ({}))) as { available?: boolean; reason?: string; outcomes?: boolean };
    const reason: WhatsAppReason =
      j.reason === 'ready' || j.reason === 'not-configured' || j.reason === 'not-linked' || j.reason === 'unreachable'
        ? j.reason
        : j.available === true
          ? 'ready'
          : 'not-configured';
    // `outcomes` is absent on a platform older than 0.51.1. Absent MUST read as false — asking a
    // platform that has no status endpoint just 404s every id and would look like "every message
    // failed", which is worse than not asking.
    const value: WhatsAppStatus = { available: j.available === true, reason, outcomes: j.outcomes === true };
    waCache = { at: now, value };
    return value;
  } catch (err) {
    log.debug(`Fabric whatsapp status failed: ${err instanceof Error ? err.message : String(err)}`);
    const value: WhatsAppStatus = { available: false, reason: 'unreachable', outcomes: false };
    waCache = { at: now, value };
    return value;
  }
}

/** Drop the cached availability so the next read re-asks (called when the admin presses Refresh). */
export function clearWhatsAppCache(): void {
  waCache = null;
}

/** A period during which the masjid's WhatsApp link was dead but the platform had not yet noticed,
 *  so messages were reported `sent` and never delivered. Epoch ms. */
export interface WhatsAppSuspectWindow {
  from: number;
  to: number;
  /** How many of OUR messages the platform reported sent inside it (scoped to this app). */
  count: number;
}

/**
 * Periods where a message we were told was `sent` may never have arrived (OpenMasjidOS 0.51.1-dev.12+).
 *
 * A masjid's WhatsApp session can expire on its own, the way WhatsApp Desktop signs itself out. The
 * gateway kept accepting messages and reporting them sent for over a day. The platform now spots
 * that within about ten minutes and holds messages instead — but the gap between the link dying and
 * the platform noticing is unrecoverable, and the platform cannot resend from it because it deletes
 * message contents the moment it hands them over. So it tells each app WHEN it was blind.
 *
 * READ THIS BEFORE CHANGING THE POLL INTERVAL. The platform returns a window only while its
 * incident is still open — `clearWhatsAppIncident()` fires the moment an admin re-links the phone
 * or releases the queue, and from then on this endpoint answers `{windows: []}` for ever. The
 * window is therefore visible during the outage and gone the instant somebody fixes it, which is
 * exactly when they would go looking. Anything we see must be PERSISTED on sight; there is no
 * re-reading it later.
 *
 * Fails soft. A 404 is a platform too old to have the route — "no information", never an incident.
 */
export async function fabricWhatsAppSuspect(): Promise<{ ok: true; windows: WhatsAppSuspectWindow[] } | { ok: false; reason: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { ok: false, reason: 'no-fabric' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/suspect`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: res.status === 404 ? 'not-supported' : `http_${res.status}` };
    const j = (await res.json().catch(() => null)) as { windows?: unknown } | null;
    // A 200 of the wrong shape is a failure, not "all clear". Reading a malformed answer as "no
    // problem" is precisely the silence this endpoint exists to break.
    if (!j || !Array.isArray(j.windows)) return { ok: false, reason: 'bad-shape' };
    const windows = j.windows
      .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
      .map((w) => ({
        from: Math.trunc(Number(w.from) || 0),
        to: Math.trunc(Number(w.to) || 0),
        count: Math.max(0, Math.trunc(Number(w.count) || 0)),
      }))
      .filter((w) => w.from > 0 && w.to >= w.from);
    return { ok: true, windows };
  } catch (err) {
    log.debug(`whatsapp suspect lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: 'unreachable' };
  }
}

/** One WhatsApp group the admin approved for apps to post into. `label` is the admin's own
 *  nickname for it — the group's real WhatsApp subject is deliberately never sent to us, so this is
 *  the only name there is and it should be shown as-is. */
export interface WhatsAppGroup {
  id: string;
  label: string;
}

/** `ok: false` distinguishes "we could not ask" from "nothing is approved" — see below. */
export type WhatsAppGroupList = { ok: true; groups: WhatsAppGroup[] } | { ok: false; reason: string };

/**
 * The groups this masjid's admin approved for apps to post into.
 *
 * The list is GLOBAL to the box, not per-app: every app with the `whatsapp` capability sees the same
 * approved set, and there is no per-app grant. An id we did not get from here is refused `403`, so
 * the admin panel offers this list as a picker rather than a text box.
 *
 * A 200 WHOSE BODY IS THE WRONG SHAPE IS A FAILURE, NOT AN EMPTY LIST. Reading a malformed answer as
 * "no groups approved" is how an admin's still-live subscription would silently look withdrawn, and
 * the screen would tell them to go and re-approve a group that was never un-approved. Same reason
 * `reason` exists at all: "couldn't ask" and "none approved" need different words on the screen.
 *
 * Fails soft — never throws. Logs the STATUS only: the body carries the masjid's own group
 * nicknames, which are theirs and not ours to write into a log file.
 */
export async function fabricWhatsAppGroups(): Promise<WhatsAppGroupList> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { ok: false, reason: 'no-fabric' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/groups`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      // 404 = a platform too old to have groups; 403 = we lack the `whatsapp` capability. Neither is
      // an error worth alarming anyone about, so this is one line at warn with no body.
      log.warn(`whatsapp groups unavailable (${res.status})`);
      return { ok: false, reason: res.status === 404 ? 'not-supported' : `http_${res.status}` };
    }
    const j = (await res.json().catch(() => null)) as { groups?: unknown } | null;
    if (!j || !Array.isArray(j.groups)) return { ok: false, reason: 'bad-shape' };
    const groups = j.groups
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object' && typeof (g as { id?: unknown }).id === 'string')
      .map((g) => ({
        id: String(g.id).slice(0, 64),
        // Fall back to the id rather than an empty row: a group with no nickname is still pickable.
        label: typeof g.label === 'string' && g.label ? g.label.slice(0, 120) : String(g.id),
      }));
    return { ok: true, groups };
  } catch (err) {
    log.debug(`whatsapp groups lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * Post ONE message into ONE approved group.
 *
 * A SEPARATE FUNCTION from [fabricWhatsApp], deliberately, and the separation is the enforcement
 * rather than a note in a document — the same wall OpenMasjidStudents draws for the same reason.
 * The platform's rule is that a group post is for genuine announcements and must never carry one
 * person's own business, "because their fees are not the other 199 members'". Here that is a donor:
 * everyone in a WhatsApp group can see every other member's phone number, so a refund notice posted
 * to a group of forty tells forty people who asked for their money back. [fabricWhatsApp] has no
 * parameter that could name a group, so a per-person message cannot reach one even by mistake.
 *
 * (Whether a group post names the donor at all is the admin's per-group choice — see
 * `AlertRecipient.includeNames`. This function's job is only to make the two channels distinct.)
 *
 * The wire shape is the same endpoint with `group` in place of `to`. Sending BOTH is a 400 by
 * design, which is another reason these are two functions and not one with an optional field.
 */
export async function fabricWhatsAppGroup(groupId: string, text: string): Promise<{ queued: boolean; id?: string; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { queued: false, reason: 'no-fabric' };
  if (!groupId.trim() || !text.trim()) return { queued: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ group: groupId, text }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      // A 403 here means specifically "that group is not approved (any more)" — an authorisation
      // answer, not a malformed request. The settings screen shows the sentence so an admin
      // re-approves the group rather than hunting for a bug in the message.
      log.warn(`whatsapp GROUP post REFUSED (${res.status}): ${j.error ?? '(no reason given)'}`);
      return { queued: false, reason: j.error || `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { queued?: boolean; id?: string; error?: string };
    const id = typeof j.id === 'string' && /^[\w.:-]{1,128}$/.test(j.id) ? j.id : undefined;
    return j.queued === true ? { queued: true, id } : { queued: false, reason: j.error || 'refused' };
  } catch (err) {
    log.debug(`whatsapp group post failed: ${err instanceof Error ? err.message : String(err)}`);
    return { queued: false, reason: 'unreachable' };
  }
}

/**
 * Queue one WhatsApp message to one person.
 *
 * ONE recipient per call, by the shape of the platform's API — the API discourages a blast, and so
 * does this. `to` must be digits in international form with no plus; the platform refuses a number
 * with no country code rather than guessing one, which is why [normalisePhone] refuses too.
 *
 * `queued: true` means ACCEPTED FOR LATER, not delivered. Fails soft in every case: an alert that
 * could not be queued must never disturb the donation, refund or reader event that raised it.
 */
export async function fabricWhatsApp(to: string, text: string): Promise<{ queued: boolean; id?: string; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { queued: false, reason: 'no-fabric' };
  if (!to.trim() || !text.trim()) return { queued: false, reason: 'empty' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmasjid-app-secret': config.omosAppSecret },
      body: JSON.stringify({ to, text }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      // WARN, not debug. A 400/403 here is the platform telling us in a plain sentence why this will
      // never work — an unapproved group, a number with no country code, our own gateway number. It
      // is the most useful line anyone will get, and at debug it was invisible on a real install.
      log.warn(`whatsapp send REFUSED (${res.status}): ${j.error ?? '(no reason given)'}`);
      return { queued: false, reason: j.error || `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { queued?: boolean; id?: string; error?: string };
    // The id is what makes "did that actually go?" answerable later — see [fabricWhatsAppOutcome].
    const id = typeof j.id === 'string' && /^[\w.:-]{1,128}$/.test(j.id) ? j.id : undefined;
    return j.queued === true ? { queued: true, id } : { queued: false, reason: j.error || 'refused' };
  } catch (err) {
    log.debug(`Fabric whatsapp send failed: ${err instanceof Error ? err.message : String(err)}`);
    return { queued: false, reason: 'unreachable' };
  }
}

/**
 * What became of a message we queued (OpenMasjidOS 0.51.1+).
 *
 * Scoped to our own app by the platform: another app's id 404s exactly like an unknown one, so a
 * 404 is never proof of anything except "not ours or gone". The records are bounded to the most
 * recent 200, which is why we poll shortly after sending rather than days later.
 *
 * Carries NO message text and NO recipient — just a state — so nothing here can leak a donor's or
 * an admin's details back out of the platform.
 *
 * Fails soft to `unknown`: this is diagnostics, and a diagnostic that throws is worse than one that
 * shrugs. `unknown` deliberately reads as "no news", never as failure.
 */
export async function fabricWhatsAppOutcome(id: string): Promise<WhatsAppOutcome> {
  if (!config.omosBaseUrl || !config.omosAppSecret || !id.trim()) return { state: 'unknown' };
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/status/${encodeURIComponent(id)}`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return { state: 'unknown' }; // 404 = not ours, unknown, or aged out of the ring
    const j = (await res.json().catch(() => ({}))) as { state?: string; reason?: string };
    const state: WhatsAppState =
      j.state === 'queued' || j.state === 'sent' || j.state === 'failed' || j.state === 'expired' ? j.state : 'unknown';
    const reason = typeof j.reason === 'string' ? j.reason.slice(0, 200) : undefined;
    return reason ? { state, reason } : { state };
  } catch (err) {
    log.debug(`whatsapp outcome lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return { state: 'unknown' };
  }
}

/** Pull the platform's session token out of the raw Cookie header. */
function omosCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = /(?:^|;\s*)omos_session=([^;]+)/.exec(cookieHeader);
  if (!m) return null;
  const token = m[1].trim();
  return /^[A-Za-z0-9._~%+/=-]{1,4096}$/.test(token) ? token : null;
}

interface CacheEntry {
  username: string;
  expires: number;
}
const positiveCache = new Map<string, CacheEntry>();
const CACHE_MS = 45_000;

export interface PlatformProbe {
  /** platform-confirmed username, or null if the visitor isn't signed in there */
  username: string | null;
  /** did we actually REACH the platform? false = not configured, network error, or timeout.
   *  Distinguishes "not signed in" from "OpenMasjidOS is down / wrong address" so the panel
   *  can offer the local-password recovery instead of looping. */
  reachable: boolean;
}

/** Validate the omos_session cookie present on THIS request (if any) AND report platform
 *  reachability. Only ever validates the cookie actually on the request. */
export async function probePlatform(cookieHeader: string | undefined): Promise<PlatformProbe> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { username: null, reachable: false };
  const token = omosCookie(cookieHeader);
  if (!token) return { username: null, reachable: await platformReachable() };

  const cached = positiveCache.get(token);
  if (cached && cached.expires > Date.now()) return { username: cached.username, reachable: true };

  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/auth/session`, {
      headers: {
        cookie: `omos_session=${token}`,
        // Identity-bound SSO: prove which app is asking. Without this the platform fails
        // closed. A credential — never logged.
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (res.ok) {
      const j = (await res.json()) as { authenticated?: boolean; username?: unknown };
      if (j.authenticated === true) {
        const username = (typeof j.username === 'string' ? j.username : '').trim().slice(0, 64) || 'OpenMasjidOS';
        positiveCache.set(token, { username, expires: Date.now() + CACHE_MS });
        if (positiveCache.size > 256) {
          for (const [k, v] of positiveCache) if (v.expires <= Date.now()) positiveCache.delete(k);
        }
        return { username, reachable: true };
      }
    }
    return { username: null, reachable: true };
  } catch (err) {
    log.debug(`platform session check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { username: null, reachable: false };
  }
}

/** Cheap "is the platform up?" check via its public, CORS-enabled appearance endpoint. Any
 *  response (even an error status) proves we reached it. */
export async function platformReachable(): Promise<boolean> {
  if (!config.omosBaseUrl) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

/** Fetch the platform's current appearance (theme/wallpaper/accent) server→server, so the
 *  browser (served over HTTPS) doesn't hit mixed-content calling the platform's plain-HTTP
 *  endpoint. Returns {} when standalone/unreachable. Never throws; never persists. */
export async function fetchAppearance(): Promise<Record<string, unknown>> {
  if (!config.omosBaseUrl) return {};
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Stripe via the Fabric (platform-vaulted keys) ───────────────────────────────
// The admin configures Stripe ONCE in OpenMasjidOS (Settings → Payments); every app shares
// it and the keys are backed up / migrated with the platform — never pasted per app. We
// fetch the chosen named account's keys server→server with our per-app secret and keep them
// IN MEMORY ONLY (never written to our data volume), so they always track the OS vault even
// across a restore-to-new-machine. The secret key is NEVER sent to the tablet/browser.

/** The shape the platform returns for a vaulted Stripe account. The secret is server-side
 *  only. (The platform may also send a webhookSecret; the kiosk has no webhooks, so we
 *  ignore it.) */
export interface FabricStripeAccount {
  id: string;
  label: string;
  publishableKey: string;
  secretKey: string;
}

interface StripeCache {
  at: number;
  account: string;
  value: FabricStripeAccount | null;
}
let stripeCache: StripeCache | null = null;
// The last account we successfully fetched, kept so a transient platform blip doesn't break
// live payments (we'd rather serve slightly-stale vault keys than fail).
let stripeLastGood: { at: number; account: string; value: FabricStripeAccount } | null = null;
const STRIPE_CACHE_MS = 60_000;
const STRIPE_LASTGOOD_MS = 10 * 60_000;

function parseFabricStripe(j: unknown): FabricStripeAccount | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const secretKey = typeof o.secretKey === 'string' ? o.secretKey : '';
  if (!secretKey) return null; // no secret = nothing usable
  return {
    id: typeof o.id === 'string' && o.id ? o.id : 'fabric',
    label: typeof o.label === 'string' && o.label ? o.label.slice(0, 80) : 'OpenMasjidOS account',
    publishableKey: typeof o.publishableKey === 'string' ? o.publishableKey : '',
    secretKey,
  };
}

/** Fetch a vaulted Stripe account from the platform (server→server). `accountName` is the
 *  admin-chosen account id; empty = the only/first account. Returns null when the Fabric
 *  isn't configured, the platform is unreachable (with no recent good copy), or it has no
 *  such account — callers then fall back to local keys. Caches in memory (~60s); on a
 *  transient error serves the last good copy (~10min). NEVER throws; NEVER persists. */
export async function fetchFabricStripe(accountName: string, force = false): Promise<FabricStripeAccount | null> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return null;
  const now = Date.now();
  if (!force && stripeCache && stripeCache.account === accountName && now - stripeCache.at < STRIPE_CACHE_MS) {
    return stripeCache.value;
  }
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const qs = accountName ? `?account=${encodeURIComponent(accountName)}` : '';
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe${qs}`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      stripeCache = { at: now, account: accountName, value: null };
      return null;
    }
    const value = parseFabricStripe(await res.json().catch(() => null));
    stripeCache = { at: now, account: accountName, value };
    if (value) stripeLastGood = { at: now, account: accountName, value };
    return value;
  } catch (err) {
    log.debug(`Fabric stripe fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    if (stripeLastGood && stripeLastGood.account === accountName && now - stripeLastGood.at < STRIPE_LASTGOOD_MS) {
      return stripeLastGood.value;
    }
    return null;
  }
}

/** Drop the in-memory Stripe-keys cache so the next fetch re-reads the OS vault (called when
 *  the admin changes the chosen account in-app). */
export function clearFabricStripeCache(): void {
  stripeCache = null;
  stripeLastGood = null;
}

export interface FabricStripeAccountRef {
  id: string;
  label: string;
}

/** List the masjid's Stripe accounts from the OS vault (id + label only, NEVER keys) so the
 *  admin can pick one on the Payments screen — keeps install one-click. Server→server,
 *  fail-soft → [] when the Fabric isn't configured / unreachable. Never throws. */
export async function fetchFabricStripeAccounts(): Promise<FabricStripeAccountRef[]> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return [];
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe/accounts`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const j = (await res.json().catch(() => null)) as { accounts?: unknown } | null;
    const list = Array.isArray(j?.accounts) ? j!.accounts : [];
    return list
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => ({ id: String(a.id), label: typeof a.label === 'string' && a.label ? a.label.slice(0, 80) : String(a.id) }));
  } catch (err) {
    log.debug(`Fabric stripe accounts list failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Public address (manifest `domain: true`) — for REMOTE KIOSK ADOPTION ──────────────
// When the admin turns on Remote access in OpenMasjidOS and exposes this app, the OS
// reverse-proxies https://omos.<domain>/<basePath>/… to us over its Cloudflare tunnel,
// forwarding the FULL path (it does NOT strip the prefix). So the server must be base-path
// aware (see index.ts rewriteUrl + HTML injection). We ask the platform for our public base
// instead of guessing, and show it on the "Add a remote kiosk" page. Never persisted; fails soft.

/** The platform's answer for this app's public address. `basePath` is normalized to a leading
 *  slash with no trailing slash (e.g. "/kiosk"), or "" when remote access is off. */
export interface FabricSite {
  enabled: boolean;
  domain: string;
  publicUrl: string;
  basePath: string;
}

const SITE_OFF: FabricSite = { enabled: false, domain: '', publicUrl: '', basePath: '' };

/** Normalize a path to "" or "/seg[/seg…]" (leading slash, no trailing slash). Restricted to a safe
 *  URL-path charset so the value we MATCH/STRIP (index.ts rewriteUrl) is byte-identical to the one we
 *  inject into `<base href>`/`window.__OMOS_BASE__` — no divergence, and no HTML-injection surface if
 *  the platform ever returned a hostile basePath. */
function normBasePath(raw: unknown): string {
  let p = (typeof raw === 'string' ? raw : '').trim();
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '').replace(/[^\w/-]/g, '');
}

let siteCache: { at: number; value: FabricSite } | null = null;
const SITE_CACHE_MS = 60_000;

function parseSite(j: unknown): FabricSite {
  if (!j || typeof j !== 'object') return SITE_OFF;
  const o = j as Record<string, unknown>;
  if (o.enabled !== true) return SITE_OFF;
  return {
    enabled: true,
    domain: typeof o.domain === 'string' ? o.domain : '',
    publicUrl: typeof o.publicUrl === 'string' ? o.publicUrl.replace(/\/+$/, '') : '',
    basePath: normBasePath(o.basePath),
  };
}

/**
 * Fetch this app's public address from the platform (server→server). Returns SITE_OFF when the
 * Fabric isn't configured, the platform is unreachable, or remote access is off — callers then
 * treat the app as LAN-only. Cached ~60s; on a transient error serves the last cached value so
 * base-path routing stays stable through a blip. NEVER throws; NEVER persists the domain/publicUrl.
 */
export async function fetchFabricSite(force = false): Promise<FabricSite> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return SITE_OFF;
  const now = Date.now();
  if (!force && siteCache && now - siteCache.at < SITE_CACHE_MS) return siteCache.value;
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/site`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    const value = res.ok ? parseSite(await res.json().catch(() => null)) : SITE_OFF;
    siteCache = { at: now, value };
    return value;
  } catch (err) {
    log.debug(`Fabric site fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    // Keep the last known base path stable through a transient outage so routing behind the
    // tunnel doesn't flap; only forget it after the cache window has lapsed a few times over.
    if (siteCache && now - siteCache.at < SITE_CACHE_MS * 5) return siteCache.value;
    return SITE_OFF;
  }
}

/** A FabricSite derived from the OPENMASJID_PUBLIC_URL env mirror (the intended exposure the platform
 *  injects immediately). Seeds the synchronous base path before the first /api/fabric/site fetch lands,
 *  so a freshly-exposed app strips the prefix from the very first tunnel request (no ~60s window). Empty
 *  when we're not exposed (the platform injects an empty value then). */
function envSite(): FabricSite {
  const u = config.omosPublicUrl;
  if (!u) return SITE_OFF;
  try {
    const url = new URL(u);
    return { enabled: true, domain: url.host, publicUrl: u, basePath: normBasePath(url.pathname) };
  } catch {
    return SITE_OFF;
  }
}

/** The last fetched site WITHOUT a network call — for the synchronous URL-rewrite hook that must
 *  decide, per request, whether to strip a base-path prefix. Once a fetch has resolved, that live
 *  value wins (it reflects actual routing); before then we fall back to the env mirror. */
export function cachedFabricSite(): FabricSite {
  return siteCache?.value ?? envSite();
}
