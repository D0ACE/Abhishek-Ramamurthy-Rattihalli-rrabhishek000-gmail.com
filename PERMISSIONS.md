# Permissions — how the model works

This document explains the permission model: what the pieces are, how a permission question gets
answered, and where the judgement calls are. It states behaviour, not implementation — how the
engine is built, structured and cached is the candidate's decision.

The database schema and its reference data are the ground truth. Where this document and the
schema disagree, the schema wins.

---

## 1. The pieces

```
Organization ─┬─ Membership ─── User
              │                    │
              ├─ Device ───────────┤
              ├─ Grant ────────────┘   user × device? × permissions × effect × window
              ├─ Session               user × device × mode × state
              └─ AuditEvent
```

A **role** is a named bundle of permissions. It is not a level, and it is not a rank in the
permission sense — the numbers in `roles.rank` exist only for the one rule that needs an order,
who may modify whom (§6). Never use them to answer a permission question.

A **grant** is a per-user change to the bundle: an effect (`allow` or `deny`), an optional
device, and an optional window. A grant can widen past the role or narrow it.

**Effective permissions** are the result of combining the two. They are what the API reports and
what the console renders.

Every permission question names a permission and, for device permissions, a device. Never just
`can(user, permission)` — device scope is always part of the question.

---

## 2. What the database already holds

You don't need to invent any of this; it is already in the database as reference data, and it is
the single source of truth.

`roles` — five rows, with a label and a modification rank. There is no API that mutates them.

`permissions` — the nineteen permissions across six resources:

| Resource | Permissions |
|---|---|
| device | `list`, `view`, `control`, `terminal`, `file_transfer`, `provision`, `update` |
| session | `start`, `view`, `terminate` |
| grant | `create`, `revoke` |
| user | `read`, `invite`, `role:update`, `remove` |
| audit | `read` |
| org | `update`, `delete` |

`role_permissions` — the baselines. Grants add to or subtract from these.

| Permission | owner | admin | operator | auditor | viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| `device:list` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `device:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `device:control` | ✓ | ✓ | ✓ | — | — |
| `device:terminal` | ✓ | ✓ | ✓ | — | — |
| `device:file_transfer` | ✓ | ✓ | ✓ | — | — |
| `device:provision` | ✓ | ✓ | — | — | — |
| `device:update` | ✓ | ✓ | — | — | — |
| `session:start` | ✓ | ✓ | ✓ | — | — |
| `session:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `session:terminate` | ✓ | ✓ | — | — | — |
| `grant:create` | ✓ | ✓ | — | — | — |
| `grant:revoke` | ✓ | ✓ | — | — | — |
| `user:read` | ✓ | ✓ | — | ✓ | ✓ |
| `user:invite` | ✓ | ✓ | — | — | — |
| `user:role:update` | ✓ | ✓ | — | — | — |
| `user:remove` | ✓ | ✓ | — | — | — |
| `audit:read` | ✓ | ✓ | — | ✓ | — |
| `org:update` | ✓ | ✓ | — | — | — |
| `org:delete` | ✓ | — | — | — | — |

Worth noticing: `auditor` and `operator` are incomparable. `auditor` has `audit:read` and no
control permission; `operator` is the exact inverse. Neither contains the other, which is why
modelling roles as an integer privilege level produces wrong answers.

`permission_patterns` — the permissions table plus the wildcards (`device:*`, `session:*`,
`grant:*`, `user:*`, `audit:*`, `org:*`, `*`). It exists for one reason: a grant may name
`device:*`, but a typo like `device:teleport` must still be rejected. The foreign key on
`grant_permissions` points here, so an unknown permission is a database error rather than a
silent deny.

`role_permissions` is reference data. There is no endpoint that mutates it, and nothing in the
console should duplicate it.

---

## 3. Answering a permission question

Resolve fresh on every request. In order:

1. **Identity first.** A deleted or suspended user has no permissions anywhere.
2. **Membership.** If the caller isn't a member of the org the resource belongs to, the resource
   is not visible — and invisibility is a `404`, not a `403` (§7).
3. **Deny wins.** Collect the grants that apply to this question right now, at this scope. If any
   of them denies the permission, the answer is deny, and it says which grant.
4. **Otherwise allow**, if either the role baseline contains the permission or an applicable
   allow grant does. The answer says which of the two.
5. **Otherwise deny**, implicitly: `source: null`, `reason: "implicit"`.

Two evaluation contexts, resolved the same way:

- **org-level** (nav, page gating) — the union across all devices in the org
- **device-level** (row buttons, action endpoints) — the exact check for that one device

So a viewer with a `device:control` grant on one device gets the Control button on that row and
nowhere else.

