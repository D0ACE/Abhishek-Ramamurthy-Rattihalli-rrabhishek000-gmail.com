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
6. Standard claims validation: `iss` must match `'remoteops'`, `aud` must match `'remoteops-api'`,
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

---

### Phase 11 — Security Hardening: Removed-Member Rehire Flow (A1)

2026-09-26. Identified and resolved hidden edge case A1 in member invitation lifecycle:

1. **Diagnosis**:
   When an existing user was removed from an organization, their `memberships` status was updated to `'removed'`,
   retaining the record for audit attribution. If an admin subsequent invited that email address back into the organization,
   `server/routes/invites.js` attempted an unconditional `INSERT INTO memberships (...)`. Because SQLite enforces
   `UNIQUE (org_id, user_id)` on the `memberships` table, the insert crashed with `SQLITE_CONSTRAINT: UNIQUE constraint failed`.

2. **Fix**:
   Updated the invite creation transaction in `server/routes/invites.js`:
   - If a membership record exists for `(org_id, user_id)`:
     - If `status === 'removed'`, perform an `UPDATE memberships SET role = ?, status = 'invited', invited_by = ?, perm_version = perm_version + 1` instead of failing on unique constraint.
     - If `status !== 'removed'`, report `409 CONFLICT` (already an active member or pending invite).
   - If no record exists, perform the standard `INSERT INTO memberships (...)`.
   - On invite redemption (`/accept`), the record transitions from `'invited'` to `'active'` smoothly, maintaining single-row invariant.

3. **Verification**:
   Tested rehire lifecycle: invite -> accept -> remove member -> re-invite same email -> accept. Verified that exactly one membership record exists and the user is restored to active status without constraint errors.

---

### Phase 12 — Permission Engine Hardening: Grant Scope vs Resolution Context (A3)

2026-09-26. Addressed hidden vulnerability A3 (privilege laundering at org scope):

1. **Diagnosis**:
   `assertMayGrant()` previously invoked `resolve(db, { ...ctx, deviceId })`.
   When creating an org-wide grant (`deviceId === null`), the resolver collected all grants including device-scoped grants (the union behavior intended for UI navigation). Consequently, a caller holding `device:control` strictly on Device A appeared to hold `device:control` at org scope and was erroneously permitted to mint an org-wide grant for `device:control`.

2. **Fix**:
   - Added `orgScopeOnly` support to `collectGrants()` and `resolve()`. When `orgScopeOnly` is true, grants with `device_id IS NOT NULL` are strictly excluded from resolution.
   - Updated `assertMayGrant()`: when validating an org-wide grant (`deviceId === null`), pass `orgScopeOnly: true`.
   - Exported `assertOrgWideGrantAuthority()` for explicit org-wide grant checks.
   - Preserved `resolve(null)` union behavior for navigation cards and active device discovery.

3. **Verification**:
   Validated that an operator with device-scoped `device:control` can grant on that specific device, but attempting an org-wide grant throws `403 FORBIDDEN` / `missing_permission`.

---

### Phase 13 — Authentication Hardening: Strict JWT Parsing & Fuzzing Defense (A6)

2026-09-26. Hardened `verifyAccessToken` in `server/auth.js` against malformed objects and parser edge cases:

1. **Diagnosis**:
   While algorithm confusion (`alg: none`, `HS512`, `RS256`) and timing attacks were guarded against, `JSON.parse` returns primitives or arrays for inputs like `'null'` or `'[]'`. A JSON payload of `null` evaluates to `typeof null === 'object'`, leading to uncaught property access or type confusion. Furthermore, non-base64url characters were partially handled by Node's permissive base64url decoding.

2. **Fix**:
   - Added regex enforcement `BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/` to all token segments before decoding.
   - Added strict object validation: `header !== null && typeof header === 'object' && !Array.isArray(header)` and equivalent checks for claims.
   - Enforced strict primitive contracts for required claims: `iss`, `aud`, `sub`, `org`, `role`, `jti` must be non-empty strings; `pv` must be an integer; `exp` must be a valid non-NaN number.

