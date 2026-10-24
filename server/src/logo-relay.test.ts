// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// THE MASJID'S LOGO, RELAYED FROM THE PLATFORM.
//
// The platform's appearance answer carries `logo: "/api/public/logo"`, a path the app spec says to
// resolve against the origin appearance was fetched from. Our browser fetches appearance from US —
// the platform is plain HTTP and we are served over HTTPS — so that path has to exist on our origin,
// and before this it 404'd: anything following the spec drew a broken image.
//
// What is pinned here is what makes a public, internet-reachable relay acceptable: it can only ever
// fetch the one fixed upstream path, it will only pass on four raster image types whose bytes match
// the type claimed, it never buffers more than a megabyte, and every failure is the same quiet
// "no logo" that tells the page to show the masjid's name instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config';
import { LOGO_MAX_BYTES, fetchPlatformLogo, relayedAppearance } from './fabric';
import { blockedOverTunnel } from './tunnel';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

interface Seen {
  url: string;
  redirect?: string;
  headers?: unknown;
}

/** Point the relay at a stubbed platform. `respond` builds each answer; every request is captured. */
function stubPlatform(respond: () => Response, base = 'http://omos.test'): { seen: Seen[]; restore: () => void } {
  const seen: Seen[] = [];
  const origFetch = globalThis.fetch;
  const origBase = config.omosBaseUrl;
  config.omosBaseUrl = base;
  globalThis.fetch = (async (input: unknown, init?: { redirect?: string; headers?: unknown }) => {
    seen.push({ url: String(input), redirect: init?.redirect, headers: init?.headers });
    return respond();
  }) as typeof globalThis.fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = origFetch;
      config.omosBaseUrl = origBase;
    },
  };
}

const image = (body: Buffer, type: string, extra: Record<string, string> = {}) =>
  new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type, ...extra } });

test('standalone: there is no platform to ask, so there is no logo — and no request', async () => {
  const s = stubPlatform(() => image(PNG, 'image/png'), '');
  try {
    assert.equal(await fetchPlatformLogo(), null);
    assert.equal(s.seen.length, 0, 'nothing may go out when no platform address was injected');
  } finally {
    s.restore();
  }
});

test('a PNG from the platform is relayed byte for byte, from the one fixed path, with redirects refused', async () => {
  const s = stubPlatform(() => image(PNG, 'image/png; charset=binary'));
  try {
    const logo = await fetchPlatformLogo();
    assert.ok(logo, 'a real PNG must come through');
    assert.equal(logo.contentType, 'image/png', 'parameters stripped; only the bare type is re-sent');
    assert.deepEqual(logo.body, PNG);
    assert.equal(s.seen.length, 1);
    assert.equal(s.seen[0].url, 'http://omos.test/api/public/logo', 'a fixed upstream path — no input reaches it');
    assert.equal(s.seen[0].redirect, 'error', 'a redirect could aim the relay somewhere else, so it is an error');
    assert.equal(s.seen[0].headers, undefined, 'the logo is public: our app secret is never sent for it');
  } finally {
    s.restore();
  }
});

test('JPEG, WEBP and GIF are accepted when their bytes say so', async () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
  for (const [body, type] of [
    [JPEG, 'image/jpeg'],
    [webp, 'image/webp'],
    [gif, 'image/gif'],
  ] as const) {
    const s = stubPlatform(() => image(body, type));
    try {
      assert.equal((await fetchPlatformLogo())?.contentType, type, type);
    } finally {
      s.restore();
    }
  }
});

test('an SVG is refused — it is a document that can carry script, served from OUR origin', async () => {
  const s = stubPlatform(() => image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'));
  try {
    assert.equal(await fetchPlatformLogo(), null);
  } finally {
    s.restore();
  }
});

test('a declared type the bytes do not match is refused, not trusted', async () => {
  // Belt and braces beside nosniff: the relay does not pass on whatever sat behind a header.
  const s = stubPlatform(() => image(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'));
  try {
    assert.equal(await fetchPlatformLogo(), null);
  } finally {
    s.restore();
  }
});

test('"no logo" and "could not ask" are the same quiet answer', async () => {
  for (const respond of [
    () => new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'content-type': 'application/json' } }),
    () => new Response('boom', { status: 502, headers: { 'content-type': 'text/plain' } }),
    () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    const s = stubPlatform(respond);
    try {
      assert.equal(await fetchPlatformLogo(), null);
    } finally {
      s.restore();
    }
  }
});

test('nothing over a megabyte is relayed — whether or not the platform says how big it is', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)]);
  // Declared too big: refused before a byte is read.
  let s = stubPlatform(() => image(PNG, 'image/png', { 'content-length': String(LOGO_MAX_BYTES + 1) }));
  try {
    assert.equal(await fetchPlatformLogo(), null, 'a declared length over the cap');
  } finally {
    s.restore();
  }
  // Undeclared, and too big: the read itself is capped, so a missing or lying Content-Length
  // cannot make us buffer an unbounded body.
  s = stubPlatform(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(big));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ),
  );
  try {
    assert.equal(await fetchPlatformLogo(), null, 'a streamed body over the cap');
  } finally {
    s.restore();
  }
  // Exactly at the cap is still fine.
  s = stubPlatform(() => image(Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES - PNG.length)]), 'image/png'));
  try {
    assert.equal((await fetchPlatformLogo())?.body.length, LOGO_MAX_BYTES);
  } finally {
    s.restore();
  }
});

test('the appearance relay points `logo` at OUR relay, or says there is none', () => {
  const platform = { v: 1, theme: 'dark', wallpaper: 'aurora', wallpaperImage: '', accent: 'teal', lang: 'en' };
  assert.equal(relayedAppearance({ ...platform, logo: '/api/public/logo' }).logo, '/api/public/logo');
  // The platform's own value is never passed through, even if it were something else entirely —
  // a path meant for its origin must not be resolved against ours.
  assert.equal(relayedAppearance({ ...platform, logo: 'https://elsewhere.example/x.png' }).logo, '/api/public/logo');
  assert.equal(relayedAppearance({ ...platform, logo: '' }).logo, '', 'no logo set — the page shows the name');
  assert.equal(relayedAppearance({ ...platform }).logo, '', 'an older platform that sends no logo field');
  assert.equal(relayedAppearance({ ...platform, logo: 42 }).logo, '');
  // Everything else is verbatim.
  const out = relayedAppearance({ ...platform, logo: '/api/public/logo' });
  for (const [k, v] of Object.entries(platform)) assert.equal(out[k], v, k);
  // Standalone stays empty: "no platform" must still read as no platform.
  assert.deepEqual(relayedAppearance({}), {});
});

test('the logo relay is reachable over the tunnel, like the appearance it belongs to', () => {
  // A remote kiosk's setup page and a donor's page may both show it, and the platform treats its
  // logo as intentionally public.
  assert.equal(blockedOverTunnel('/api/public/logo'), false);
  assert.equal(blockedOverTunnel('/api/public/%6cogo'), false, 'an encoded spelling of it too');
});
