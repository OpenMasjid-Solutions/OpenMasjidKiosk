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
 * is the wrong last line of defence for something that can act on hardware.
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

/** Hard cap on the response body (the platform's is 16 KB). Ours is far smaller because a reply
 *  is one plain-text sentence; the cap only exists so a bug can never post a wall of text. */
export const COMMAND_RESPONSE_CAP = 16 * 1024;

/** The platform trims to the message cap itself, but sending 1000 characters of anything to a
 *  phone is already a failure of judgement — so we cut it here and own the result. */
export const COMMAND_TEXT_MAX = 1000;

/** The only caller this route ever accepts. Not an allow-list entry — a value no app id can hold. */
export const PLATFORM_CALLER = 'omos:platform';

/** Command ids the platform reserves for its own conversation flow. */
const RESERVED_IDS = new Set(['help', 'yes', 'no', 'cancel', 'stop']);

/** At most 12: a numbered menu longer than that does not fit in one WhatsApp message. */
export const MAX_COMMANDS = 12;

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
  /** The text the admin typed after the menu number, already trimmed. '' when none was given. */
  readonly text: string;
  /** The platform's id for this run. Log it; it is how a report ties back to a chat message. */
  readonly requestId: string;
  /** BCP-47 from the platform. Replies are English today (the platform's own limitation) but the
   *  value is passed through so a handler can do better later without a contract change. */
  readonly locale: string;
}

/** A command's outcome. `ok:false` is a real answer, not an error — "no reader called lobby" is
 *  something the admin needs told, and the platform renders it as such. */
export type CommandResult = { ok: true; text: string } | { ok: false; error: string };

export interface KioskCommand {
  /** Must match the `id` declared in manifest.yaml exactly — that is what the platform sends. */
  readonly id: string;
  readonly run: (ctx: CommandContext) => Promise<CommandResult>;
}

/**
 * THE COMMAND SET.
 *
 * Deliberately EMPTY, and the manifest declares no `commands:` block to match. The transport above
 * is complete and tested; which commands a kiosk should offer is Hasan's call and is coming
 * separately, so nothing is guessed at here. Adding one is this object plus one manifest entry —
 * and `commands.test.ts` asserts the two lists stay in step, so a command declared to the platform
 * and never implemented (or the reverse) fails the build rather than answering an admin with
 * "I don't know that one".
 *
 * When adding: `confirm: true` in the manifest for anything that changes hardware state, an
 * `argument:` OBJECT with a label if it takes text (never `argument: true` — the catalog rejects
 * it), and keep the work inside COMMAND_BUDGET_MS. If it cannot be, start it and say so.
 */
export const COMMANDS: readonly KioskCommand[] = [];

/** Look up a declared command. */
export function findCommand(id: string): KioskCommand | null {
  return COMMANDS.find((c) => c.id === id) ?? null;
}

/**
 * Run a command inside our own time budget.
 *
 * A handler that overruns is reported as "still working" rather than left to hit the platform's
 * 10s cut-off, because a timed-out HTTP call tells the admin nothing while a sentence can tell
 * them to ask again in a moment. The handler is not cancelled — there is nothing safe to cancel a
 * half-finished hardware action with — it simply stops being what we answer with.
 */
export async function runCommand(cmd: KioskCommand, ctx: CommandContext): Promise<CommandResult> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<CommandResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: 'That is taking longer than expected — it may still be working. Ask again in a moment.' }),
      COMMAND_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([cmd.run(ctx), budget]);
  } catch {
    // Never leak an exception message to a phone: it can carry a Stripe id, a file path or a
    // device token. The real reason goes to the container log.
    return { ok: false, error: 'Something went wrong running that. Please check the admin panel.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
