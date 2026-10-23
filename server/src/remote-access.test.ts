// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// MANAGING KIOSK FROM OUTSIDE THE MASJID — against the real server, booted as a child process, with
// a stand-in for OpenMasjidOS that answers the three Fabric calls this needs.
//
// OpenMasjidOS serves an app over its Cloudflare tunnel at https://<apps' hostname>/<basePath>/…,
// prefix NOT stripped, with `cf-ray` and `x-forwarded-proto: https`. Its "Open" button gives the
// browser an `omos_session` access token for this app alone, which the platform vouches for at
// /api/auth/session only while the admin's two-step-verified remote session lives. The bug this
// pins: every /api route but the kiosk surface was refused over the tunnel — /api/session included —
// so pressing Open from the remote dashboard landed on a password form that could never work.
//
// What must hold now: OpenMasjidOS's word signs the admin in from outside; the local password, setup
// and the Fabric stay LAN-only in every spelling; a local session (above all a password one) counts
// for nothing over the tunnel; and nothing about the LAN changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECRET = 'test-app-secret';
const GOOD = 'a1.goodhandle.goodmac'; // an access token the stand-in platform vouches for
const PASSWORD = 'correct horse battery';
const TUNNEL = { 'cf-ray': '8f00test-LHR', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'apps.example.org' };
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

type Res = { status: number; headers: http.IncomingHttpHeaders; text: string; json: { data?: Record<string, unknown>; error?: string } };

/** A raw request: unlike fetch, node:http sends the path exactly as written — `..` and `%61` included. */
function call(port: number, method: string, p: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON (the page) */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const sessionCookie = (r: Res): string | null => {
  const raw = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('omkiosk_session='));
  return raw ? raw.split(';')[0] : null;
};

// ── The stand-in for OpenMasjidOS ──
const platform = { siteStatus: 200, down: false };
let platformPort = 0;
const fake = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (platform.down) return req.socket.destroy();
  const authed = req.headers['x-openmasjid-app-secret'] === SECRET;
  if (req.url === '/api/fabric/site') {
    if (platform.siteStatus !== 200) return send(platform.siteStatus, { error: 'Not now.' });
    return send(authed ? 200 : 403, { enabled: true, domain: 'apps.example.org', publicUrl: 'https://apps.example.org/kiosk', basePath: '/kiosk' });
  }
  if (req.url === '/api/auth/session') {
    const ok = authed && /(?:^|;\s*)omos_session=a1\.goodhandle\.goodmac(?:;|$)/.test(String(req.headers.cookie ?? ''));
    return send(200, ok ? { authenticated: true, username: 'hasan' } : { authenticated: false });
  }
  if (req.url === '/api/public/appearance') return send(200, {});
  return send(404, { error: 'Not found.' });
});

const children: ChildProcess[] = [];
const tmpDirs: string[] = [];

/** Boot the real server against the stand-in platform. Remote access is on but Kiosk is PRIVATE
 *  (OPENMASJID_PUBLIC_URL empty), so the base path comes only from /api/fabric/site. */
