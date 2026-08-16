// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Which paths may be reached over the OpenMasjidOS Cloudflare tunnel (manifest `domain: true`).
 *
 *  Only the public KIOSK surface is internet-reachable when a masjid turns on remote adoption:
 *  the device API, the public bootstrap, the appearance relay, and everything that isn't `/api`
 *  (the SPA + its assets, `/new`, the APK, uploaded images — the setup page needs them). The admin
 *  panel, its login/session/setup routes and the Fabric relay stay LAN-only.
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

/** The kiosk surface, and only it. */
function allowedOverTunnel(p: string): boolean {
  return p === '/api/app' || p.startsWith('/api/public/') || p.startsWith('/api/kiosk/');
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
 * internet-reachable endpoint that can restart hardware — the wrong last line of defence when the
 * platform calling us is always on the same LAN, so there is no legitimate tunnel request to lose.
 */
function isFabricPath(p: string): boolean {
  return p === '/fabric' || p.startsWith('/fabric/');
}

/** Every spelling of this path the router might resolve it to: as it arrived, and decoded. The
 *  router decodes once; we go a little further so a double-encoded probe can't out-run us either.
 *  A malformed escape stops the walk — the raw form is still judged. */
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
  return forms;
}

/** True when a request that arrived over the tunnel must be refused (404). */
export function blockedOverTunnel(rawUrl: string): boolean {
  return candidatePaths(rawUrl).some((p) => isFabricPath(p) || (isApiPath(p) && !allowedOverTunnel(p)));
}
