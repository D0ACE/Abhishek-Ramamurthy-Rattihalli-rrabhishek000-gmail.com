# Auth, identity and the data model

This document covers identity: who a caller is, how they prove it, and what the data looks like.
It describes the tables, the token rules, the invite flow, and the failure modes the token
verifier has to reject. It states behaviour, not implementation.

Everything here is backed by the database schema, which is the ground truth. Where this document
and the schema disagree, the schema wins.

---

## 1. Where permission lives

The access token carries **identity**, not authority. The server decides what you may do, on
every request.

The token's claims:

```json
{
  "iss": "remoteops",
  "aud": "remoteops-api",
  "sub": "usr_123",
  "org": "org_abc",
  "role": "operator",
  "pv": 7,
  "jti": "tok_01H...",
  "iat": 1730000000,
  "exp": 1730000900
}
```

`pv` is the membership's **permission version** — `memberships.perm_version` in the schema. It
goes up whenever something authorization-relevant changes: a role change, a grant created or
revoked, a suspension, a removal. The server resolves permissions fresh and compares versions. A
token whose `pv` no longer matches gets `401 TOKEN_STALE`, and the client refreshes.

The consequences, briefly: a role or grant change is visible on the very next request; the
server is the only source of truth for permissions; a downgraded user cannot start a new session
on old authority. The cost is one indexed membership lookup per request, which is cheap — the
index `memberships_by_user` is already there.

---

## 2. The two tokens

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, HS256 | opaque random 256-bit, **not** a JWT |
| Claims | `iss, aud, sub, org, role, pv, jti, iat, exp` | only a hash, stored in the database |
| TTL | 15 minutes | 30 days, rotating |
| Client storage | **memory only** | `httpOnly` + `SameSite=Strict` + `Secure` cookie |
| Sent as | `Authorization: Bearer …` | the cookie, on `POST /auth/refresh` only |
| Revocable | yes, through `pv` staleness | yes, by row |

A few rules that are not style preferences:

- **Pin the algorithm.** Accept HS256 and nothing else. `alg: none` and algorithm substitution
  are rejected structurally, by not trusting the header, not by a denylist.
- **Validate `iss` and `aud`**, don't just parse them.
- The payload is base64, not encrypted. Never put a secret in it.
- Never write tokens to `localStorage` or `sessionStorage`.

Refresh tokens are long-lived and must be revocable, which is exactly what JWTs are bad at, so
they stay opaque and DB-backed. `refresh_tokens.family_id` records the rotation lineage, because
replaying an already-rotated token should revoke the whole family.

The shape of the flow:

```
POST /auth/login     email + password  ->  access token (memory) + refresh cookie
API requests         Authorization: Bearer <access token>
POST /auth/refresh   cookie rotates    ->  a new access token
POST /auth/token     { orgId }         ->  a new access token, scoped to that org
```

A token is scoped to exactly one org via the `org` claim, and switching orgs mints a new token.
That is a structural isolation guarantee rather than a filter: the token cannot address another
org, so cross-org leakage would take defeating signature verification, not merely forgetting a
`WHERE org_id = ?`.

---

## 3. Keeping permissions fresh

Three things to hold on to:

- Compare with `!=`, not `<`. A token from the future is as suspect as a stale one.
- A permission change invalidates tokens. It does not reach into sessions that are already
  running — those are grandfathered, and each keeps its own expiry.
- If you cache a membership, key it by `(userId, orgId)` and give it a short TTL. Never by
  `userId` alone, for the reason in §4.

---

## 4. One person, several organizations

A user belongs to N organizations through N `memberships` rows. Identity is global; authority is
per membership.

1. **The role lives on the membership, not the user.** `users` has no role column and must not
   gain one. The same person is `owner` in one org and `viewer` in another, and every question is
   about a `(user, org)` pair.
2. **Any cache of memberships or resolved permissions is keyed by `(userId, orgId)`.** A
   user-keyed cache hands org A's authority to org B for the same person — intermittently, only
   for multi-org users, and only inside the TTL window.
3. **Grants are org-scoped by construction.** `grants.org_id` is `NOT NULL`, and resolution
   filters on it first. A grant in one org cannot affect another, even if it names a device id
   that happens to exist in both.
4. **The token is the view.** Switching orgs re-scopes by minting a new token; it is not a
   client-side filter over one dataset. Two tabs on two orgs must work independently, which
   means no shared mutable "current org" in a module global and no token in `localStorage`.
   `GET /users/{uid}/effective` for the same user id returns **different** sets for different
   `org` path values.

---

## 5. The tables

| Table | What it is |
|---|---|
| `users` | identity. No role, no deletion column |
| `organizations` | includes `theme` (feeds `data-org-theme`) and `max_session_minutes` |
| `memberships` | one row per (user, org) — carries the role, the status, and `perm_version` |
| `invites` | hashed token, expiry, accept and revoke timestamps |
| `devices` | org-scoped, soft-deletable |
| `grants`, `grant_permissions` | effect, window, device scope, permissions normalized against the catalogue |
| `sessions` | the authorization snapshot and `expires_at` |
| `audit_events` | append-only, enforced by trigger |
| `refresh_tokens` | hash only, with `family_id` for rotation lineage |

Two things about the shape that are worth internalising:

**`memberships` is the unit of identity inside an org.** A user is never removed from the system
— their membership is. Deleting the `users` row would break every other org they belong to and
cascade-destroy audit history, which is exactly what the schema is shaped to prevent.

**`grant_permissions` is normalized against the catalogue**, so an unknown permission is a
database error and "which grants reference `device:terminal`?" is a query rather than a scan. It
points at `permission_patterns` rather than `permissions`, so `device:*` is accepted while
`device:teleport` is not.

