// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Admin commands run from WhatsApp (OpenMasjidOS `commands:` in manifest.yaml).
 *
 * WHY A KIOSK WANTS THIS. A kiosk is unattended hardware in a lobby. When the card reader stops
 * responding, the person who can fix it is usually not in the building, and today the only way to
 * find out is to open the admin panel on the masjid's LAN. An admin can now message the masjid's
 * own WhatsApp number and get an answer.
 *
 * WHAT THE PLATFORM OWNS, AND WE MUST NOT REBUILD. It decides who may run what, renders the
 * numbered menu from our manifest order, asks for confirmation, and formats the reply. We are
 * asked only to execute one command we declared, and to answer promptly.
 *
 * THE TRUST BOUNDARY. This is the first route in this app the PLATFORM calls, rather than one we
 * call on the platform. Everything else in fabric.ts is outbound and authenticates by presenting
 * our secret; here we are the one checking. Two independent facts must hold, and both are checked
 * in [authorizeCommandCall]:
 *
 *   1. `X-OpenMasjid-App-Secret` equals our OWN `OPENMASJID_APP_SECRET`.
 *   2. `X-OpenMasjid-Caller-App` is exactly `omos:platform` — a value that can never be an app id,
 *      because the colon is outside the charset app ids are validated against. It identifies the
 *      platform BY CONSTRUCTION rather than by an allow-list we would have to maintain.
 *
 * On top of that the route is refused over the Cloudflare tunnel (see tunnel.ts): the platform is
 * always on the same LAN, so there is no legitimate remote caller to lose, and a credential check
 * is the wrong last line of defense for something that can act on hardware.
 *
 * Everything here except [runCommand] is pure, so the rules are unit-tested rather than asserted
 * in a comment.
 */
import crypto from 'node:crypto';

/** Reply promptly — the platform gives up at 10s and a volunteer is watching a chat window. */
export const COMMAND_TIMEOUT_MS = 10_000;

/** Our own budget, comfortably inside the platform's 10s so WE decide the outcome and can say
 *  something useful, rather than having the connection cut mid-sentence. Mirrors the same
 *  reasoning as the tablet's payment timeout: whoever holds the shorter clock owns the error
 *  message, and a real explanation beats a generic timeout every time. */
export const COMMAND_BUDGET_MS = 8_000;

/** The platform trims to the message cap itself, but sending 1000 characters of anything to a
 *  phone is already a failure of judgement — so we cut it here and own the result.
 *
 *  This is the ONLY response cap we enforce, and it is what makes the platform's own 16 KB body
 *  limit unreachable: every reply goes through [tidyReply], so the largest body we can produce is
 *  this many characters plus a short JSON wrapper. (A `COMMAND_RESPONSE_CAP = 16 * 1024` used to
 *  sit here restating the platform's number; nothing ever read it, so it documented a check that
 *  did not exist. Removed 2026-08-17 — the real guarantee is this line.) */
export const COMMAND_TEXT_MAX = 1000;

/** The only caller this route ever accepts. Not an allow-list entry — a value no app id can hold. */
export const PLATFORM_CALLER = 'omos:platform';

/** Command ids the platform reserves for its own conversation flow. */
const RESERVED_IDS = new Set(['help', 'yes', 'no', 'cancel', 'stop']);

/** At most 12: a numbered menu longer than that does not fit in one WhatsApp message. */
export const MAX_COMMANDS = 12;

/** Follow-up tokens: `A-Za-z0-9._:-`, at most 128 characters. */
export const FOLLOWUP_TOKEN_MAX = 128;

/**
 * Is this a follow-up token the platform will accept back?
 *
 * We validate what we EMIT, not just what we receive. The token we return is echoed into a later
 * request body, so an ill-formed one is our bug arriving as a platform error — and the failure mode
 * is a conversation that silently stops answering, which is the hardest kind to diagnose from a
 * chat window. The route drops an invalid token rather than sending it, which ends the exchange
 * cleanly instead of half-opening one.
 */
