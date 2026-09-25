// Per-request context: bearer token → authenticated caller.
//
// The key responsibility here is structural org isolation: the token's `org` claim
// is THE ONLY org the caller may address. A request that names a different org gets
// a 404 — the other org is invisible, not forbidden.
//
// We also enforce freshness: if the membership's perm_version differs from the token's
// pv claim, the token is stale and we return 401 TOKEN_STALE so the client can refresh.

import { verifyAccessToken, assertFresh } from './auth.js';
import { unauthenticated, notFound } from './http.js';

// authenticate(db, secret) returns a function (req, params) => ctx.
// ctx carries: { userId, orgId, role, membership, claims, requestId }
//
// requestId is the value from the incoming X-Request-ID header (or a generated uuid).
export function authenticate(db, secret) {
  return function buildContext(req, params) {
    // Extract the bearer token from the Authorization header.
    const authHeader = req.headers['authorization'] ?? '';
    const [scheme, tokenStr] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !tokenStr) {
      throw unauthenticated('missing bearer token');
    }

    // Verify signature, expiry, alg, iss, aud, jti — throws 401 on any failure.
    const claims = verifyAccessToken(tokenStr, secret);

    // The token's org claim is the only org this request may address.
    // The route's :org parameter must match, otherwise the org is invisible (404).
    // We store orgId from the CLAIM, not from the URL — the URL is validated later
    // by assertOrg() inside each route.
    const userId = claims.sub;
    const orgId  = claims.org;

    // Look up the membership to:
    //   (a) confirm the org still exists and the user is still a member
    //   (b) check perm_version freshness
    const membership = db.prepare(
      `SELECT m.id, m.role, m.status, m.perm_version
         FROM memberships m
         JOIN organizations o ON o.id = m.org_id
        WHERE m.org_id = ? AND m.user_id = ?
          AND o.deleted_at IS NULL
        LIMIT 1`
    ).get(orgId, userId);

    // No membership in this org → treat as unauthenticated (the org is invisible).
    if (!membership) throw unauthenticated('not a member of this org');

    // Removed members have no authority.
    if (membership.status === 'removed') throw unauthenticated('membership removed');

    // Freshness check — pv mismatch means TOKEN_STALE.
    assertFresh(claims, membership);

    const requestId = req.headers['x-request-id'] || generateId();

    return { userId, orgId, role: membership.role, membership, claims, requestId };
  };
}

// Route-level helper: assert the URL's :org parameter matches the token's org.
// Used in route handlers to prevent cross-org addressing.
export function assertOrg(ctx, params) {
  if (!params.org) return; // route doesn't have an :org segment
  if (params.org !== ctx.orgId) {
    // The org either doesn't exist or belongs to someone else — return 404 in both cases.
    throw notFound('org not found');
  }
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}