async function boot(): Promise<number> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-remote-'));
  tmpDirs.push(dir);
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><html><head><title>Kiosk</title></head><body></body></html>');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: path.join(dir, 'data'),
    PUBLIC_DIR: pub,
    OPENMASJID_BASE_URL: `http://127.0.0.1:${platformPort}`,
    OPENMASJID_APP_ID: 'kiosk',
    OPENMASJID_APP_SECRET: SECRET,
    OPENMASJID_PUBLIC_URL: '',
    COOKIE_SECURE: '',
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(SERVER_DIR, 'src', 'index.ts')], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) break;
    const up = await call(port, 'GET', '/healthz').then((r) => r.status === 200, () => false);
    if (up) return port;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server did not start:\n${out}`);
}

let port = 0;
let lanCookie = '';

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  platformPort = (fake.address() as net.AddressInfo).port;
  port = await boot();

  // A local admin password, made the only way it can be under OpenMasjidOS: first-run setup while
  // the platform cannot be reached (the recovery path), on the LAN.
  platform.down = true;
  const setup = await call(port, 'POST', '/api/setup', {}, { password: PASSWORD });
  platform.down = false;
  assert.equal(setup.status, 200, setup.text);
});

after(() => {
  for (const c of children) c.kill();
  fake.close();
  // Retried: on Windows a just-killed server still holds kiosk.db open for a moment (EPERM/EBUSY).
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('on the LAN nothing changes: password login, the admin API, and the SSO upgrade', { timeout: 30_000 }, async () => {
  const login = await call(port, 'POST', '/api/login', {}, { password: PASSWORD });
  assert.equal(login.status, 200);
  lanCookie = sessionCookie(login) ?? '';
  assert.ok(lanCookie, 'a password login sets our session cookie');

  assert.equal((await call(port, 'GET', '/api/admin/devices', { cookie: lanCookie })).status, 200);
  assert.equal((await call(port, 'GET', '/api/admin/devices')).status, 401);

  const s = await call(port, 'GET', '/api/session', { cookie: lanCookie });
  assert.equal(s.json.data?.authed, true);
  assert.equal(s.json.data?.remote, false);

  // Pressing Open in the dashboard on the LAN still mints our short SSO session, as before.
  const sso = await call(port, 'GET', '/api/session', { cookie: `omos_session=${GOOD}` });
  assert.equal(sso.json.data?.authed, true);
  assert.ok(sessionCookie(sso), 'the LAN SSO upgrade still mints a session');

  // Signing out on the LAN clears the one cookie at the root, as it always has.
  const out = await call(port, 'POST', '/api/logout', { cookie: lanCookie });
  const cleared = ([] as string[]).concat(out.headers['set-cookie'] ?? []);
  assert.equal(cleared.length, 1);
  assert.match(cleared[0], /^omkiosk_session=;.*Path=\/(;|$)/);

  // The LAN gets the page as built, with no base path.
  const page = await call(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('<base'), 'no base path on the LAN');
});

test('opened from the remote dashboard, OpenMasjidOS signs the admin in — no password', { timeout: 30_000 }, async () => {
  const s = await call(port, 'GET', '/kiosk/api/session', { ...TUNNEL, cookie: `omos_session=${GOOD}` });
  assert.equal(s.status, 200, 'the session route answers over the tunnel');
  assert.equal(s.json.data?.authed, true);
  assert.equal(s.json.data?.remote, true);
  assert.equal((s.json.data?.sso as { username?: string }).username, 'hasan');
  assert.equal(sessionCookie(s), null, 'nothing is minted over the tunnel — the platform is asked every time');

  // Every admin feature, under the prefix: a read, a write, the CSV download.
  const auth = { ...TUNNEL, cookie: `omos_session=${GOOD}` };
  assert.equal((await call(port, 'GET', '/kiosk/api/admin/devices', auth)).status, 200);
  assert.equal((await call(port, 'GET', '/kiosk/api/admin/payments', auth)).status, 200);
  assert.equal((await call(port, 'PUT', '/kiosk/api/admin/remote', auth, { allowAdoption: false })).status, 200);
  const csv = await call(port, 'GET', '/kiosk/api/admin/donations.csv', auth);
  assert.equal(csv.status, 200);
  assert.match(String(csv.headers['content-type']), /text\/csv/);

  // The page itself comes with the prefix, so its assets and API calls stay under it.
  const page = await call(port, 'GET', '/kiosk/', TUNNEL);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('<base href="/kiosk/">'));
  assert.ok(page.text.includes('window.__OMOS_BASE__="/kiosk"'));

  // Signing out from there clears our cookie at the root AND under the base path.
  const out = await call(port, 'POST', '/kiosk/api/logout', TUNNEL);
  assert.equal(out.status, 200);
  const cleared = ([] as string[]).concat(out.headers['set-cookie'] ?? []).filter((c) => c.startsWith('omkiosk_session=;'));
  assert.ok(cleared.some((c) => /Path=\/(;|$)/.test(c)), 'cleared at /');
  assert.ok(cleared.some((c) => /Path=\/kiosk(;|$)/.test(c)), 'cleared at /kiosk');
});

// Through the tunnel every app and the dashboard share ONE hostname, and the platform strips only its
// own cookies — so a session of ours set there with Path=/ would be sent to every other app's server,
// which could replay it. So: none is ever set there, and one replayed there opens nothing.
test('over the tunnel no session of ours is ever set, and a replayed one opens nothing', { timeout: 30_000 }, async () => {
  for (const [method, p] of [
    ['GET', '/kiosk/api/session'],
    ['GET', '/kiosk/api/admin/devices'],
    ['GET', '/kiosk/'],
  ] as const) {
    const r = await call(port, method, p, { ...TUNNEL, cookie: `omos_session=${GOOD}` });
    assert.equal(r.status, 200);
    assert.equal(sessionCookie(r), null, `${method} ${p} must not set a session cookie`);
  }
  // A session another app's server lifted from a request and replays against us from outside — even
  // a freshly minted SSO one — counts for nothing without the platform vouching.
  const sso = await call(port, 'GET', '/api/session', { cookie: `omos_session=${GOOD}` });
  const minted = sessionCookie(sso);
  assert.ok(minted);
  assert.equal((await call(port, 'GET', '/kiosk/api/admin/devices', { ...TUNNEL, cookie: minted })).status, 401);
  assert.equal((await call(port, 'GET', '/kiosk/api/session', { ...TUNNEL, cookie: minted })).json.data?.authed, false);
});

test('over the tunnel a local session counts for nothing — only the platform vouching does', { timeout: 30_000 }, async () => {
  assert.ok(lanCookie);
  // The password session that works on the LAN, presented from outside.
  assert.equal((await call(port, 'GET', '/kiosk/api/admin/devices', { ...TUNNEL, cookie: lanCookie })).status, 401);
  // …with a platform token the platform does not vouch for.
  assert.equal((await call(port, 'GET', '/kiosk/api/admin/devices', { ...TUNNEL, cookie: `${lanCookie}; omos_session=a1.forged.mac` })).status, 401);
  // …with nothing at all.
  assert.equal((await call(port, 'GET', '/kiosk/api/admin/devices', TUNNEL)).status, 401);
  assert.equal((await call(port, 'POST', '/kiosk/api/admin/devices/pair-code', TUNNEL)).status, 401);

  const s = await call(port, 'GET', '/kiosk/api/session', { ...TUNNEL, cookie: lanCookie });
  assert.equal(s.json.data?.authed, false, 'a password session does not sign anyone in from outside');
  assert.equal(s.json.data?.remote, true);

  // A change posted from another origin — a sibling subdomain is same-SITE, so the platform's Lax
  // token rides along — is refused; from the panel's own origin it goes through.
  const good = { ...TUNNEL, cookie: `omos_session=${GOOD}` };
  assert.equal((await call(port, 'PUT', '/kiosk/api/admin/remote', { ...good, origin: 'https://www.example.org' }, { allowAdoption: false })).status, 403);
  assert.equal((await call(port, 'PUT', '/kiosk/api/admin/remote', { ...good, origin: 'https://apps.example.org' }, { allowAdoption: false })).status, 200);

  // `cf-ray` alone marks a request as the tunnel's, prefix or not — a stricter rule, never a looser one.
  assert.equal((await call(port, 'GET', '/api/admin/devices', { 'cf-ray': 'x', cookie: lanCookie })).status, 401);
});

test('the password, setup and the Fabric stay LAN-only over the tunnel, in every spelling', { timeout: 30_000 }, async () => {
  const pw = { password: PASSWORD };
  for (const [method, p] of [
    ['POST', '/kiosk/api/login'],
    ['POST', '/kiosk/api/setup'],
    ['POST', '/kiosk/%61pi/login'],
    ['POST', '/kiosk/ap%69/login'],
    ['POST', '/kiosk/%2561pi/login'],
    ['POST', '/kiosk/api/%6cogin'],
    ['POST', '/kiosk/api/admin/../login'],
    ['POST', '/kiosk/api/admin/%2e%2e/login'],
    ['POST', '/kiosk/api/kiosk/../setup'],
    ['POST', '/kiosk//api/login'],
    ['POST', '/kiosk/fabric/commands/run'],
    ['GET', '/kiosk/api/fabric/site'],
  ] as const) {
    const r = await call(port, method, p, { ...TUNNEL, cookie: `omos_session=${GOOD}` }, pw);
    assert.equal(r.status, 404, `${method} ${p} must be refused over the tunnel (got ${r.status})`);
    assert.equal(sessionCookie(r), null);
  }
  // A LAN client that sends `cf-ray` gets the tunnel's rules too.
  assert.equal((await call(port, 'POST', '/api/login', { 'cf-ray': 'x' }, pw)).status, 404);
});

test('a refusal from the platform is "could not ask", never "remote access is off"', { timeout: 60_000 }, async () => {
  // A second server that starts while the platform will not say where it is served.
  platform.siteStatus = 503;
  const cold = await boot();

  // Its first tunnel request cannot be routed; it is told to retry rather than handed a page whose
  // every path would reach the OpenMasjidOS dashboard instead of us.
  const first = await call(cold, 'GET', '/kiosk/', TUNNEL);
  assert.equal(first.status, 503);
  assert.ok(!first.text.includes('<html'), 'never the panel without its base path');

  // The platform answers again: the next request learns the base path and is sent back to the same
  // address, which now routes — no minute-long wait for the refresh timer.
  platform.siteStatus = 200;
  await new Promise((r) => setTimeout(r, 2_100)); // past the refresh throttle
  const healed = await call(cold, 'GET', '/kiosk/api/session?x=1', { ...TUNNEL, cookie: `omos_session=${GOOD}` });
  assert.equal(healed.status, 307);
  assert.equal(healed.headers.location, '/kiosk/api/session?x=1');
  const again = await call(cold, 'GET', '/kiosk/api/session?x=1', { ...TUNNEL, cookie: `omos_session=${GOOD}` });
  assert.equal(again.json.data?.authed, true);

  // And once it is known, a platform hiccup does not forget it (it used to be cached as "off").
  const { fetchFabricSite, cachedFabricSite } = await loadFabricAgainst(platformPort);
  assert.equal((await fetchFabricSite(true)).basePath, '/kiosk');
  platform.siteStatus = 429;
  await fetchFabricSite(true);
  assert.equal(cachedFabricSite().basePath, '/kiosk');
  platform.siteStatus = 200;
});

/** fabric.ts reads its configuration at import, so point this process at the stand-in first. */
async function loadFabricAgainst(p: number) {
  process.env.OPENMASJID_BASE_URL = `http://127.0.0.1:${p}`;
  process.env.OPENMASJID_APP_SECRET = SECRET;
  return import('./fabric');
}