export function validFollowUpToken(token: string): boolean {
  return typeof token === 'string' && token.length > 0 && token.length <= FOLLOWUP_TOKEN_MAX && /^[A-Za-z0-9._:-]+$/.test(token);
}

/**
 * Is this a command id the catalog build will accept?
 *
 * Mirrors the platform's rules so a bad id fails in `npm test` here rather than at the catalog
 * build, where the error arrives after a push and blocks a release. Kebab-case, and never all
 * digits — `!kiosk 2` must only ever mean "the second option on the menu", so a command that could
 * be typed as a number would make the menu ambiguous.
 */
export function validCommandId(id: string): boolean {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return false;
  if (/^\d+$/.test(id)) return false;
  return !RESERVED_IDS.has(id);
}

/** Constant-time string compare that does not leak length through an early return. */
function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export type CommandAuth =
  | { ok: true }
  /** `not_configured` is deliberately distinct: no secret means the platform never issued us one
   *  (standalone install, or a restore before the env is repopulated), which is a different thing
   *  from a caller presenting the wrong secret and must not read as an attack in the log. */
  | { ok: false; reason: 'not_configured' | 'bad_secret' | 'bad_caller' };

/**
 * Both headers, both required, no shortcuts.
 *
 * FAILS CLOSED when we hold no secret. An empty expected secret compared against an empty
 * presented header would otherwise "match", turning a standalone install — where
 * `OPENMASJID_APP_SECRET` is empty by design — into one where anyone on the LAN who can reach the
 * port may run admin commands by sending no credential at all.
 */
export function authorizeCommandCall(
  presentedSecret: string | undefined,
  callerApp: string | undefined,
  expectedSecret: string,
): CommandAuth {
  if (!expectedSecret) return { ok: false, reason: 'not_configured' };
  if (!presentedSecret || !sameSecret(presentedSecret, expectedSecret)) return { ok: false, reason: 'bad_secret' };
  if (callerApp !== PLATFORM_CALLER) return { ok: false, reason: 'bad_caller' };
  return { ok: true };
}

/**
 * Make a reply safe to hand to the platform.
 *
 * The platform strips control characters, collapses blank lines and trims to the cap — but it does
 * that to whatever we send, and "you cannot make one answer look like three messages" is a
 * property worth holding on our own side too, so a formatting bug here can never look like a
 * platform bug there. Newlines survive as single breaks; runs of blank lines do not.
 */
export function tidyReply(text: string): string {
  const cleaned = (text ?? '')
    // CRLF first, and on its own. Carriage return is deliberately NOT in the class below — it sits
    // between the tab and the newline we keep — so stripping before folding would leave a bare
    // return that some clients render as a line break and others as nothing at all.
    .replace(/\r\n?/g, '\n')
    // Control characters, keeping only newline and tab. A stray NUL or escape byte in a device
    // name a volunteer typed should never reach someone's phone. Written as escapes so this
    // source file stays plain ASCII-safe text rather than embedding the bytes it strips.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return cleaned.length > COMMAND_TEXT_MAX ? cleaned.slice(0, COMMAND_TEXT_MAX - 1).trimEnd() + '…' : cleaned;
}

/** What a command handler is given. Kept deliberately small — a command is an admin asking a
 *  question or pressing a button, not a request with a body. */
export interface CommandContext {
  /** The text the admin typed after the menu number, already trimmed. '' when none was given.
   *  On a follow-up turn this is their whole answer — no `!` prefix, no menu number. */
  readonly text: string;
  /** The platform's id for this run. Log it; it is how a report ties back to a chat message. */
  readonly requestId: string;
  /** BCP-47 from the platform. Replies are English today (the platform's own limitation) but the
   *  value is passed through so a handler can do better later without a contract change. */
  readonly locale: string;
  /** The token WE returned last turn, handed straight back. '' on the first turn of a command.
   *  It is the only state that survives between turns — the platform keeps nothing else — so
   *  whatever a flow needs to remember has to be encoded in it. */
  readonly followUpToken: string;
}

