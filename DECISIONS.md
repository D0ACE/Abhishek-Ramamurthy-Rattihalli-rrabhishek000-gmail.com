# DECISIONS

One section per decision that a reviewer might reasonably have made differently.

---

### 1. One engine, two evaluation modes (org-level union vs device-scoped)

**What I chose:**
`server/permissions.js` exports a single resolution engine (`resolve()`) that accepts an optional `deviceId`.
When `deviceId` is null, it evaluates the org-level union across all applicable grants (including device-scoped grants)
to drive navigation and card visibility. When `deviceId` is specified, it strictly scopes evaluation to org-wide grants
plus grants matching that specific device.

**Why:**
Tested in `tests/ui.spec.js` ("a device-scoped grant surfaces exactly one control") and `scripts/check-permissions.js`
(§4 D6). A viewer with a device-scoped grant for `session:start` on `lab-mac-01` must see the Devices card in the navigation
and be able to list devices, but when viewing `qa-android-01`, `session:start` must evaluate to deny (`reason: missing_permission`).
Having a separate function or separate code path for UI vs API would lead to privilege divergence; a single engine with an
explicit scope parameter ensures total consistency.

**What I rejected:**
Rejecting device-scoped grants entirely from the org-level view. If `deviceId == null` ignored device-scoped grants,
a viewer granted access to a single device would be locked out of the Devices section entirely because the nav guard
would report `missing_permission` for `device:list` / `device:view`.

**What would change my mind:**
If the specification required that org navigation be strictly dictated by role baselines rather than grant unions.

---

### 2. Batched in-memory resolution (`resolveDevices`) without a TTL cache

**What I chose:**
For device list endpoints, `resolveDevices()` in `server/permissions.js` executes a single batched query loading the
permission catalogue, caller membership, baseline, and all active grants for the organization, then maps permissions
to each device in memory. No TTL cache or persistent memory cache is used.

