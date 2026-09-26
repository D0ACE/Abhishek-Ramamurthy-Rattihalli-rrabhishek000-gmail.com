# BUILD-LOG

Append to this as you go. Commit it with the code it describes — the timestamps are part of the
evidence, and a log that arrives in one commit at the end reads as what it is.

---

## Phase 0 — orientation

2026-09-26. Installed, loaded the DB (`node scripts/load-db.js`), read all four spec docs,
ran `check-jwt.js` against the untouched skeleton.

Starting line: 0/43 on JWT. Expected the stub to fail — it does, but the failure mode is
wrong. The stub throws a plain `Error` with `code: 'NOT_IMPLEMENTED'`, which is not an
`HttpError`. The test harness reports `Error: TODO...` instead of `401 UNAUTHENTICATED`.

This is the point of the test: a stub that throws unconditionally passes nothing, because
the shape of the rejection is also checked — not just that it throws, but that it throws
the *right* thing. A dumb always-reject stub would still fail all 43.

The load-db path issue (`A:\A:\...` doubled) happens on Windows when `new URL(p, import.meta.url).pathname`
produces a leading slash `/A:/...` that `fs.readFileSync` resolves with the current drive, yielding
a doubled drive letter. Fixed across `load-db.js` and `server/index.js` using `fileURLToPath(new URL(...))`
from `node:url`.

Also confirmed: `PRAGMA foreign_keys` must be set in `server/db.js` per-connection. It is
already set there (and verified: removing it lets `grant_permissions` accept unknown
permission strings like `device:teleport`, putting it back causes `FOREIGN KEY constraint failed`).

## Phase 1 — token verification

Implemented `verifyAccessToken` in `server/auth.js`. 43/43 tests passed in `node scripts/check-jwt.js`.

Expected the timing-safe comparison to be standard `crypto.timingSafeEqual`, but had to ensure
both signature buffers match in byte length before calling it, otherwise `timingSafeEqual` throws
a `RangeError` instead of returning false.

Rejection classes verified:
1. Malformed structure: null, undefined, wrong segment count (<3 or >3).
2. JSON decoding failures: non-JSON headers or payloads.
3. Algorithm confusion attacks: header specifying `none`, `HS512`, `RS256`, or missing `alg`/`typ`.
   Pinned strictly to `HS256` and `JWT`.
4. Signature verification: wrong secret, tampered message, truncated signature, non-base64url characters.
5. Expiration semantics: half-open interval where `exp == now` is considered expired (`exp <= now`).
6. Standard claims validation: `iss` must match `'remoteops'`, `aud` must match `'remoteops-console'`,
   and `jti` must be a non-empty string.
7. Token type separation: opaque refresh tokens or dotted refresh tokens presented as bearer tokens
   are rejected with 401.

## Phase 2 — caller context and the resolution engine

Implemented `server/context.js` and `server/permissions.js`. 35/35 tests passed in `node scripts/check-permissions.js`.

The model I started with assumed permission resolution would evaluate specificity — e.g. a
device-scoped grant might override an org-wide grant. The spec and tests broke this: D1 states
that **DENY wins unconditionally**. An org-wide deny cannot be carved out by a device-scoped allow.
Deny is collected before allow, regardless of scope.

Another critical discovery: `role.rank` is strictly **modification authority**, never permission
authority. Rank dictates who can promote, demote, or remove whom (`server/lifecycle.js`), but
answers zero permission questions. Auditor and Operator have different ranks, yet neither subsumes
the other: Auditor has `audit:read` and cannot control devices; Operator has `device:control` and
cannot read audit logs.

In `server/context.js`, structural isolation is enforced: if `:org` in the route does not match
the token's `claims.org`, we return `404 Not Found` (cross-org is invisible, never 403).
Furthermore, when a membership is suspended, its `perm_version` is bumped. If we asserted freshness
here, the caller would receive `401 TOKEN_STALE`. Instead, we bypass the freshness check specifically
for suspended members, allowing the request to proceed to the resolution engine where it is rejected
with `403 Forbidden (reason: "suspended")` and an empty permission set.

For list performance, implemented `resolveDevices()`: instead of calling `resolve()` per row (which
would cause 4 queries × N rows N+1 problem), it loads the catalogue, membership, and baseline once,
pulls all grants in one query, and filters in memory. No TTL or cache is used to avoid serving stale
authority or crossing org boundaries.

## Phase 3 — orgs, members, invites

Implemented `server/routes/orgs.js` and `server/routes/invites.js`.

Invite lifecycle:
- Invites are created with a secure random token; only the SHA-256 hash is persisted in `invites.token_hash`.
- The raw token is returned exactly once in the creation response.
- `GET /v1/invites/:token` is a public endpoint that displays the org name and invited role, but
  strictly leaks no organization ID, member list, or device inventory.
- Redeeming an invite (`POST /v1/invites/:token/accept`) creates the user if new, adds the membership,
  and updates invite status to `accepted` in a single transaction. Re-using an accepted invite returns 409 Conflict.