/**
 * A command's outcome.
 *
 * `ok:false` is a real answer, not a crash — "no kiosk called lobby" is something the admin needs
 * told, and the platform renders it as such. It also ENDS any follow-up exchange, which is why the
 * type only allows `followUp` on the success side: a failed turn must never leave the sender's
 * ordinary conversation being captured as input.
 */
export type CommandResult =
  | { ok: true; text: string; followUp?: { token: string } }
  | { ok: false; error: string };

export interface KioskCommand {
  /** Must match the `id` declared in manifest.yaml exactly — that is what the platform sends. */
  readonly id: string;
  readonly run: (ctx: CommandContext) => Promise<CommandResult>;
}

/** Just enough of the Store for the commands below — narrow on purpose, so a handler cannot
 *  quietly grow into something that writes. Every command here is READ-ONLY. */
export interface CommandStore {
  getCurrency(): string;
  donationTotals(): {
    today: number;
    thisWeek: number;
    thisMonth: number;
    allTime: number;
    count: number;
    average: number;
    byDevice: { deviceId: string; deviceName: string; amountMinor: number; count: number }[];
  };
  listDevices(): { id: string; name: string; lastSeen: string; readerStatus: string; appVersion: string; revoked: boolean }[];
  listDonations(limit?: number): {
    deviceName: string;
    campaignTitle: string;
    amountMinor: number;
    /** What has been given back. `recent` must say so — every other figure this app reports is
     *  netted, so a refunded gift listed at its full amount is the one place the numbers lie. */
    refundedMinor: number;
    currency: string;
    kind: string;
    status: string;
    createdAt: string;
  }[];
}

export interface CommandDeps {
  store: CommandStore;
  /** Format minor units in the masjid's currency — the same helper the admin panel and receipts
   *  use, so a figure read out over WhatsApp matches the one on the screen exactly. */
  money: (minorUnits: number, currency: string) => string;
  /** A kiosk with no check-in inside this window is reported offline. Matches the Devices page. */
  onlineWithinMs: number;
}

/** How many recent donations `recent` lists. Small on purpose: this is a phone, and the question
 *  being asked is "is money still coming in", not "give me the ledger". */
const RECENT_LIMIT = 5;

/** Follow-up tokens used by `takings`. The step is IN the token because that is the only state
 *  that survives a turn — the platform stores nothing else about our flow. */
const TAKINGS_PICK = 'takings:pick';
const TAKINGS_RETRY = 'takings:pick2';

