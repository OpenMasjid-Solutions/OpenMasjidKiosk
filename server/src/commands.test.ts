// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// ADMIN COMMANDS FROM WHATSAPP.
//
// This is the first route the PLATFORM calls on us rather than the other way round, and the first
// place this app checks a credential instead of presenting one. It can be made to act on hardware
// in a building nobody is standing in, from a phone. So the transport is tested here even though
// the command set itself is still empty — the rules have to be right BEFORE there is anything
// worth running, not after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  COMMAND_BUDGET_MS,
  COMMAND_TEXT_MAX,
  COMMAND_TIMEOUT_MS,
  MAX_COMMANDS,
  PLATFORM_CALLER,
  authorizeCommandCall,
  findCommand,
  runCommand,
  tidyReply,
  validCommandId,
  type KioskCommand,
} from './commands';
import { blockedOverTunnel } from './tunnel';

const SECRET = 'a'.repeat(48);

test('both headers are required — neither alone is enough', () => {
  assert.deepEqual(authorizeCommandCall(SECRET, PLATFORM_CALLER, SECRET), { ok: true });

  // The right secret from something that is not the platform.
  assert.deepEqual(authorizeCommandCall(SECRET, 'display', SECRET), { ok: false, reason: 'bad_caller' });
  assert.deepEqual(authorizeCommandCall(SECRET, undefined, SECRET), { ok: false, reason: 'bad_caller' });
  assert.deepEqual(authorizeCommandCall(SECRET, '', SECRET), { ok: false, reason: 'bad_caller' });
  // The right caller claim with the wrong secret. Claiming to be the platform costs nothing.
  assert.deepEqual(authorizeCommandCall('b'.repeat(48), PLATFORM_CALLER, SECRET), { ok: false, reason: 'bad_secret' });
  assert.deepEqual(authorizeCommandCall(undefined, PLATFORM_CALLER, SECRET), { ok: false, reason: 'bad_secret' });
});

test('NO SECRET OF OUR OWN FAILS CLOSED — the empty-equals-empty trap', () => {
  // A standalone install has OPENMASJID_APP_SECRET empty by design. If the check were a plain
  // equality, an empty presented header would match an empty expected one, and anyone who could
  // reach the port on the LAN could run admin commands by sending no credential at all.
  assert.deepEqual(authorizeCommandCall('', PLATFORM_CALLER, ''), { ok: false, reason: 'not_configured' });
  assert.deepEqual(authorizeCommandCall(undefined, PLATFORM_CALLER, ''), { ok: false, reason: 'not_configured' });
  assert.deepEqual(authorizeCommandCall(SECRET, PLATFORM_CALLER, ''), { ok: false, reason: 'not_configured' });
  // ...and it is reported as not-configured, not as an attack: it is our state that is wrong.
});

test('the caller value is one the platform alone can hold', () => {
  // `omos:platform` is not an allow-list entry we maintain — the colon is outside the charset app
  // ids are validated against, so no installed app can ever present it. Near-misses must all fail.
  assert.equal(PLATFORM_CALLER, 'omos:platform');
  for (const near of ['omos', 'platform', 'omos-platform', 'omos:platform ', ' omos:platform', 'OMOS:PLATFORM', 'omos:platform2']) {
    assert.deepEqual(authorizeCommandCall(SECRET, near, SECRET), { ok: false, reason: 'bad_caller' }, near);
  }
});

test('a secret that merely starts right is still rejected', () => {
  assert.deepEqual(authorizeCommandCall(SECRET.slice(0, 47), PLATFORM_CALLER, SECRET), { ok: false, reason: 'bad_secret' });
  assert.deepEqual(authorizeCommandCall(SECRET + 'x', PLATFORM_CALLER, SECRET), { ok: false, reason: 'bad_secret' });
});

test('the command route is LAN-only — /fabric never crosses the tunnel', () => {
  // This is the gap that opened the moment this app served its first /fabric route: the guard only
  // ever judged /api paths, so everything else fell through as allowed.
  assert.equal(blockedOverTunnel('/fabric/commands/run'), true);
  assert.equal(blockedOverTunnel('/fabric'), true);
  assert.equal(blockedOverTunnel('/fabric/anything/else'), true);
  // And it fails closed on the encoding trick that walked past the /api guard once already.
  assert.equal(blockedOverTunnel('/%66abric/commands/run'), true);
  assert.equal(blockedOverTunnel('/fabric/commands/run?x=1'), true);
  // The kiosk surface is untouched — a donor and a paired tablet still reach what they need.
  assert.equal(blockedOverTunnel('/api/kiosk/heartbeat'), false);
  assert.equal(blockedOverTunnel('/api/public/appearance'), false);
  assert.equal(blockedOverTunnel('/new'), false);
  assert.equal(blockedOverTunnel('/m/' + 'a'.repeat(64)), false);
});