How you implement this is up to you. One path through one function is easiest to keep honest.

---

## 4. The rules that need a decision

These are the parts that are easy to get subtly wrong. Each has the reasoning with it, so you can
tell whether your implementation actually implements the rule or just passes the obvious case.
The short labels in parentheses are what the schema comments and the code refer to.

**An explicit deny always wins** (D1). Regardless of scope or specificity: an org-wide
`deny device:terminal` cannot be carved out for one device by a device-scoped allow. If you want
a carve-out, don't create the deny. The practical consequence is that you check the deny set
before anything else.

**Roles are bundles, not levels** (D2). "Admin can do X" means "the admin baseline contains X".
The only place roles are compared is modification authority (§6), which is a separate rule with
its own error.

**Grants are a delta in both directions** (D3). A viewer plus `allow device:control` is a
supported and sensible state. Grants are bounded only by the deny rules and the no-laundering
rule below.

**Absent means denied** (D4). Default deny, always. Provenance distinguishes the two kinds of
deny: `source: null, reason: "implicit"` means nobody granted it; `reason: "explicit_deny"` means
someone took it away. The console needs both to explain itself.

**No permission implies another** (D5). `device:control` does not imply `device:view`;
`grant:create` does not imply `grant:revoke`. Convenience lives in the role bundles. Keeping the
set flat and checkable avoids transitive reasoning entirely.

**Device permissions are always device-scoped** (D6). `device:control` means nothing without a
device. The question always names one. When you're gating navigation rather than a row, use the
org-level union.

**Time windows are half-open** (D7). `starts_at`/`expires_at` are ISO-8601 UTC. A grant is
active when `starts_at <= now < expires_at`, so `expires_at == now` is already expired. A grant
created with an expiry in the past is a `400`. Expiry takes effect on the next request with no
restart, which means you should not cache a resolved set in a way time can't invalidate.

**There is a wiring constraint on grants.** They may name a wildcard (`*`, `device:*`,
`session:*`) or an exact permission. Anything else — a typo, wrong case — is a `400`, never a
silent deny (D19). You don't reimplement this; the foreign key does it. The trap is that
`PRAGMA foreign_keys` is off by default and per-connection.

**`device:list` gates the list endpoint; `device:view` decides whether a device is in the
response.** Denying `device:view` on one device removes that row from the list entirely — never
shown with redacted metadata. `device:*` collapses to the seven device permissions; `*` to all
nineteen.

**No self-grants and no laundering** (D9). You cannot create a grant for yourself, and you cannot
grant a permission you don't hold at that scope. So an admin carrying an org-wide deny on
`device:terminal` cannot hand `device:terminal` to anyone. Both cases are `403`.

---

## 5. Errors, and the difference between 404 and 403

Every request passes three gates — membership, ownership, permission — and the question "can you
see this?" is deliberately separate from "may you do this?".

- Not a member, or no valid credentials → `401 UNAUTHENTICATED`.
- The resource isn't in the org in the path, or doesn't exist, or is soft-deleted → `404`.
- You can see it but lack the permission → `403 FORBIDDEN`.

The visibility rule in one sentence: **a resource the caller cannot see is a `404`, never a
`403`**, because a `403` confirms the resource exists and that is an information leak. The body
must be identical in shape for "doesn't exist" and "belongs to another org".

The codes in use:

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | missing, invalid or expired credentials |
| `TOKEN_STALE` | 401 | the token's `pv` no longer matches the membership |
| `FORBIDDEN` | 403 | visible resource, insufficient permission |
| `NOT_FOUND` | 404 | invisible: wrong org, absent, soft-deleted |
| `VALIDATION` | 400 | malformed body, bad timestamp, name too long |
| `CONFLICT` | 409 | duplicate name |
| `GONE` | 410 | invite token expired or revoked |
| `LAST_OWNER` | 409 | the change would leave the org ownerless |
| `SELF_ROLE_CHANGE` | 403 | changing your own role |
| `DEVICE_BUSY` | 409 | an exclusive session already holds the device |
| `GRANT_EXPIRED` | 400 | creating a grant that is already expired |

The body shape is always:

```json
{ "error": { "code": "FORBIDDEN",
             "message": "human readable",
             "reason": "missing_permission",
             "requestId": "req_..." } }
```

`reason` is the machine-readable cause — `missing_permission`, `explicit_deny`, `suspended`,
`expired_grant`, `scope_mismatch`. Keep `message` human-facing and free of secrets.

---

## 6. Who may modify whom

Modification authority is the one place roles are ordered, and the order is
`owner > admin > operator > auditor > viewer`. It is a rule about administration, not a
permission ranking, and it should stay separate from the resolution engine.