/** A short, human "when" for a chat message: today's times as times, then days, then dates. */
function whenShort(iso: string, now = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (t >= midnight.getTime()) return `${hhmm} today`;
  if (t >= midnight.getTime() - 86_400_000) return `${hhmm} yesterday`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "3 minutes ago" / "2 days ago" — how long since a kiosk was last heard from. */
function agoShort(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The reader status in plain words — the same wording the Devices page uses, so the two never
 *  describe the same reader differently. Anything unrecognized is passed through rather than
 *  flattened to "unknown", which would hide a status worth seeing. */
function readerWords(s: string): string {
  const map: Record<string, string> = {
    connected: 'reader connected',
    ready: 'reader ready',
    updating: 'reader updating',
    connecting: 'reader connecting',
    discovering: 'reader connecting',
    disconnected: 'NO READER',
    offline: 'NO READER',
    error: 'READER ERROR',
    not_connected: 'NO READER',
    none: 'no reader set up',
    '': 'no reader set up',
  };
  return map[(s || '').toLowerCase()] ?? `reader ${s}`;
}

/** Match what the admin typed against a kiosk name: exact first, then a unique prefix/substring,
 *  so "foy" finds "Foyer" but an ambiguous "k" finds nothing rather than the wrong one. */
export function matchKiosk<T extends { deviceName?: string; name?: string }>(typed: string, list: T[]): T | null {
  const q = typed.trim().toLowerCase();
  if (!q) return null;
  const nameOf = (x: T) => (x.deviceName ?? x.name ?? '').trim().toLowerCase();
  const exact = list.filter((x) => nameOf(x) === q);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((x) => nameOf(x).includes(q));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * THE COMMAND SET — read-only statistics, and nothing else.
 *
 * Every command here only READS. That is a deliberate first step rather than a limitation: it makes
 * the follow-up conversation safe by construction. The platform's exchange can end without telling
 * us — three minutes idle, twelve turns, the sender typing `cancel`, or simply starting another
 * command — and the standing warning is never to leave a half-applied change waiting on a reply
 * that may never come. A question that only reads has nothing to half-apply, so an abandoned
 * conversation costs exactly nothing and needs no draft, no expiry and no reconciliation.
 *
 * NO DONOR IDENTITY IS EVER SENT. Amounts, times, kiosks and funds only — never a name, an email or
 * a card. A WhatsApp thread keeps a copy forever on at least two phones, which is the same reason
 * the platform refuses to hand out app logs over this channel.
 */
export function buildCommands(deps: CommandDeps): KioskCommand[] {
  const { store, money, onlineWithinMs } = deps;
  const cur = () => store.getCurrency();

  /** The per-kiosk lines shared by the takings drill-down. */
  const kioskTakingsLine = (row: { deviceName: string; amountMinor: number; count: number }): string =>
    `${row.deviceName || 'Kiosk'} — ${money(row.amountMinor, cur())} from ${row.count} ${row.count === 1 ? 'gift' : 'gifts'}`;

  return [
    {
      // What's been given. The one an admin fires most, so it answers in full immediately rather
      // than asking anything first, and only THEN offers to narrow down.
      id: 'takings',
      run: async (ctx) => {
        const t = store.donationTotals();
        const c = cur();

        // ── A follow-up turn: they have named a kiosk (or not) ──
        if (ctx.followUpToken === TAKINGS_PICK || ctx.followUpToken === TAKINGS_RETRY) {
          const answer = ctx.text.trim();
          if (/^(all|everything|both)$/i.test(answer)) {
            const lines = t.byDevice.map(kioskTakingsLine);
            return { ok: true, text: lines.length ? `All time, by kiosk:\n${lines.join('\n')}` : 'No donations have been taken yet.' };
          }
          const hit = matchKiosk(answer, t.byDevice);
          if (hit) {
            return { ok: true, text: `${kioskTakingsLine(hit)} — all time.` };
          }
          // Unrecognized. Offer ONE more go (the step lives in the token), then stop rather than
          // keep capturing their conversation over a name we are not going to guess right.
          const names = t.byDevice.map((d) => d.deviceName || 'Kiosk').join(', ');
          if (ctx.followUpToken === TAKINGS_PICK) {
            return {
              ok: true,
              text: `I don't have a kiosk called "${answer}". Try one of: ${names}. Or reply "all".`,
              followUp: { token: TAKINGS_RETRY },
            };
          }
          return { ok: true, text: `Still no match. The kiosks are: ${names}. Run the command again when you know which one.` };
        }

        // ── First turn: the headline figures ──
        if (t.count === 0) return { ok: true, text: 'No donations have been taken yet.' };
        const head = [
          `Today: ${money(t.today, c)}`,
          `This week: ${money(t.thisWeek, c)}`,
          `This month: ${money(t.thisMonth, c)}`,
          `All time: ${money(t.allTime, c)} from ${t.count} gifts (average ${money(t.average, c)})`,
          '',
          'All figures are after refunds.',
        ].join('\n');
        // Only worth asking when there is more than one kiosk to choose between.
        if (t.byDevice.length > 1) {
          const names = t.byDevice.map((d) => d.deviceName || 'Kiosk').join(', ');
          return { ok: true, text: `${head}\n\nReply with a kiosk name for its own figures (${names}), or "all".`, followUp: { token: TAKINGS_PICK } };
        }
        return { ok: true, text: head };
      },
    },
    {
      // Are the kiosks working. THE question this whole channel exists for: unattended hardware in
      // a lobby, and the person who can fix it is not in the building.
      id: 'kiosks',
      run: async () => {
        const devices = store.listDevices().filter((d) => !d.revoked);
        if (!devices.length) return { ok: true, text: 'No kiosks are paired yet.' };
        const now = Date.now();
        const lines = devices.map((d) => {
          const seen = Date.parse(d.lastSeen);
          const online = Number.isFinite(seen) && now - seen < onlineWithinMs;
          const state = online ? 'online' : `OFFLINE (last seen ${agoShort(d.lastSeen, now)})`;
          return `${d.name || 'Kiosk'} — ${state}, ${readerWords(d.readerStatus)}, v${d.appVersion || '?'}`;
        });
        // Lead with the count that matters, so the answer is useful even if the list is long.
        const bad = devices.filter((d) => {
          const seen = Date.parse(d.lastSeen);
          const online = Number.isFinite(seen) && now - seen < onlineWithinMs;
          return !online || /disconnect|offline|error|not_connected/i.test(d.readerStatus || '');
        }).length;
        const head = bad === 0 ? `All ${devices.length} kiosk${devices.length === 1 ? '' : 's'} are fine.` : `${bad} of ${devices.length} need attention.`;
        return { ok: true, text: `${head}\n${lines.join('\n')}` };
      },
    },
    {
      // The last few donations — a different question from totals: "is it taking money right now?"
      // A quiet kiosk that still says "online" is the failure a total cannot show.
      id: 'recent',
      run: async () => {
        const rows = store
          .listDonations(200)
          .filter((d) => d.status === 'succeeded')
          .slice(0, RECENT_LIMIT);
        if (!rows.length) return { ok: true, text: 'No donations have been taken yet.' };
        const lines = rows.map((d) => {
          const bits = [money(d.amountMinor, d.currency), whenShort(d.createdAt)];
          if (d.deviceName) bits.push(d.deviceName);
          if (d.campaignTitle) bits.push(d.campaignTitle);
          if (d.kind === 'monthly') bits.push('monthly');
          // A gift that has been given back must not read as money still in the account. `takings`
          // is netted in SQL and the admin panel strikes these through; this line said neither.
          const back = d.refundedMinor ?? 0;
          if (back > 0) bits.push(back >= d.amountMinor ? 'REFUNDED' : `${money(back, d.currency)} refunded`);
          return bits.filter(Boolean).join(' · ');
        });
        return { ok: true, text: `The last ${rows.length}:\n${lines.join('\n')}` };
      },
    },
  ];
}

/** Look up a declared command. Uses a plain scan, not property access, so no prototype key
 *  (`toString`, `__proto__`) can ever resolve to something that is not a command we declared. */
export function findCommand(list: readonly KioskCommand[], id: string): KioskCommand | null {
  return list.find((c) => c.id === id) ?? null;
}

/**
 * Run a command inside our own time budget.
 *
 * A handler that overruns is reported as "still working" rather than left to hit the platform's
 * 10s cut-off, because a timed-out HTTP call tells the admin nothing while a sentence can tell
 * them to ask again in a moment. The handler is not canceled — there is nothing safe to cancel a
 * half-finished hardware action with — it simply stops being what we answer with.
 *
 * `onError` is how the real exception reaches the container log. It is a parameter rather than a
 * logger import so this module stays pure and unit-testable — and it is not optional-by-accident:
 * the phone gets a deliberately contentless sentence, so if nobody records the cause here, a
 * failing command is invisible everywhere. That was the case until it was noticed: the catch
 * swallowed the error entirely while the comment above it claimed the log had it.
 */
export async function runCommand(
  cmd: KioskCommand,
  ctx: CommandContext,
  onError?: (err: unknown) => void,
): Promise<CommandResult> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<CommandResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: 'That is taking longer than expected — it may still be working. Ask again in a moment.' }),
      COMMAND_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([cmd.run(ctx), budget]);
  } catch (err) {
    // Never leak an exception message to a phone: it can carry a Stripe id, a file path or a
    // device token. It goes to the container log instead — and a logging callback that itself
    // throws must not turn a handled failure into an unhandled one.
    try {
      onError?.(err);
    } catch {
      /* the reply below still stands */
    }
    return { ok: false, error: 'Something went wrong running that. Please check the admin panel.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
