// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// ADMIN COMMANDS FROM WHATSAPP.
//
// This is the first route the PLATFORM calls on us rather than the other way round, and the first
// place this app checks a credential instead of presenting one. It answers questions about a
// masjid's money to a phone, so two things are tested here with equal weight: that only the
// platform can ever reach it, and that what comes back is true, readable, and free of anything a
// donor would not expect to find in someone's chat history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMMAND_BUDGET_MS,
  COMMAND_TEXT_MAX,
  COMMAND_TIMEOUT_MS,
  FOLLOWUP_TOKEN_MAX,
  MAX_COMMANDS,
  PLATFORM_CALLER,
  authorizeCommandCall,
  buildCommands,
  findCommand,
  matchKiosk,
  runCommand,
  tidyReply,
  validCommandId,
  validFollowUpToken,
  type CommandStore,
  type KioskCommand,
} from './commands';
import { blockedOverTunnel } from './tunnel';

const SECRET = 'a'.repeat(48);

// ── A stand-in store, so the commands are tested on their wording and their arithmetic rather
//    than on a database. Every field the commands read, and nothing else.
function fakeStore(over: Partial<CommandStore> = {}): CommandStore {
  return {
    getCurrency: () => 'USD',
    donationTotals: () => ({
      today: 12_00,
      thisWeek: 43_00,
      thisMonth: 191_00,
      allTime: 1422_00,
      count: 31,
      average: 45_87,
      byDevice: [
        { deviceId: 'd1', deviceName: 'Foyer', amountMinor: 900_00, count: 20 },
        { deviceId: 'd2', deviceName: 'Hall', amountMinor: 522_00, count: 11 },
      ],
    }),
    listDevices: () => [
      { id: 'd1', name: 'Foyer', lastSeen: new Date().toISOString(), readerStatus: 'connected', appVersion: '0.12.0', revoked: false },
      { id: 'd2', name: 'Hall', lastSeen: new Date(Date.now() - 3 * 3600_000).toISOString(), readerStatus: 'disconnected', appVersion: '0.11.0', revoked: false },
    ],
    listDonations: () => [
      { deviceName: 'Foyer', campaignTitle: 'General Fund', amountMinor: 10_00, refundedMinor: 0, currency: 'USD', kind: 'one_time', status: 'succeeded', createdAt: new Date().toISOString() },
      { deviceName: 'Hall', campaignTitle: 'Zakat', amountMinor: 50_00, refundedMinor: 0, currency: 'USD', kind: 'monthly', status: 'succeeded', createdAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    ],
    ...over,
  };
}

const money = (minor: number, currency: string) => `${currency === 'USD' ? '$' : ''}${(minor / 100).toFixed(2)}`;
const cmds = (over: Partial<CommandStore> = {}) => buildCommands({ store: fakeStore(over), money, onlineWithinMs: 35_000 });
const turn = (text = '', followUpToken = '') => ({ text, requestId: 'r', locale: 'en', followUpToken });
const run = async (id: string, text = '', token = '') => {
  const list = cmds();
  const c = findCommand(list, id);
  assert.ok(c, `no command ${id}`);
  return runCommand(c, turn(text, token));
};

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
  // A bad id or a duplicate should fail here, in one second, rather than at the catalog build
  // after a push.
  const list = cmds();
  assert.ok(list.length <= MAX_COMMANDS, 'a numbered menu longer than 12 does not fit in one message');
  const seen = new Set<string>();
  for (const c of list) {
    assert.ok(validCommandId(c.id), `invalid command id: ${c.id}`);
    assert.ok(!seen.has(c.id), `duplicate command id: ${c.id}`);
    seen.add(c.id);
    assert.equal(typeof c.run, 'function');
  }
});