test('command ids are checked against the platform’s own rules', () => {
  assert.equal(validCommandId('reader-status'), true);
  assert.equal(validCommandId('takings-today'), true);
  assert.equal(validCommandId('a'), true);

  assert.equal(validCommandId('Reader-Status'), false, 'kebab-case only');
  assert.equal(validCommandId('reader_status'), false, 'underscores are not kebab-case');
  assert.equal(validCommandId('reader status'), false);
  assert.equal(validCommandId('-reader'), false);
  assert.equal(validCommandId('reader-'), false);
  assert.equal(validCommandId('reader--status'), false);
  assert.equal(validCommandId(''), false);
  // Never all digits: "!kiosk 2" must only ever mean "the second option on the menu".
  assert.equal(validCommandId('2'), false);
  assert.equal(validCommandId('12'), false);
  // Reserved for the platform's own conversation.
  for (const r of ['help', 'yes', 'no', 'cancel', 'stop']) assert.equal(validCommandId(r), false, r);
});

test('the declared command set obeys every rule the catalog build enforces', () => {
  // Guards the moment a command IS added: a bad id or a duplicate should fail here, in one second,
  // rather than at the catalog build after a push.
  assert.ok(COMMANDS.length <= MAX_COMMANDS, 'a numbered menu longer than 12 does not fit in one message');
  const seen = new Set<string>();
  for (const c of COMMANDS) {
    assert.ok(validCommandId(c.id), `invalid command id: ${c.id}`);
    assert.ok(!seen.has(c.id), `duplicate command id: ${c.id}`);
    seen.add(c.id);
    assert.equal(typeof c.run, 'function');
  }
});

test('an unknown command is not found — including while the set is empty', () => {
  assert.equal(findCommand('reader-status'), null);
  assert.equal(findCommand(''), null);
  // Not reachable through prototype keys, which is the classic way a registry lookup goes wrong.
  assert.equal(findCommand('toString'), null);
  assert.equal(findCommand('constructor'), null);
  assert.equal(findCommand('__proto__'), null);
});

test('our own budget sits inside the platform’s timeout', () => {
  // Whoever holds the shorter clock owns the error message. If ours were the longer one the
  // platform would cut the connection and the admin would get nothing useful.
  assert.ok(COMMAND_BUDGET_MS < COMMAND_TIMEOUT_MS, 'the handler must give up before the platform does');
  assert.ok(COMMAND_TIMEOUT_MS - COMMAND_BUDGET_MS >= 1000, 'leave room for the reply to travel');
});

test('a slow command answers "still working" instead of timing out', async () => {
  const slow: KioskCommand = { id: 'slow', run: () => new Promise(() => {}) }; // never settles
  const started = Date.now();
  const r = await runCommand(slow, { text: '', requestId: 'r1', locale: 'en' });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /longer than expected|ask again/i);
  assert.ok(Date.now() - started < COMMAND_TIMEOUT_MS, 'and it answers before the platform gives up');
});

test('a command that throws never leaks the exception to a phone', async () => {
  // Exception messages here can carry a Stripe id, a file path or a device token.
  const boom: KioskCommand = {
    id: 'boom',
    run: async () => {
      throw new Error('sk_live_51ABCdef pi_3XYZ /data/kiosk.db');
    },
  };
  const r = await runCommand(boom, { text: '', requestId: 'r2', locale: 'en' });
  assert.equal(r.ok, false);
  const msg = r.ok === false ? r.error : '';
  assert.ok(!msg.includes('sk_live'), 'no key material');
  assert.ok(!msg.includes('pi_3XYZ'), 'no Stripe object id');
  assert.ok(!msg.includes('/data/'), 'no file path');
  assert.match(msg, /went wrong/i);
});

test('a normal command result passes straight through', async () => {
  const ok: KioskCommand = { id: 'ok', run: async (ctx) => ({ ok: true, text: `you said "${ctx.text}"` }) };
  assert.deepEqual(await runCommand(ok, { text: 'lobby', requestId: 'r3', locale: 'en' }), {
    ok: true,
    text: 'you said "lobby"',
  });
});

test('a reply cannot be made to look like several messages', () => {
  assert.equal(tidyReply('one\n\n\n\n\ntwo'), 'one\n\ntwo');
  assert.equal(tidyReply('  padded  '), 'padded');
  assert.equal(tidyReply('trailing   \nspace'), 'trailing\nspace');
  // CRLF is folded, not stripped into a bare carriage return.
  assert.equal(tidyReply('a\r\nb'), 'a\nb');
  assert.equal(tidyReply('a\rb'), 'a\nb');
  assert.ok(!tidyReply('a\r\nb').includes('\r'));
  // Control bytes go; the newline and tab we allow stay.
  assert.equal(tidyReply('be\u0000ll\u0007'), 'bell');
  assert.equal(tidyReply('a\tb'), 'a\tb');
  assert.equal(tidyReply('a\nb'), 'a\nb');
});

test('a runaway reply is cut, not sent whole', () => {
  const long = tidyReply('x'.repeat(5000));
  assert.ok(long.length <= COMMAND_TEXT_MAX, `got ${long.length}`);
  assert.ok(long.endsWith('…'), 'and it is visibly truncated rather than silently clipped');
  // Something the platform would have to trim is also far below its 16 KB response cap.
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, text: long }), 'utf8') < 16 * 1024);
});

test('empty and odd replies do not throw', () => {
  assert.equal(tidyReply(''), '');
  assert.equal(tidyReply('\n\n\n'), '');
  assert.equal(tidyReply(undefined as unknown as string), '');
});