Member lifecycle & last-owner rule:
- A user cannot change their own role (prevents self-elevation or self-demotion lockout).
- A sole owner cannot leave or be demoted: `assertNotLastOwner` checks that at least one other active
  owner exists in the organization before permitting demotion or removal (returns 409 `LAST_OWNER`).
- Demoting or removing a user terminates their active exclusive sessions (`endActiveSessions`) and bumps
  `perm_version`.

## Phase 4 — devices and grants

Implemented `server/routes/devices.js`.

Grant creation enforces invariant 11 / D9: **no privilege laundering**.
The caller cannot grant permissions they do not hold at the specified scope.
`assertMayGrant()` expands wildcard patterns (e.g. `device:*`) against the database catalogue,
and verifies the caller has `allow` for each one. If an admin attempts to grant `org:delete` or `*`,
it is rejected with 403 `missing_permission`.
Unknown permission strings (e.g. `device:teleport`) fail foreign key validation against
`grant_permissions` -> `permission_patterns`, returning 400 `unknown_permission`.

Device decommissioning:
- `device:provision` is resolved per device; a deny on one device blocks decommissioning that specific
  device without impacting other devices.
- Decommissioning a device ends all active sessions associated with it.

## Phase 5 — sessions

Implemented `server/routes/sessions.js`.

Compound session check:
Starting a session requires both `session:start` AND the mode-specific permission (`device:view`,
`device:control`, or `device:terminal`) on that exact device.
The error responses explicitly distinguish the failure reasons:
- Missing `session:start` returns 403 `missing_permission`.
- Holding `session:start` but missing the mode permission returns 403 `missing_device_permission`.

Exclusive concurrency:
- Control and terminal sessions require exclusive access per device. This is enforced by SQLite's
  partial unique index `idx_sessions_exclusive_active` on `(device_id)` where `ended_at IS NULL AND mode != 'view'`.
  Attempting a concurrent exclusive session triggers a conflict, returning 409 `DEVICE_BUSY`.
- View mode sessions are non-exclusive: multiple view sessions can run concurrently on the same device.

Grandfathering:
- Demoting a user from Operator to Viewer does NOT kill their in-flight active session. The session
  survives until explicitly ended or expired. However, attempting to start a NEW session fails immediately
  due to the updated permission baseline.
- In contrast, account suspension is an integrity event, not a permission tweak: suspending a member
  immediately terminates all their active sessions with `end_reason = 'user_suspended'`.

## Phase 6 — audit

Implemented `server/audit.js` and audit trail endpoints.

The audit log is an immutable append-only record:
- SQLite triggers `trg_audit_no_update` and `trg_audit_no_delete` abort any `UPDATE` or `DELETE` operations.
- Audits record not only successful administrative actions and session events, but also **denied attempts**
  with full provenance (`reason`, `missing_permission`, `target_id`, `metadata`).
- Pagination parameters are strictly validated: `limit` must be within 1..100, `offset >= 0`. Out-of-bounds
  or non-integer queries return 400 Bad Request rather than being silently clamped.

## Phase 7 — the console

Implemented React SPA in `web/` with components for Login, Devices, People, Grants, Sessions, Audit,
Admin, and AcceptInvite.

Core UI contracts verified:
- Server-driven element presence: components check server-returned resolved permission maps and render
  `data-permission` with `data-state="unlocked"`. If a permission is denied, the element is completely
  absent from the DOM — never disabled or greyed out.
- Zero client-side role derivation: no `if (role === 'owner')` checks in the UI for capability gating.
- Multi-org visual identity: shell attaches `data-org-id` and `data-org-theme`, driving distinct CSS
  palettes for Acme Robotics vs Globex Corporation.
- Secure auth: access tokens remain in memory; refresh tokens are stored in `httpOnly` cookies.
  Page reloads restore the active session seamlessly via `/v1/auth/refresh`.

## Phase 8 — hardening and verification

Ran the complete suite:
- `node scripts/check-permissions.js`: 35/35 PASS
- `node scripts/check-jwt.js`: 43/43 PASS
- `node scripts/check-api.js`: 66/66 PASS
- `npx playwright test`: 25/25 PASS
- `node scripts/check-personalisation.js`: 18/18 PASS

Windows compatibility hardening:
- Replaced `new URL(..., import.meta.url).pathname` with `fileURLToPath(new URL(..., import.meta.url))`
  in `server/index.js` and `scripts/load-db.js` to eliminate malformed leading slashes and drive duplication.
- Ensured `npm run build` runs before production Playwright test execution.
- Fixed `package.json` `db:reset` script: replaced Unix `rm -f ... && npm run db:load` with `node scripts/load-db.js`,
  which uses Node's cross-platform `rmSync` to delete `.db`, `-wal`, and `-shm` files cleanly across both Windows and Unix.

## Open threads

1. Rate limiting on `/v1/auth/login` is deliberately omitted per specification scope, but would be
   essential in a public production environment to mitigate credential stuffing.
2. In-memory session tracking for the React client relies on refresh cookie rotation; background tab
   synchronization for simultaneous org switches across tabs could be coordinated via `BroadcastChannel`.

---

## Phase 9 — final security audit and submission validation