| Attempt | Result |
|---|---|
| modify a user of strictly lower role | allowed |
| modify a user of equal role (admin → admin) | `403` |
| change your own role | `403 SELF_ROLE_CHANGE` |
| assign `owner` unless you are an owner | `403` |
| remove or demote the last owner | `409 LAST_OWNER` |

---

## 7. Sessions

A session's authority is snapshotted when it starts and does not change afterwards. Revoking a
grant, changing a role, or letting a grant expire does not end a session already in flight — it
only stops the next one. This is deliberate: pulling an operator out of a live repair is the
disruptive lever, blocking the next session is the safe one.

The TTL is what makes that safe. Every session carries `expires_at = started_at +
org.max_session_minutes` (default 60), so a revoked grant's authority dies with the session,
within the hour at the latest.

What ends a session:

| Trigger | `end_reason` |
|---|---|
| the user stops it | `user_stopped` |
| someone with `session:terminate` ends it | `admin_terminated` |
| the TTL is reached | `session_expired` |
| the user is suspended | `user_suspended` |
| the membership is removed | `membership_removed` |
| the device is transferred or decommissioned | `device_transferred` |

The line between the two kinds of trigger: **account and tenancy events cascade; permission
tweaks do not.** A removed member keeping remote control of a device is a tenancy breach. A
downgraded operator mid-session is an operator on borrowed, TTL-bounded time. There is
deliberately no `permission_revoked` reason — permission changes never end sessions.

What a permission change does do, immediately:

| After a revoke returns `200` | Expected |
|---|---|
| the session already running | still `active` |
| the next `POST /sessions` on that device | `403` |
| the device's action button on the next fetch | present or absent per the new set |
| `GET /users/{uid}/effective` | reflects the new set |

No propagation window and no polling — the very next request reflects the change. One odd-looking
state falls out of this: a device row can show an active session while its action button is
absent. Those are different questions. Don't reconcile them in the console.

**Exclusivity** (D10). `control` and `terminal` are exclusive per device: a second request gets
`409 DEVICE_BUSY` with the holder's session id. `view` is not exclusive — many people may watch at
once. Two simultaneous exclusive requests must produce exactly one `201` and one `409`. The
partial unique index `one_exclusive_session_per_device` is there so the database enforces this
rather than a check-then-insert that races.

---

## 8. What the API reports, and why the console doesn't compute it

```
GET /v1/orgs/{org}/users/{id}/effective
    -> { role, permissions: { "device:control": {effect, source, reason}, ... } }

GET /v1/orgs/{org}/devices
    -> [ { id, name, kind, online, permissions: {...} } ]   # the caller's set, per row
```

The device list carries the caller's resolved permission set for every device. That saves the
console a follow-up request per row, and — more to the point — removes any reason for the
frontend to reimplement the rules.

> The console derives every `data-state` from the resolved permissions the server sends. There is
> no role-to-permission table in the frontend. One engine, one source of truth. If the baseline
> matrix gets copied into React, the two copies will drift.

---

## 9. Things that should always be true

Worth checking your build against, in no particular order. These are the invariants the rest of
this document implies.

1. A deny beats an allow, whatever the scope or specificity.
2. A permission nobody granted is denied, with `reason: "implicit"`.
3. No permission implies another.
4. Device authorization is always device-scoped.
5. An org always has at least one owner.
6. Cross-org and non-existent resources are indistinguishable — both `404`.
7. Expired grants are inert without a restart; a future `starts_at` makes a grant inert until
   then.
8. Existing sessions are grandfathered, and every session has an expiry, so grandfathering is
   never indefinite.
9. Audit is append-only, and it records denied attempts as well as successful ones.
10. The role-to-permission matrix exists in exactly one place: the server.
11. Nobody can grant a permission they don't hold at that scope.
12. `view` sessions are not exclusive; `control` and `terminal` are.
13. Suspending a user ends their live sessions in that org.

---

## 10. The rules, by their short labels

The same rules as §4 and §7, with the short labels this document uses throughout.

| | Decision |
|---|---|
| D1 | deny precedence, regardless of scope or specificity |
| D2 | roles are bundles, never compared for permission purposes |
| D3 | grants are a delta in both directions |
| D4 | absent means denied, reported as `implicit` |
| D5 | no implication graph between permissions |
| D6 | authorization is always device-scoped |
| D7 | half-open time windows; `expires_at == now` is expired |
| D8 | modification authority is ordered; no self-role-change; last owner protected |
| D9 | no self-grants; no privilege laundering |
| D10 | `control`/`terminal` exclusive, `view` not |