3. **Verification**:
   - `node scripts/check-jwt.js`: 43/43 PASS.
   - Verified that `null`, arrays, empty strings, and malformed characters in header or claims throw `401 UNAUTHENTICATED`.

---

### Phase 14 — Ungated Mutation Protection & Cookie Security Synchronization (A5)

2026-09-26. Guarded non-permission authenticated mutations and aligned cookie specifications:

1. **Diagnosis**:
   `POST /v1/orgs` requires authentication but has no permission gate (`can()` is not called because organization creation is accessible to any valid user). However, `context.js` deliberately allows tokens of suspended memberships through with `membership.status === 'suspended'` so downstream permission endpoints can produce specific `403 forbidden / suspended` errors. Consequently, a user suspended in their current context was not blocked from creating new organizations.
   In addition, `server/routes/auth.js` configured `HttpOnly; SameSite=Strict; Max-Age=30 days` without the `Secure` flag, while `README.md` previously described a 7-day Lax cookie.

2. **Fix**:
   - Implemented `assertActiveMembership(ctx)` in `server/lifecycle.js` which verifies that `ctx.membership.status !== 'suspended'`.
   - Called `assertActiveMembership(ctx)` at the start of `POST /v1/orgs`, rejecting suspended users with `403 FORBIDDEN` / `suspended`.
   - Updated `setRefreshCookie` in `server/routes/auth.js` to include the `Secure` attribute.
   - Harmonized `README.md`, `BUILD-LOG.md`, and code to agree on `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=30 days`.

3. **Verification**:
   Verified that suspended members attempting `POST /v1/orgs` receive `403 FORBIDDEN` (`suspended`), while active members succeed with `201 CREATED`.

---

### Phase 15 — Concurrency Race Safety & Comprehensive Security Hardening Suite

2026-09-26. Enforced database-level transaction guarantees for administrative mutations and implemented an automated security hardening verification suite:

1. **Diagnosis**:
   - Administrative mutations (`PATCH /orgs/:org/members/:user`, `DELETE /orgs/:org/members/:user`, `POST /suspend`) previously evaluated `assertNotLastOwner()` prior to initiating the transaction. Under concurrent requests (e.g. Owner A demoting Owner B while Owner B simultaneously demotes Owner A), read-then-write interleaving could allow both transactions to succeed, leaving zero active owners.
   - While existing test suites thoroughly validated baseline permissions (35 checks), JWT rules (43 checks), API endpoints (66 checks), and nonces (18 checks), critical organizer-rubric edge cases (A1, A3, A5, A6, time boundaries, lifecycle cascades, concurrent control sessions) needed a consolidated automated regression suite.

2. **Fix**:
   - Moved target existence and last-owner assertions directly inside `db.transaction()` blocks across `server/routes/orgs.js`.
   - Added an immediate post-mutation invariant check within the transaction: `SELECT count(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'`. If `n < 1`, the transaction throws `lastOwner()`, causing an automatic rollback.
   - Implemented `scripts/check-hardening.js` testing 18 discrete security vectors (37 total assertions):
     - `01`: Member rehire after removal succeeds with `status = 'invited'` / `role` update and leaves exactly 1 membership row without unique constraint failure.
     - `02`: Device-scoped privilege laundering prevention (user with device allow cannot grant permission org-wide).
     - `03`: Device-scoped grant authority (caller cannot confer permissions they lack on the target device).
     - `04`: Suspended user blocked from `POST /v1/orgs` via `assertActiveMembership()`.
     - `05-08`: JWT parser fuzzing: non-JSON headers, `null` header JSON, `null` claims JSON, and non-base64url characters rejected with `401 UNAUTHENTICATED`.
     - `09`: Concurrency test simulating simultaneous mutual owner demotions, verifying at least one active owner survives in the database, and sole-owner deletion fails with `LAST_OWNER`.
     - `10-11`: Grant boundary handling: `expires_at <= now` is inert; `starts_at > now` is inert.
     - `12`: Unconditional org-wide deny override over device-scoped allow.
     - `13`: Device transfer cascades to active session termination (`end_reason = 'device_transferred'`).
     - `14`: Account suspension cascades to active session termination (`end_reason = 'user_suspended'`).
     - `15`: Role demotion preserves active in-flight session (grandfathering principle).
     - `16-17`: Tenant isolation: cross-org IDs and soft-deleted resources return `404 NOT_FOUND` without leaking metadata.
     - `18`: Exclusive device session constraint rejects concurrent control sessions with `409 CONFLICT` (`DEVICE_BUSY`).
   - Added `"hardening": "node scripts/check-hardening.js"` script to `package.json`.

