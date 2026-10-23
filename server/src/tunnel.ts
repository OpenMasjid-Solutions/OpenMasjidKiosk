// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Which paths may be reached over the OpenMasjidOS Cloudflare tunnel (manifest `domain: true`).
 *
 *  Over the tunnel: the public KIOSK surface (the device API, the public bootstrap, the appearance
 *  and logo relays, and everything that isn't `/api` — the SPA + its assets, `/new`, the APK, uploaded
 *  images), plus what a REMOTE ADMIN needs: `/api/session`, `/api/logout` and `/api/admin/*`. Those answer
 *  only to a request OpenMasjidOS vouches for, asked afresh on each one (index.ts `requireAdmin`):
 *  the platform hands us an access token only while the admin is signed in to its remote dashboard
 *  with two-step sign-in. Everything that turns a PASSWORD into a session — `/api/login`,
 *  `/api/setup` — stays LAN-only, so the local password is never guessable from the internet. So
 *  does the Fabric relay, and so does any `/api` route nobody has listed here.
 *
 *  WHY THIS IS ITS OWN MODULE. The rule used to live inline as `path.startsWith('/api/')` against
 *  the RAW url — and Fastify's router percent-decodes path segments BEFORE matching, so encoding a
 *  single letter of the first segment walked straight past it:
 *
 *      GET /kiosk/api/admin/plans     -> 404  (blocked)
 *      GET /kiosk/%61pi/admin/plans   -> 401  (the real admin route ran)
 *      POST /kiosk/%61pi/login        -> the real password login, from the internet
 *
 *  A guard has to judge the path the way the ROUTER will resolve it, not the way it arrived. So we
 *  test the raw form AND its decoded forms, and block if ANY of them looks like a non-allow-listed
 *  `/api` path. Fail closed: an ambiguous path is refused rather than guessed at.
 *
 *  Pure and exported so the rule is unit-tested rather than asserted in a comment. */
import path from 'node:path';

/** The kiosk surface, plus the remote admin's routes (gated by the platform, see above). */
function allowedOverTunnel(p: string): boolean {
  return (
    p === '/api/app' ||
    p.startsWith('/api/public/') ||
    p.startsWith('/api/kiosk/') ||
    p === '/api/session' ||
    p === '/api/logout' ||
    p.startsWith('/api/admin/')
  );
}

/** Anything routed under our JSON API. */
function isApiPath(p: string): boolean {
  return p === '/api' || p.startsWith('/api/');
}

/**
 * Anything under `/fabric` — the platform-to-app surface (admin WhatsApp commands).
 *
 * LAN-ONLY, WITH NO EXCEPTIONS, and it needs saying separately because it is NOT under `/api`.
 * The rule above only ever judged `/api` paths, so every non-`/api` path fell through as allowed —
 * correct while that meant the SPA, its assets, `/new`, the APK and `/uploads`, and quietly wrong
 * the moment this app served its first `/fabric/*` route.
 *
 * The platform's own contract says `/fabric/*` is never served over the tunnel. The secret check on
 * the handler would still refuse a stranger, but that is a credential comparison on an
 * internet-reachable endpoint that can restart hardware — the wrong last line of defense when the
 * platform calling us is always on the same LAN, so there is no legitimate tunnel request to lose.
 */
function isFabricPath(p: string): boolean {
  return p === '/fabric' || p.startsWith('/fabric/');
}

/** Every spelling of this path the router might resolve it to: as it arrived, decoded, and with its
 *  dot segments resolved. The router decodes once; we go a little further so a double-encoded probe
 *  can't out-run us either. A malformed escape stops the walk — the raw form is still judged.
 *
 *  Dot segments matter now that `/api/admin/*` is allowed: `/api/admin/../login` starts with an
 *  allowed prefix as written, and is the password login to anything that resolves `..`. Its
 *  resolved spelling is judged as well, and refused. */
function candidatePaths(rawUrl: string): string[] {
  const raw = (rawUrl || '/').split('?')[0].split('#')[0];
  const forms = [raw];
  let cur = raw;
  for (let i = 0; i < 2; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      break; // malformed percent-escape — nothing more to canonicalise
    }
    if (next === cur) break;
    cur = next;
    forms.push(cur);
  }
  for (const f of [...forms]) {
    const resolved = path.posix.normalize(f); // resolves "." and "..", and collapses "//"
    if (!forms.includes(resolved)) forms.push(resolved);
  }
  return forms;
}

/** True when a request that arrived over the tunnel must be refused (404). */
export function blockedOverTunnel(rawUrl: string): boolean {
  return candidatePaths(rawUrl).some((p) => isFabricPath(p) || (isApiPath(p) && !allowedOverTunnel(p)));
}