test('the code and manifest.yaml declare the SAME commands', () => {
  // The two halves are read by different things — the platform reads the manifest to build the
  // menu, we read the code to answer — so drift shows up as a menu entry that replies "I don't
  // know that one". Parsed rather than hard-coded, so adding a command to only one side fails.
  const manifest = readFileSync(new URL('../../manifest.yaml', import.meta.url), 'utf8');
  const block = manifest.slice(manifest.indexOf('\ncommands:'));
  const declared = [...block.slice(0, block.indexOf('\ndomain:')).matchAll(/^\s+- id:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(declared.slice().sort(), cmds().map((c) => c.id).sort());
  for (const id of declared) assert.ok(validCommandId(id), `manifest declares an invalid id: ${id}`);
});

test('an unknown command is not found', () => {
  const list = cmds();
  assert.equal(findCommand(list, 'reader-status'), null);
  assert.equal(findCommand(list, ''), null);
  // Not reachable through prototype keys, which is the classic way a registry lookup goes wrong.
  assert.equal(findCommand(list, 'toString'), null);
  assert.equal(findCommand(list, 'constructor'), null);
  assert.equal(findCommand(list, '__proto__'), null);
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
  const r = await runCommand(slow, { text: '', requestId: 'r1', locale: 'en', followUpToken: '' });
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
  const r = await runCommand(boom, { text: '', requestId: 'r2', locale: 'en', followUpToken: '' });
  assert.equal(r.ok, false);
  const msg = r.ok === false ? r.error : '';
  assert.ok(!msg.includes('sk_live'), 'no key material');
  assert.ok(!msg.includes('pi_3XYZ'), 'no Stripe object id');
  assert.ok(!msg.includes('/data/'), 'no file path');
  assert.match(msg, /went wrong/i);
});

test('...but the real exception still reaches the container log', async () => {
  // The phone deliberately gets a sentence with nothing in it, so this callback is the ONLY record
  // that anything went wrong. It was missing until a sweep noticed the catch was empty while the
  // comment above it claimed the log had the reason — a failing command was invisible on both ends.
  const boom: KioskCommand = {
    id: 'boom',
    run: async () => {
      throw new Error('the actual cause');
    },
  };
  const logged: unknown[] = [];
  const r = await runCommand(boom, { text: '', requestId: 'r4', locale: 'en', followUpToken: '' }, (e) => logged.push(e));
  assert.equal(r.ok, false);
  assert.equal(logged.length, 1, 'exactly one report, not none and not one per retry');
  assert.match(String((logged[0] as Error).message), /the actual cause/);
});

test('a logger that itself throws cannot turn a handled failure into a crash', async () => {
  const boom: KioskCommand = {
    id: 'boom',
    run: async () => {
      throw new Error('cause');
    },
  };
  const r = await runCommand(boom, { text: '', requestId: 'r5', locale: 'en', followUpToken: '' }, () => {
    throw new Error('the logger is broken too');
  });
  assert.equal(r.ok, false, 'the admin still gets an answer');
  assert.match(r.ok === false ? r.error : '', /went wrong/i);
});

test('a command that succeeds never calls the error reporter', async () => {
  const fine: KioskCommand = { id: 'fine', run: async () => ({ ok: true, text: 'all good' }) };
  let calls = 0;
  const r = await runCommand(fine, { text: '', requestId: 'r6', locale: 'en', followUpToken: '' }, () => calls++);
  assert.equal(r.ok, true);
  assert.equal(calls, 0);
});

test('a normal command result passes straight through', async () => {
  const ok: KioskCommand = { id: 'ok', run: async (ctx) => ({ ok: true, text: `you said "${ctx.text}"` }) };
  assert.deepEqual(await runCommand(ok, { text: 'lobby', requestId: 'r3', locale: 'en', followUpToken: '' }), {
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

// ── The stats commands themselves ────────────────────────────────────────────

test('takings answers in full on the first turn, then offers to narrow down', async () => {
  // The most-used command must not interrogate anyone: the numbers come first, and the follow-up
  // is an offer, not a gate.
  const r = await run('takings');
  assert.equal(r.ok, true);
  const text = r.ok ? r.text : '';
  assert.match(text, /Today: \$12\.00/);
  assert.match(text, /This week: \$43\.00/);
  assert.match(text, /This month: \$191\.00/);
  assert.match(text, /All time: \$1422\.00 from 31 gifts/);
  assert.match(text, /after refunds/i, 'says which figure it is, so nobody quotes gross to a committee');
  assert.ok(r.ok && r.followUp, 'offers the drill-down when there is more than one kiosk');
  assert.equal(r.ok && r.followUp?.token, 'takings:pick');
});

test('takings does NOT ask anything when there is only one kiosk', async () => {
  // Nothing to choose between, so asking would be a wasted turn on a phone.
  const one = buildCommands({
    store: fakeStore({
      donationTotals: () => ({
        today: 0,
        thisWeek: 0,
        thisMonth: 500,
        allTime: 500,
        count: 1,
        average: 500,
        byDevice: [{ deviceId: 'd1', deviceName: 'Foyer', amountMinor: 500, count: 1 }],
      }),
    }),
    money,
    onlineWithinMs: 35_000,
  });
  const r = await runCommand(findCommand(one, 'takings')!, turn());
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.followUp, undefined);
});

test('the follow-up turn resolves a kiosk name, and ends the exchange', async () => {
  const r = await run('takings', 'Foyer', 'takings:pick');
  assert.equal(r.ok, true);
  assert.match(r.ok ? r.text : '', /Foyer — \$900\.00 from 20 gifts/);
  assert.equal(r.ok && r.followUp, undefined, 'answered, so stop capturing their conversation');
});

test('a partial or differently-cased kiosk name still resolves', async () => {
  for (const typed of ['foyer', 'FOYER', ' foy ', 'hal']) {
    const r = await run('takings', typed, 'takings:pick');
    assert.equal(r.ok, true, typed);
    assert.match(r.ok ? r.text : '', /—/, typed);
  }
});

test('"all" lists every kiosk', async () => {
  const r = await run('takings', 'all', 'takings:pick');
  assert.equal(r.ok, true);
  const text = r.ok ? r.text : '';
  assert.match(text, /Foyer — \$900\.00/);
  assert.match(text, /Hall — \$522\.00/);
  assert.equal(r.ok && r.followUp, undefined);
});

test('an unrecognized name gets ONE more go, then stops', async () => {
  // A typo should not mean starting over — but nor should we keep reading their messages forever
  // over a name we are not going to guess. The step lives in the token; we hold no state.
  const first = await run('takings', 'kitchen', 'takings:pick');
  assert.equal(first.ok, true);
  assert.match(first.ok ? first.text : '', /kiosk called "kitchen"/i);
  assert.match(first.ok ? first.text : '', /Foyer, Hall/, 'and says what the options are');
  assert.equal(first.ok && first.followUp?.token, 'takings:pick2');

  const second = await run('takings', 'kitchen', 'takings:pick2');
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.followUp, undefined, 'second miss ends it');
  assert.match(second.ok ? second.text : '', /Run the command again/i);
});

test('an ambiguous name resolves to nothing rather than the wrong kiosk', () => {
  const list = [{ deviceName: 'Hall North' }, { deviceName: 'Hall South' }];
  assert.equal(matchKiosk('hall', list), null, 'two matches is not a match');
  assert.equal(matchKiosk('north', list)?.deviceName, 'Hall North');
  assert.equal(matchKiosk('', list), null);
  assert.equal(matchKiosk('   ', list), null);
  // An exact name wins even when it is also a prefix of another.
  assert.equal(matchKiosk('Hall North', list)?.deviceName, 'Hall North');
});

test('a stray follow-up token is ignored and treated as a fresh turn', async () => {
  // The platform could hand back a token from an exchange we no longer recognize. It must read as
  // "start again", never as an answer to a question we did not ask.
  const r = await run('takings', 'Foyer', 'someone-elses-token');
  assert.equal(r.ok, true);
  assert.match(r.ok ? r.text : '', /Today: \$12\.00/, 'gave the headline figures, not a drill-down');
});

test('kiosks leads with what needs attention', async () => {
  const r = await run('kiosks');
  assert.equal(r.ok, true);
  const text = r.ok ? r.text : '';
  assert.match(text, /1 of 2 need attention/);
  assert.match(text, /Foyer — online, reader connected, v0\.12\.0/);
  assert.match(text, /Hall — OFFLINE \(last seen 3h ago\), NO READER, v0\.11\.0/);
  assert.equal(r.ok && r.followUp, undefined);
});

test('kiosks says so plainly when all is well, and when there are none', async () => {
  const healthy = buildCommands({
    store: fakeStore({
      listDevices: () => [
        { id: 'd1', name: 'Foyer', lastSeen: new Date().toISOString(), readerStatus: 'connected', appVersion: '0.12.0', revoked: false },
      ],
    }),
    money,
    onlineWithinMs: 35_000,
  });
  const ok = await runCommand(findCommand(healthy, 'kiosks')!, turn());
  assert.match(ok.ok ? ok.text : '', /All 1 kiosk/);

  const none = buildCommands({ store: fakeStore({ listDevices: () => [] }), money, onlineWithinMs: 35_000 });
  const empty = await runCommand(findCommand(none, 'kiosks')!, turn());
  assert.match(empty.ok ? empty.text : '', /No kiosks are paired yet/);
});

test('a revoked kiosk is not reported as offline hardware', async () => {
  // Revoking is how an admin retires a tablet. Listing it forever as a fault would train them to
  // ignore the one command whose whole job is flagging faults.
  const withRevoked = buildCommands({
    store: fakeStore({
      listDevices: () => [
        { id: 'd1', name: 'Foyer', lastSeen: new Date().toISOString(), readerStatus: 'connected', appVersion: '0.12.0', revoked: false },
        { id: 'd9', name: 'Old tablet', lastSeen: '2020-01-01T00:00:00.000Z', readerStatus: 'disconnected', appVersion: '0.1.0', revoked: true },
      ],
    }),
    money,
    onlineWithinMs: 35_000,
  });
  const r = await runCommand(findCommand(withRevoked, 'kiosks')!, turn());
  assert.ok(!(r.ok ? r.text : '').includes('Old tablet'));
});

test('recent lists the last few gifts and NEVER a donor', async () => {
  const r = await run('recent');
  assert.equal(r.ok, true);
  const text = r.ok ? r.text : '';
  assert.match(text, /\$10\.00/);
  assert.match(text, /Foyer/);
  assert.match(text, /General Fund/);
  assert.match(text, /monthly/, 'a standing order is worth distinguishing');
  assert.ok(!/@/.test(text), 'no email address');
});

test('NO DONOR IDENTITY reaches WhatsApp from any command', async () => {
  // A chat thread keeps a copy forever on at least two phones, which is why the platform refuses
  // to hand out app logs over this channel. The same reasoning binds us.
  const nosy = fakeStore({
    listDonations: () => [
      {
        deviceName: 'Foyer',
        campaignTitle: 'General Fund',
        amountMinor: 1000,
        currency: 'USD',
        kind: 'one_time',
        status: 'succeeded',
        createdAt: new Date().toISOString(),
        // Fields a future refactor might spread in by accident:
        donorName: 'Aisha Rahman',
        donorEmail: 'aisha@example.com',
        cardLast4: '4242',
      } as never,
    ],
  });
  const list = buildCommands({ store: nosy, money, onlineWithinMs: 35_000 });
  for (const c of list) {
    const r = await runCommand(c, turn());
    const text = r.ok ? r.text : r.error;
    assert.ok(!text.includes('Aisha'), c.id + ' leaked a donor name');
    assert.ok(!text.includes('aisha@example.com'), c.id + ' leaked an email');
    assert.ok(!text.includes('4242'), c.id + ' leaked card digits');
  }
});

test('every command copes with an empty install', async () => {
  const blank = fakeStore({
    donationTotals: () => ({ today: 0, thisWeek: 0, thisMonth: 0, allTime: 0, count: 0, average: 0, byDevice: [] }),
    listDevices: () => [],
    listDonations: () => [],
  });
  for (const c of buildCommands({ store: blank, money, onlineWithinMs: 35_000 })) {
    const r = await runCommand(c, turn());
    assert.equal(r.ok, true, c.id + ' failed on an empty install');
    const text = r.ok ? r.text : '';
    assert.ok(text.length > 0 && text.length < COMMAND_TEXT_MAX, c.id + ' said nothing useful');
    assert.ok(!/NaN|undefined|null/.test(text), c.id + ' rendered a placeholder: ' + text);
  }
});

test('every reply fits in a WhatsApp message even with a big fleet', async () => {
  const many = fakeStore({
    listDevices: () =>
      Array.from({ length: 40 }, (_, i) => ({
        id: 'd' + i,
        name: 'Kiosk number ' + i,
        lastSeen: new Date().toISOString(),
        readerStatus: 'connected',
        appVersion: '0.12.0',
        revoked: false,
      })),
  });
  const list = buildCommands({ store: many, money, onlineWithinMs: 35_000 });
  const r = await runCommand(findCommand(list, 'kiosks')!, turn());
  // tidyReply is what the route applies; the cap must hold after it.
  assert.ok(tidyReply(r.ok ? r.text : '').length <= COMMAND_TEXT_MAX);
});

// ── Follow-up tokens ─────────────────────────────────────────────────────────

test('follow-up tokens are validated before we ever echo one', () => {
  // Ours land in a later request body, so a malformed one is our bug surfacing as a conversation
  // that silently stops answering.
  assert.equal(validFollowUpToken('takings:pick'), true);
  assert.equal(validFollowUpToken('A1.b-c:d'), true);
  assert.equal(validFollowUpToken('x'.repeat(FOLLOWUP_TOKEN_MAX)), true);

  assert.equal(validFollowUpToken(''), false);
  assert.equal(validFollowUpToken('x'.repeat(FOLLOWUP_TOKEN_MAX + 1)), false);
  assert.equal(validFollowUpToken('has space'), false);
  assert.equal(validFollowUpToken('new\nline'), false);
  assert.equal(validFollowUpToken('quote"'), false);
  assert.equal(validFollowUpToken('brace{}'), false);
  assert.equal(validFollowUpToken(undefined as unknown as string), false);
});

test('the tokens the commands actually emit are all valid', async () => {
  // Belt and braces: whatever a handler returns must pass the same check the route applies, or the
  // route would drop it and the conversation would end a turn early for no visible reason.
  const emitted = [await run('takings'), await run('takings', 'nope', 'takings:pick')];
  for (const r of emitted) {
    const tok = r.ok ? r.followUp?.token : undefined;
    if (tok) assert.ok(validFollowUpToken(tok), 'emitted an invalid token: ' + tok);
  }
});

test('a failed turn can never carry a follow-up', () => {
  // The type forbids it, and the platform ends the exchange on ok:false regardless — so a failure
  // cannot leave someone's ordinary conversation being read as input. Encoded so a later refactor
  // that widens the type has to think about it.
  const failure: Awaited<ReturnType<KioskCommand['run']>> = { ok: false, error: 'nope' };
  assert.equal('followUp' in failure, false);
});

test('`recent` never reports a refunded gift as money the masjid still has', () => {
  // Every other figure this app quotes is netted — `takings` nets in SQL, the Donations page strikes
  // the row through. This line did neither, so a $500 gift refunded the same afternoon was still
  // read out over WhatsApp as $500 taken.
  const store = fakeStore({
    listDonations: () => [
      { deviceName: 'Foyer', campaignTitle: 'General', amountMinor: 500_00, refundedMinor: 500_00, currency: 'USD', kind: 'one_time', status: 'succeeded', createdAt: new Date().toISOString() },
      { deviceName: 'Hall', campaignTitle: 'Zakat', amountMinor: 100_00, refundedMinor: 40_00, currency: 'USD', kind: 'one_time', status: 'succeeded', createdAt: new Date().toISOString() },
      { deviceName: 'Hall', campaignTitle: 'Zakat', amountMinor: 20_00, refundedMinor: 0, currency: 'USD', kind: 'one_time', status: 'succeeded', createdAt: new Date().toISOString() },
    ],
  });
  const list = buildCommands({ store, money, onlineWithinMs: 35_000 });
  return runCommand(findCommand(list, 'recent')!, turn()).then((r) => {
    assert.equal(r.ok, true);
    const text = r.ok ? r.text : '';
    assert.match(text, /REFUNDED/, 'a fully refunded gift must say so');
    assert.match(text, /\$40\.00 refunded/, 'a partial must say how much went back');
    // The untouched gift stays plain — the marker must not leak onto every line.
    const plain = text.split('\n').find((l) => l.includes('$20.00'));
    assert.ok(plain && !/refunded/i.test(plain), 'an untouched donation is not annotated');
  });
});