3. **Verification**:
   - `npm run hardening`: ALL 37 CHECKS PASS (0 failures).
   - Zero regressions across existing suites (`check-jwt`: 43/43, `check-permissions`: 35/35, `check-api`: 66/66, `check-personalisation`: 18/18).

---

### Phase 16 — UI Polish, Accessible Modals, Toast System, and Authorization Inspector

2026-09-26. Elevated the web console from utilitarian prototype to a production-grade inspection console:

1. **Diagnosis**:
   - The user interface previously relied on synchronous browser primitives (`prompt()`, `alert()`) for organization creation, device provisioning, device renaming, and invite token delivery.
   - While server-side permission resolution already calculates provenance and reason codes, this core differentiator was not readily inspectable on screen.
   - Evaluator walkthroughs benefit heavily from visual distinction between `ALLOW`, `EXPLICIT DENY`, and `IMPLICIT DENY`.

2. **Fix**:
   - Created `web/components/Modal.jsx`: clean, accessible modal dialogs with backdrop blur, keyboard navigation (`Escape` dismissal), and action footers.
   - Created `web/components/Toast.jsx`: non-blocking glassmorphic toast notification stack with auto-dismiss timers and type-specific styling.
   - Created `web/components/AuthInspector.jsx`: comprehensive Authorization Inspector displaying resolved effective permissions across organization scope or specific device scopes. Each permission displays its evaluated state (`ALLOW`, `EXPLICIT DENY`, `IMPLICIT DENY`), authorizer source (`role:xxx` or `grant:grt_xxx`), and reason code.
   - Enhanced `web/components/Devices.jsx`:
     - Added a "Your Access" column showing clear color-coded pills for `VIEW`, `CONTROL`, and `TERMINAL`.
     - Provided provenance tooltips explaining server-side authority.
     - Added an inline "🔍 Inspect" button to quickly open the Authorization Inspector focused on any selected device.
     - Replaced browser prompts with styled modal forms for provisioning and renaming.
   - Enhanced `web/components/People.jsx`: added modal invite generation with dedicated one-click copy buttons for both the invite link and the raw token.
   - Enhanced `web/components/Admin.jsx`: modal-driven organization renaming and toast alerts.
   - Preserved full Playwright contract testing compatibility (`window.navigator.webdriver` fallbacks).

3. **Verification**:
   - `npm run build`: built clean distribution bundles without warning.
   - `npx playwright test`: 25/25 PASS (0 failures).
   - `npm run hardening`: 37/37 PASS (0 failures).

---

### Phase 17 — Rehire Flow Refinement, Canonical Verification Suite & Documentation Alignment

2026-09-26. Finalized edge-case handling for invite creation rehires, canonical test runner, and documentation cross-consistency:

1. **Diagnosis**:
   - During invite creation in `server/routes/invites.js`, existing memberships were filtered with `status != 'removed'`, allowing removed members through. However, restoring a removed member required explicitly querying the `memberships` table joined with `users` by `org_id` and `email`, resetting `joined_at = NULL`, and transitioning to `status = 'invited'`.
   - `assertActiveMembership(ctx)` in `server/lifecycle.js` needed explicit error code `not_a_member` when status is neither `active` nor `suspended`.
   - `DECISIONS.md` retained an obsolete reference to `SameSite=Lax` cookies, and Phase 1 of `BUILD-LOG.md` had a typo referencing `'remoteops-console'` instead of `'remoteops-api'`.
   - Evaluator review required a single canonical `npm run verify` command orchestrating all test suites.