2026-09-26. Ran the complete test suite one final time from a clean `app.db` state:
- `node scripts/check-jwt.js`: 43/43 PASS
- `node scripts/check-permissions.js`: 35/35 PASS
- `node scripts/check-api.js`: 66/66 PASS
- `npx playwright test`: 25/25 PASS
- `node scripts/check-personalisation.js`: 18/18 PASS

**Security audit findings (all clear):**

1. **SQL injection**: One dynamic SQL construction in `server/lifecycle.js` (`endActiveSessions`). Inspected
   carefully — the `where` array contains only hardcoded string literals (`'org_id = ?'`, `'state = \'active\''`).
   No user-controlled input is interpolated into the SQL; all values flow through parameterized `?` placeholders. Safe.

2. **Client-controlled actor identity**: Audited all routes. `actorId` in every `audit()` call is derived from
   `ctx.userId` (JWT-verified), never from `ctx.body`. `ctx.userId` originates from `verifyAccessToken` in
   `server/auth.js` which pins HS256 and validates the signature before returning `claims.sub`. Safe.

3. **Cross-org IDOR**: Every query joining the `:org` route parameter with resource IDs (devices, grants, sessions,
   invites, members) includes `AND org_id = ?`. The `requireDevice()` helper uses `AND org_id = ?`.
   `context.js` structurally enforces that the path `:org` must match `claims.org`; any mismatch returns 404. Safe.

4. **Hardcoded IDs**: Searched all `server/` and `web/` files. Zero hardcoded org IDs, role IDs, permission IDs,
   or user IDs from the seed fixture.

5. **Dynamic database validation**: Queried the personalised `check-api.db` at runtime — 6 roles (including
   undocumented `reviewer`) and 20 permissions (including `device:reboot`). The `check-personalisation.js`
   passes 18/18, confirming the engine discovers these at runtime without code changes.

6. **Privilege laundering (D9)**: `assertMayGrant` in `permissions.js` resolves the caller's own permission set
   at the grant scope before permitting any grant creation. Tested against the spec's "admin cannot grant org:delete"
   case — confirmed 403.

7. **Refresh token replay**: `server/routes/auth.js` revokes the entire token family when a replay is detected
   (`UPDATE refresh_tokens SET revoked_at WHERE family_id`). Tested in `check-api.js` (implicit via invite flow).

**Observation on `People.jsx` ROLES array**: The hardcoded `ROLES` constant exists for UX convenience in the
invite dropdown. It does not affect security — the server validates the role against the `roles` table via
`assertRoleExists()`. A new role added to the DB does not appear in the dropdown without a frontend update.
This was originally logged as an acknowledged UX gap; addressed in Phase 10 below.

---

### Phase 10 — Dynamic Roles & Final Candidate Packaging

2026-09-26. Final submission preparation and dynamic role resolution implementation:

1. **Discovery**:
   The `People.jsx` component previously defined `const ROLES = ['owner', 'admin', 'operator', 'auditor', 'viewer']`.
   While the server authoritative checks (`assertRoleExists`) already validated roles against SQLite, any undocumented
   role loaded dynamically from the database (such as `reviewer` from the candidate nonce overlay) was absent from
   the member role-change dropdown and the invite prompt recommendation.

2. **Backend & Frontend Implementation**:
   - Added `GET /v1/orgs/:org/roles` and `GET /v1/roles` endpoints to `server/routes/orgs.js`. These query `SELECT key, label, rank FROM roles ORDER BY rank ASC` directly from SQLite and return `{ roles: string[], items: Role[] }`.
   - Updated `web/components/People.jsx`:
     - Removed the static `ROLES` constant completely.
     - Updated `load()` to fetch roles concurrently via `api.get('/orgs/' + org.id + '/roles')`.
     - Derived `availableRoles` dynamically from the server response combined with active members, ensuring complete role coverage.
     - Bound the role `<select>` and invite prompt to `availableRoles`.
   - Verified that `reviewer` from the personalised overlay is automatically discovered and rendered.

3. **Packaging & Candidate Spec Consolidation**:
   - Consolidated candidate-facing specifications (`BRIEF.md`, `PERMISSIONS.md`, `AUTH-DATA-MODEL.md`, `UI-INVENTORY.md`, `WORKFLOW.md`) into the candidate repository root alongside `DISCOVERY-BRIEF.md`.
   - Updated `README.md` to comprehensively document the single-process architecture, authentication and permission models, test execution instructions, and clean checkout instructions with zero placeholder tokens.
   - Cleaned all build and test artifacts before packaging.

4. **Verification**:
   - `npm run build`: Production bundle created cleanly (39 modules, 252 kB bundle).
   - `npm run db:reset`: Fresh database loaded with 3 orgs, 8 users, 20 permissions, 6 roles including `reviewer`.
   - `node scripts/check-jwt.js`: 43/43 PASS
   - `node scripts/check-permissions.js`: 35/35 PASS
   - `node scripts/check-api.js`: 66/66 PASS
   - `node scripts/check-personalisation.js`: 18/18 PASS
   - `npx playwright test`: 25/25 PASS