**Why:**
Avoids the classic N+1 query pattern (4 queries × N devices) while complying with D7 ("a grant that reaches its `expires_at`
becomes inert on the very next request; no restart, no sync delay"). A cache with even a 5-second TTL would serve
expired or revoked permissions, failing immediate revocation requirements.

**What I rejected:**
In-memory caching with TTL (e.g. 60 seconds). A cache keyed by `userId` alone would leak permissions across organizations.
A cache keyed by `(userId, orgId)` with a TTL would violate immediate revocation guarantees when grants are deleted or
memberships updated.

**What would change my mind:**
If the device count grew to tens of thousands per organization where query latency exceeded acceptable SLA, requiring
an event-driven invalidation cache (e.g., invalidating cache entries on `memberships.perm_version` bumps or grant changes).

---

### 3. Server-driven UI state with complete absence from DOM

**What I chose:**
In `web/components/`, elements requiring permissions are conditionally rendered based solely on the server's resolved
permission dictionary. Elements carry `data-permission` and `data-state="unlocked"`. If permission is denied, the element
is completely absent from the DOM. No role-based `if (role === 'admin')` derivation exists in the frontend.

**Why:**
Verified by `tests/ui.spec.js` ("a device the viewer cannot see is absent, not redacted" and "an element vanishes when the
server withdraws the permission"). Disabling buttons (e.g. `disabled` attribute) or hiding with CSS (`display: none`)
leaks functionality, DOM IDs, and administrative structure to unauthorized clients.

**What I rejected:**
Disabled buttons with tooltips or client-side role inspection. Client-side role checking duplicates permission logic and
fails when custom roles or grants alter the baseline.

**What would change my mind:**
A consumer-facing UX requirement where non-permitted features are deliberately shown as disabled with an "Upgrade / Request Access"
CTA.

---

### 4. Bypassing freshness check on suspended memberships to surface 403 `suspended`

**What I chose:**
In `server/context.js`, when checking token freshness against `memberships.perm_version`, we bypass `assertFresh` specifically
if `membership.status === 'suspended'`. The caller's request proceeds into the route and permission engine, which yields
an empty permission set and responds with `403 Forbidden` (`code: FORBIDDEN`, `reason: "suspended"`).

**Why:**
`scripts/check-api.js` line 144 asserts that a suspended member making a request receives 403 with reason `suspended`.
If `assertFresh` were run unconditionally, the bumped `perm_version` caused by the suspension would trigger `401 TOKEN_STALE`,
misleading the client into attempting a token refresh rather than acknowledging suspension.

**What I rejected:**
Not bumping `perm_version` on suspension. That would violate the schema invariant that every membership status change
increments `perm_version`.

**What would change my mind:**
If the client protocol explicitly treated suspension as a session termination requiring `401 UNAUTHENTICATED`.

---

### 5. Evaluating `session:*` permissions org-wide rather than device-scoped

**What I chose:**
In `server/routes/sessions.js`, `GET /v1/sessions/:id` and session termination (`DELETE /v1/sessions/:id`) assert
`session:view` and `session:terminate` at the org level (`deviceId = null`), rather than scoped to the session's device.

**Why:**
Per PERMISSIONS.md D6, device scoping applies to `device:*` permissions. `session:*` permissions are org-level authorities.
Scoping `session:view` to a device would allow a device-scoped grant to inadvertently elevate a user's session management
authority.

**What I rejected:**
Passing `session.device_id` into `assertCan(db, ctx, 'session:view', session.device_id)`.

**What would change my mind:**
If the specification introduced fine-grained `session:view:<deviceId>` or explicitly designated `session:*` as device-scoped.

---

### 6. Applying no-laundering check (D9) to both allow and deny grants

**What I chose:**
In `server/permissions.js`, `assertMayGrant` checks that the caller holds `allow` for every permission pattern being granted,
regardless of whether the grant effect is `allow` or `deny`.

**Why:**
PERMISSIONS.md §8 and D9 state: "You cannot grant a permission you do not hold." If an admin who lacks `org:delete` were allowed
to create a `deny` grant for `org:delete`, they would still be exerting administrative control over a permission outside
their scope.

**What I rejected:**
Exempting `deny` grants from `assertMayGrant`.

**What would change my mind:**
If an organization security model permitted operators to defensively restrict subordinate access on permissions they
themselves do not possess.

---

### 7. Token architecture: in-memory access tokens, httpOnly rotating refresh cookies

**What I chose:**
Access tokens are short-lived JWTs held strictly in application memory (never written to `localStorage` or `sessionStorage`).
Refresh tokens are opaque UUIDs stored in `HttpOnly`, `Secure`, `SameSite=Strict` cookies with a 30-day lifetime (`Max-Age=2592000`), backed by hashed database records with
`family_id` tracking for rotation lineage.

**Why:**
Verified by `tests/ui.spec.js` ("no token is persisted in web storage" and "a reload restores the session from the refresh cookie").
Storing tokens in web storage exposes them to XSS exfiltration.

**What I rejected:**
Storing access tokens in `localStorage` or `sessionStorage`.

**What would change my mind:**
If the application had to run in a cross-origin multi-domain environment where `httpOnly` third-party cookies are blocked by modern browsers.

---

### 8. Enforcing session exclusivity via SQLite partial unique index

**What I chose:**
Exclusive active device sessions (control and terminal) are enforced via the schema partial index
`idx_sessions_exclusive_active` on `(device_id)` where `ended_at IS NULL AND mode != 'view'`.
Application logic catches SQLite constraint violations (`SQLITE_CONSTRAINT_UNIQUE`) and returns `409 Conflict` (`DEVICE_BUSY`).

**Why:**
Guarantees atomicity under concurrent requests. Application-level check-then-act (`SELECT` then `INSERT`) suffers from race
conditions under parallel requests.

**What I rejected:**
In-process mutexes or application-level `SELECT count(*)` checks before insertion.

**What would change my mind:**
If session scheduling or queuing were introduced, requiring soft locks rather than immediate failure on concurrency.

---

### 9. Structural organization isolation: wrong org in route returns 404, not 403

**What I chose:**
In `server/context.js`, if a route contains an `:org` parameter that differs from the JWT's `claims.org`, the server throws
`404 Not Found`.

**Why:**
Verified by `scripts/check-api.js` (§6 "cross-org is INVISIBLE, not forbidden — got 404, body carries no org data").
Returning 403 reveals the existence of an organization to an unauthorized caller. 404 ensures the organization remains
completely invisible.

**What I rejected:**
Returning `403 Forbidden` for cross-org requests.

**What would change my mind:**
If the API was designed for multi-tenant federation where organization names and IDs are public metadata.

---

## Where this repo argues with itself

1. **Suspension vs Token Freshness:**
   - *Conflict:* `AUTH-DATA-MODEL.md §1` specifies that suspending a membership increments `perm_version`, which causes
     `assertFresh` to reject requests with `401 TOKEN_STALE`. However, `AUTH-DATA-MODEL.md §10` and `PERMISSIONS.md §7` specify
     that requests with a suspended membership's token must be refused with `403 Forbidden` (`reason: "suspended"`).
   - *Resolution:* In `server/context.js`, we bypass `assertFresh` if `membership.status === 'suspended'`. The version bump
     remains in place for eventual reinstatement, but the active request is allowed to reach the authorization engine where
     it receives the intended 403 `suspended` response.

2. **Scope of `device:provision` on Decommission:**
   - *Conflict:* The endpoint specification table lists `device:provision` as an un-scoped org-level permission, whereas
     `UI-INVENTORY.md §3` categorizes `decommission-device` as a per-row device-scoped action.
   - *Resolution:* We resolve `device:provision` against the specific device being decommissioned. An explicit deny on
     `dev_01` prevents decommissioning `dev_01`, while leaving decommissioning authority intact for `dev_02`.

---

## Deliberately not built

1. **Password reset & email delivery:**
   Out of scope. User invitations return a raw token in the API response rather than dispatching SMTP emails.
2. **Rate limiting:**
   Omitted to ensure test suites can execute hundreds of rapid sequential and parallel requests without artificial throttling.
3. **Audit log archival / rotation:**
   The audit table is strictly append-only, enforced by SQLite triggers `trg_audit_no_update` and `trg_audit_no_delete`.
   Automatic retention pruning was deliberately omitted to preserve forensic integrity.

---

### 10. Hardcoded role list in `People.jsx` vs server-driven role discovery

**Initial Assessment (Phase 4):**
Originally, `People.jsx` used a local array `const ROLES = ['owner', 'admin', 'operator', 'auditor', 'viewer']`
for the role select dropdown and invite prompt hint. The server remained the ultimate authority via `assertRoleExists()`,
rejecting invalid roles with `400 VALIDATION` / `unknown_role`.

**Decision Evolution (Phase 10):**
During final submission packaging and audit against the personalised database overlay, we observed that custom
roles (such as `reviewer` in the candidate nonce overlay, or other dynamic roles configured in SQLite) were
unreachable via the UI dropdown. To eliminate any reliance on hardcoded client-side role definitions, we
implemented dynamic role discovery:

1. **Backend Endpoint**:
   Added `GET /v1/orgs/:org/roles` (and `GET /v1/roles`) returning `{ roles, items }` queried directly from SQLite:
   `SELECT key, label, rank FROM roles ORDER BY rank ASC`.
2. **Frontend Dynamic Consumption**:
   `People.jsx` now fetches roles concurrently during `load()` via `api.get('/orgs/' + org.id + '/roles')` and
   constructs the dropdown and prompt recommendations dynamically.
3. **Backend Authoritativeness**:
   The backend continues to enforce role validity via `assertRoleExists()` and rank authority via `assertCanModify()`.
   The frontend purely presents server truth.

**What I rejected:**
- Retaining the static 5-role array in React. Rejected because it breaks extensibility for personalised and custom database roles.
- Hardcoding the `reviewer` role into the client array alongside the 5 documented roles. Rejected because hardcoding specific test fixture roles is a brittle anti-pattern.

**Verification:**
Verified by running `npm run db:reset` and confirming the runtime database contained 6 roles (`viewer`, `auditor`, `operator`, `reviewer`, `admin`, `owner`). The role selection dropdown and invite prompt dynamically populated with all 6 roles. All 25 Playwright tests, 66 API tests, 35 permission tests, and 18 personalisation tests pass.

---

### 11. Permission resolution context vs grant-authority scope (Privilege Laundering A3)

**Problem:**
`assertMayGrant()` previously resolved the caller's authority using `resolve(db, { ...ctx, deviceId })`.
For org-wide grants (`deviceId === null`), the resolver intentionally evaluates the union across all devices
so that UI navigation icons light up if a caller can act on *some* device. However, this created a subtle
privilege laundering vulnerability: a caller holding `device:control` strictly on a single device could grant
`device:control` org-wide, conferencing authority they did not hold at true org scope.

**What I initially expected:**
Using `resolve(db, { ...ctx, deviceId: null })` would reflect the caller's org-level authority.

**What actually happened:**
Because `collectGrants` includes device-scoped grants when `deviceId === null` to support UI navigation,
a device-scoped grant elevated the caller's apparent org-level permissions in `assertMayGrant`.

**Decision:**
Distinguish permission-resolution context from grant-authority scope:
1. Extended `collectGrants` and `resolve` with an `orgScopeOnly` boolean flag.
2. In `assertMayGrant`, when evaluating authority for an org-wide grant (`deviceId === null`), enforce
   `orgScopeOnly: true`. This restricts applicable grants strictly to `g.device_id IS NULL` and role baselines.
3. For device-scoped grants (`deviceId !== null`), evaluate authority against the specific target device.
4. Preserved normal `resolve(db, ctx)` union behavior for navigation and UI cards.

**Alternative rejected:**
Altering `resolve(null)` globally to exclude device grants. Rejected because UI navigation contract requires
nav cards and sections to be present if the user has authority on any device in the organization.

**Why rejected:**
Would break the console contract and cause navigation items to disappear for operators with device-scoped grants.