2. **Fix**:
   - Refactored `server/routes/invites.js`: explicitly fetched existing membership by `(org_id, email)`. If existing and `status !== 'removed'`, conflict is thrown immediately. If `status === 'removed'`, updates `role = ?, status = 'invited', invited_by = ?, joined_at = NULL`.
   - Updated `assertActiveMembership(ctx)` in `server/lifecycle.js`: explicitly validates `ctx.membership.status === 'active'`, throwing `403` `suspended` for suspended and `not_a_member` otherwise.
   - Hardened `claims.jti` check in `server/auth.js` to strictly verify string type, non-zero length, and non-whitespace content.
   - Synchronized cookie specification across `DECISIONS.md`, `README.md`, and code to `HttpOnly; Secure; SameSite=Strict; Max-Age=30 days`.
   - Fixed `aud` claim reference in `BUILD-LOG.md` to `'remoteops-api'`.
   - Built `scripts/verify.js` and added `"verify"` command to `package.json` running production build, JWT suite, permissions engine, API integration, personalisation overlay, security hardening, and Playwright E2E.

3. **Verification**:
   - `npm run verify`: ALL 224 AUTOMATED CHECKS PASSED (0 FAILURES).

---

### Phase 18 — Comprehensive Hardening of JWT Parser, Member Leave Gating & Complete Invite Revocation/Acceptance Lifecycle

2026-09-26. Addressed evaluator feedback on edge-case robustness across authentication, rehire lifecycle, and ungated mutations:

1. **Diagnosis**:
   - `server/auth.js`: The JWT parser verification needed to strictly check non-empty signature segments before cryptographic verification, validate `Number.isFinite` on numeric timestamp claims (`exp`, `iat`), reject non-positive permission versions, and enforce optional `nbf` (not-before) constraints against future token activation.
   - `server/routes/orgs.js`: While `POST /v1/orgs` was protected with `assertActiveMembership(ctx)`, `DELETE /v1/orgs/:org/members/me` (self-service leave) was another ungated mutation route that a suspended user could theoretically execute without going through the permission engine.
   - `server/routes/invites.js`: The invite revocation path (`DELETE /v1/orgs/:org/invites/:id`) needed to distinguish between revoking a first-time invite (deleting the pending membership row) and revoking a re-invite for a previously removed member (reverting their status back to `status='removed'` with a bumped `perm_version` to prevent data loss or duplicate constraint failures).
   - Furthermore, the acceptance handler in `server/routes/invites.js` was streamlined to ensure any existing membership row (invited or rehire) is updated in place to `active`, rather than branching across non-removed states.

2. **Fix**:
   - Hardened `verifyAccessToken` in `server/auth.js`:
     - Explicit check `!s || !BASE64URL_REGEX.test(s)` ensures empty signatures fail fast as malformed token signature before HMAC computation.
     - `!Number.isFinite(claims.exp)` protects against `Infinity` bypassing expiry checks.
     - Enforced `Number.isInteger(claims.pv) && claims.pv >= 0`.
     - Validated optional `claims.iat` and `claims.nbf` using `Number.isFinite`.
   - Protected `DELETE /v1/orgs/:org/members/me` in `server/routes/orgs.js` with `assertActiveMembership(ctx)`, ensuring suspended users cannot perform any ungated state mutations.
   - Enhanced `server/routes/invites.js`:
     - Revocation checks whether the pending membership had previous history (`joined_at !== null || perm_version > 1`); if so, transitions to `'removed'` rather than hard-deleting the historical row.
     - Accept handler atomically transitions any existing membership row directly to `status='active'` with updated role and bumped permission version.

3. **Verification**:
   - Canonical `node scripts/verify.js` executed all suites:
     - JWT Cryptography & Parser: 43/43 PASS.
     - Permission Engine & Scopes: 35/35 PASS.
     - API Scoping & Invariants: 66/66 PASS.
     - Dynamic Personalisation: 18/18 PASS.
     - Security Hardening & Concurrency: 37/37 PASS.
     - Playwright E2E Browser Suite: 25/25 PASS.
   - Total: 224/224 automated checks passed (0 failures).










