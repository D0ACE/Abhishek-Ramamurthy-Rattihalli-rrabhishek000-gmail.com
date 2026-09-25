// JWT and password hashing, hand-rolled on node:crypto.
//
// Nothing here is hidden behind a library on purpose. Signing is done for you;
// `verifyAccessToken` below is a stub you have to implement. The rules it must
// enforce are in AUTH-DATA-MODEL.md §10 and restated in the TODO comment.
//
// The payload is base64, NOT encrypted. Never put a secret in it.

import { createHmac, timingSafeEqual, randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { unauthenticated, tokenStale } from './http.js';
const ALG = 'HS256';
const ISS = 'remoteops';
const AUD = 'remoteops-api';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (str) => Buffer.from(str, 'base64url');

export function signToken(claims, secret) {
  const header = { alg: ALG, typ: 'JWT' };
  const h = b64(JSON.stringify(header));
  const p = b64(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64(sig)}`;
}

// Issue an access token. Note what is NOT in here: the resolved permission set.
// The token carries the authorization INPUTS (org, role, pv); the server resolves
// the permissions. See AUTH-DATA-MODEL.md §1 (D11).
export function issueAccessToken({ userId, orgId, role, permVersion }, secret) {
  const now = Math.floor(Date.now() / 1000);
  return signToken(
    {
      iss: ISS,
      aud: AUD,
      sub: userId,
      org: orgId,
      role,
      pv: permVersion,
      jti: randomUUID(),
      iat: now,
      exp: now + ACCESS_TTL_SECONDS,
    },
    secret
  );
}

// ---------------------------------------------------------------------------
// TODO — yours to implement.
//
// Verify an access token and return its claims, or throw `unauthenticated(...)`.
// The signing half above is done for you; the verifying half is the exercise.
//
// It must reject ALL of the following, each with a 401 UNAUTHENTICATED:
//
//   1. a token that is not three dot-separated segments
//   2. a header or payload that is not valid base64url-encoded JSON
//   3. a header whose `alg` is anything other than 'HS256', or whose `typ` is not 'JWT'
//      -- read the header, do NOT trust it. This is the `alg: none` and
//         algorithm-substitution defence. The constants ALG, ISS and AUD are above.
//   4. a signature that does not match, compared in constant time
//   5. an `exp` that is missing, not a number, or <= now (note: <=, not <)
//   6. an `iss` or `aud` that is not ours
//   7. a missing or empty `jti`
//
// On success, return the decoded claims object.
//
// AUTH-DATA-MODEL.md §10 lists the failure modes; §2 defines the claim set.
// `node scripts/check-jwt.js` is the public test suite for this function.
// ---------------------------------------------------------------------------
export function verifyAccessToken(token, secret) {
  // Step 1: structural check — must be exactly three dot-separated segments.
  // Anything else (opaque refresh tokens, null, one segment, four segments) fails here.
  if (typeof token !== 'string' || !token) throw unauthenticated('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthenticated('malformed token');

  const [rawHeader, rawPayload, rawSig] = parts;

  // Step 2: decode the header and verify it is the one we expect.
  // We do NOT trust the header's alg field to select the algorithm — we always use HS256.
  // We check the header's values to catch alg:none and algorithm-substitution attacks.
  let header;
  try {
    const text = unb64(rawHeader).toString('utf8');
    header = JSON.parse(text);
  } catch {
    throw unauthenticated('malformed token header');
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw unauthenticated('malformed token header');
  }
  if (header.alg !== ALG) throw unauthenticated('unsupported algorithm');
  if (header.typ !== 'JWT') throw unauthenticated('unsupported token type');

  // Step 3: verify the signature in constant time before touching the payload.
  // We recompute over exactly `{header}.{payload}` using HS256 regardless of the header.
  // timingSafeEqual requires equal-length buffers; if the supplied sig has a different
  // length we know it's wrong but must still compare to avoid timing oracle.
  let sigActual;
  try {
    sigActual = unb64(rawSig);
  } catch {
    throw unauthenticated('malformed token signature');
  }
  const sigExpected = createHmac('sha256', secret)
    .update(`${rawHeader}.${rawPayload}`)
    .digest();

  if (sigActual.length !== sigExpected.length) throw unauthenticated('invalid signature');
  if (!timingSafeEqual(sigActual, sigExpected)) throw unauthenticated('invalid signature');

  // Step 4: decode the payload (we now know it was signed by us).
  let claims;
  try {
    const text = unb64(rawPayload).toString('utf8');
    claims = JSON.parse(text);
  } catch {
    throw unauthenticated('malformed token payload');
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw unauthenticated('malformed token payload');
  }

  // Step 5: validate exp — half-open means exp == now is already expired.
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number') throw unauthenticated('missing or invalid exp');
  if (claims.exp <= now) throw unauthenticated('token expired');

  // Step 6: validate iss and aud.
  if (claims.iss !== ISS) throw unauthenticated('invalid issuer');
  if (claims.aud !== AUD) throw unauthenticated('invalid audience');

  // Step 7: validate jti — must be a non-empty string.
  if (!claims.jti || typeof claims.jti !== 'string') throw unauthenticated('missing jti');

  return claims;
}



// The freshness check (AUTH-DATA-MODEL.md §3). Compares the token's pv against the
// membership's current perm_version. Note `!==`, not `<`: a token from the future is
// as suspect as a stale one.
export function assertFresh(claims, membership) {
  if (!membership) throw unauthenticated('not a member of this org');
  if (membership.perm_version !== claims.pv) throw tokenStale();
}

// --- opaque credentials: refresh tokens and invite tokens -------------------
//
// Both are bearer credentials that live in a database, so both are stored hashed —
// never plaintext, and never reversible. But they are DIFFERENT credentials, so they
// get DIFFERENT hash domains: sharing one would let a value from one table be compared
// against the other, which is a pointless and avoidable correlation.
//
// The key is an application secret, not a hardcoded literal. A hardcoded key means the
// hash is brute-forceable offline by anyone who reads this file — which defeats the
// point of hashing a high-entropy token.

export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const newInviteToken  = () => randomBytes(32).toString('base64url');

const APP_HASH_KEY = process.env.APP_HASH_KEY ?? 'dev-only-app-hash-key-change-me';

export const hashRefreshToken = (raw) =>
  createHmac('sha256', `${APP_HASH_KEY}:refresh`).update(raw).digest('hex');

export const hashInviteToken = (raw) =>
  createHmac('sha256', `${APP_HASH_KEY}:invite`).update(raw).digest('hex');

// --- passwords --------------------------------------------------------------

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