---

## 6. Invites

Invites are the only way to add a person. One path means one set of edge cases.

An invite starts as `pending`. `POST /invites` validates the role, stores `sha256(token)`,
returns the raw token exactly once, and expires in 7 days. `POST /invites/{token}/accept` is
public and does everything in one transaction: upsert the user, flip the membership from
`invited` to `active`, and issue tokens. Cancelling sets `revoked_at`; seven days sets the
expiry. Both leave a dead token.

The rules worth stating:

- `GET /invites/{token}` is public and returns only `{ orgName, role, email, expiresAt }` — just
  enough to render *"You've been invited to Acme Robotics as operator."* No org data, no member
  list, no device counts. The token holder is not a member yet.
- The raw token is a bearer credential: hashed at rest, returned once, never logged, never in a
  URL that ends up in a `Referer`, single-use.
- Expired or revoked token → `410 GONE`. Reuse of an accepted token → `409`.
- Two concurrent accepts of the same token: exactly one wins. The partial unique index
  `one_live_invite_per_email` makes that a database guarantee.
- Inviting an email that already has an active membership, or already has a live invite → `409`.
- An existing platform user with no membership here gets attached on accept, never duplicated.
  Emails are case- and whitespace-insensitive.
- Only an owner may confer `owner`, and the invited role must be one the inviter could assign
  themselves, otherwise `403`.
- Accepting makes the membership active. It does not create a session.

---

## 7. Adding and removing people

| Operation | Permission | Also needs |
|---|---|---|
| Invite | `user:invite` | the role must be assignable by the caller |
| Accept | the invite token is the credential | — |
| Change role | `user:role:update` | the rank rules; not yourself; not the last owner |
| Suspend / reinstate | `user:remove` | the rank rules |
| Remove | `user:remove` | the rank rules; not the last owner |
| Leave | yourself | not the last owner |

**There is no `DELETE /users/{id}` endpoint.** Users are never deleted, at any privilege level,
for any reason. The row and every audit event referencing it persist. Removal is a membership
removal: set `status = 'removed'`, bump `perm_version`, end that user's sessions in this org, and
leave their other orgs and the audit trail alone.

Suspension is the reversible version. The token still verifies, but the membership isn't active,
so the effective set is empty and requests are refused. Their sessions end too.

---

## 8. Creating and revoking grants

`POST /v1/orgs/{org}/grants`, `DELETE /grants/{id}`, and a list scoped by user. Validation on
create:

| Check | Failure |
|---|---|
| every string in `permissions` exists in the catalogue, wildcards included | `400 VALIDATION` |
| `permissions` is non-empty | `400 VALIDATION` |
| `effect` is `allow` or `deny` | `400 VALIDATION` |
| `deviceId` belongs to this org | `404` — cross-org is invisible, not forbidden |
| `userId` is an active member of this org | `404` |
| `expiresAt` is in the future (half-open) | `400 GRANT_EXPIRED` |
| the caller holds every permission being granted, at that scope | `403` — no laundering |
| the caller is granting to themselves | `403` |

Create and revoke both bump the target membership's `perm_version` and write an audit row.
Revoking an already-revoked grant is a `404`, because it is no longer visible.

---

## 9. The compound check on session start

Starting a session needs two independent permissions, both on the same device:

| `mode` | Requires |
|---|---|
| `view` | `session:start` **and** `device:view` |
| `control` | `session:start` **and** `device:control` |
| `terminal` | `session:start` **and** `device:terminal` |

A refusal has to say which of the two was missing. The two causes are different problems for the
caller: one means "you can't open sessions at all", the other means "not on this device".

Session scoping: `GET /sessions/{id}` is readable by a participant or with `session:view`;
`DELETE /sessions/{id}` by the session's owner or with `session:terminate`.

---

## 10. What `verifyAccessToken` has to reject

This is the stub the token verifier has to implement. It must refuse:

- `alg: none`, and any header claiming an algorithm other than HS256
- a payload tampered with under a valid-looking header (the signature check)
- an expired `exp` even with a valid signature — and `exp == now` counts as expired
- the wrong `iss` or `aud`
- a missing or empty `jti`
- a token whose `pv` is stale, as `401 TOKEN_STALE`
- a refresh token presented as a bearer access token, and an access token presented at
  `/auth/refresh`
- a replayed refresh token, which should revoke the whole `family_id`

And it has to behave, not just validate:

- a token for a suspended membership → `403` with an empty permission set; for a `removed`
  membership → `401`
- a token for org A used against org B routes → `404`, not `500`, and no org B data in the body
- one user holding two valid tokens for two orgs: each request's result depends only on the token
  presented, never on a shared "current org" held server-side
- nothing token-shaped in `localStorage` or `sessionStorage`, and no secret in the payload

---

## 11. Decisions in this document

The labels for the decisions in this document.

| | Decision |
|---|---|
| D11 | the JWT carries identity (`sub, org, role, pv`); the server resolves the set |
| D12 | refresh tokens are opaque and hashed, not JWTs |
| D13 | access token in memory, refresh in an `httpOnly` cookie, nothing in web storage |
| D14 | invites are the only way to add a person |
| D15 | users are never deleted — membership removal only |
| D16 | suspension is reversible, needs `user:remove`, and yields an empty permission set |
| D17 | invites last 7 days, are single-use, and are hashed at rest |
| D18 | one org per token; switching mints a new one |
| D19 | an unknown permission string is rejected by the foreign key → `400` |
| D20 | sessions are grandfathered on permission and role changes; suspension, removal and transfer cascade; every session is TTL-bounded |
