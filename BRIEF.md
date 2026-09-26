# RemoteOps — Candidate Brief

Welcome. You're building the control plane for a remote-access platform: who can see what, and
who can do what, in which organization.

Two halves, one permission model:

- an **HTTP API** that answers permission questions, including the awkward ones
- a **React console** where the active organization and the caller's own permissions decide what
  is on screen

You are not building remote access. No screen capture, no input injection, no shell. A session
is a record that gets opened, authorised, watched and ended — nothing streams.

This brief covers the task, the interface you have to match, the ground rules, and how you're
scored. The database schema is the ground truth underneath all of it: where a rule and the schema
disagree, the schema wins. Tell us in your notes.

It describes behaviour, not mechanism. How you build it, how you structure it, and how it looks
are your decisions.

---

## 1. Time box

**Two days** from receiving the repo. At the end, push your branch and walk us through it.

This is a take-home, not a supervised sitting, so we read the commit history. Commit as you go,
in steps that mean something. A clean history is how you show the work is yours and how you
actually got there.

Two days is enough to build the whole thing and polish it. We would rather you went deep on the
permission model than spread thin across features.

---

## 2. What you're given

```
db/schema.sql        the full schema, already written. SQLite, STRICT tables.
db/reference.sql     the 5 roles, the 19 permissions, and the role baselines.
seed/orgs.json       a demo fixture: 2 orgs, 6 users, 7 devices, 4 grants.
scripts/load-db.js   loads all three. `npm run db:reset`
```

Plus a working `server/` skeleton: a readable ~35-line router, HTTP helpers, a database
connection, and JWT **signing** on `node:crypto`, all kept short on purpose.

The schema is not yours to redesign, and it is not filler. It already encodes decisions that
matter:

- the **role lives on `memberships`**, not on `users`
- users are **never deleted** — there is no `deleted_at`, and removal is a membership change
- grants are **org-scoped by construction** (`grants.org_id` is `NOT NULL`)
- `permission_patterns` exists so a grant can name `device:*` while a typo like
  `device:teleport` is still rejected by a foreign key
- `one_exclusive_session_per_device` makes two parallel `control` requests unable to both win
- `audit_events` has `BEFORE UPDATE`/`BEFORE DELETE` triggers, so the log cannot be rewritten
- `one_live_invite_per_email` makes a double invite, and a double accept, a database problem
  rather than a code problem

Trust these. Where you can let the database refuse something instead of checking first in code,
you should. There is no help for the one trap: `PRAGMA foreign_keys` is per-connection and off
by default. Without it the schema loads fine and enforces nothing.

If you think a decision in the schema is wrong, build against it anyway and write up the
argument. We grade the thinking, not the agreement.

---

## 3. What you build

Everything under `server/routes/`, all of `web/`, and four server modules the routes stand on:

- `context.js` — turn a token into a caller
- `permissions.js` — the resolution engine
- `lifecycle.js` — role ranks, last-owner protection, ending sessions
- `audit.js` — write audit rows

Plus one function, `verifyAccessToken` in `server/auth.js`, which ships as a stub. It has to
reject a bad signature, an algorithm substitution, an expired token, the wrong issuer or
audience, and a stale permission version. Do this one first — every authenticated request
depends on it, so nothing else in the app works until it does.

### 3.1 The API

Roughly thirty endpoints: auth, orgs, members, invites, devices, grants, sessions, effective
permissions, audit. The full list with the permission each one needs is in §5.

A few things the API has to get right beyond CRUD:

- the same person is `owner` here and `viewer` there, and each answer depends on the org
- permissions are device-scoped, so an action can be allowed on one device and denied on the
  next
- a resource you cannot see is a `404`, not a `403`
- starting a session needs two permissions, and a refusal has to say which one was missing

How you structure routes, what you cache, and how you model the engine is your call. What the
API returns to the console is described in §5.2, because the console reads it.

### 3.2 The console

One React SPA, served by the same process. It has to do five things:

1. Let you create 2–3 organizations from the UI.
2. Let you switch between them, with the active org **visually distinguishable at a glance**.
3. Keep organizations **isolated** — nothing from org A reachable or rendered from org B.
4. Show **different views for different permissions**, with specific items that appear as
   permissions are granted.
5. Say what went wrong, on screen, when something fails — a refused sign-in, a request the
   server rejected, a backend that isn't answering. The reason has to be readable, not
   swallowed.

Point 2 is deliberately loose. Accent colour, a badge, a tinted sidebar, a banded header — your
call. It has to be real and per-org, not one shared banner.

Point 5 matters more than it sounds. Sign-in is the first screen anyone sees, and it is also the
one most likely to be reached in a broken state — a database that hasn't been built, a server
that died, a typo in the password. A failure that produces no visible explanation is
indistinguishable from a broken app, so the page has to carry the reason.

How it looks is your call. Which elements exist at each permission level is not your call, and
it is not something you can trade away for a simpler screen.

---

## 4. Ground rules

- **No real remote access.** Sessions are records. Do not implement input injection, shell
  execution, or screen capture. Hard rule, not a scope preference.
- **No secrets in the client.** The access token lives in memory; the refresh token is an
  `httpOnly` cookie. Nothing in `localStorage` or `sessionStorage`. The JWT payload is base64,
  not encrypted — never put a secret in it.
- **Invite tokens are credentials.** Hash them at rest, return them once, never log them.
- **Don't edit `db/schema.sql` or `db/reference.sql`.** Argue in your write-up instead.
- **Don't build on the seed fixture.** It is published, so it is not graded against. Use it for
  manual checking and the demo. Anything you write should work on organizations that don't
  exist yet.

---

## 5. The interface

This is the part to match, because the console and the tests we ship both read it. Everything
this section doesn't mention is yours to design.

### 5.1 Endpoints and the permission each one needs

| Endpoint | Required |
|---|---|
| `POST /v1/auth/login` | public |
| `POST /v1/auth/refresh` | valid refresh cookie |
| `POST /v1/auth/token` | active membership in `orgId` (switch org) |
| `GET /v1/auth/me` | authenticated — your user, active org, role, your orgs, and the **org-level** resolved permission set |
| `GET /v1/orgs` | authenticated |
| `POST /v1/orgs` | authenticated (creator becomes owner) |
| `PATCH /v1/orgs/{org}` | `org:update` |
| `DELETE /v1/orgs/{org}` | `org:delete` |
| `GET /v1/orgs/{org}/members` | `user:read` |
| `POST /v1/orgs/{org}/invites` | `user:invite` |
| `GET /v1/orgs/{org}/invites` | `user:invite` |
| `DELETE /v1/orgs/{org}/invites/{id}` | `user:invite` |
| `GET /v1/invites/{token}` | **public** |
| `POST /v1/invites/{token}/accept` | **public** |
| `PATCH /v1/orgs/{org}/members/{userId}` | `user:role:update` |
| `POST /v1/orgs/{org}/members/{userId}/suspend` | `user:remove` |
| `DELETE /v1/orgs/{org}/members/{userId}/suspend` | `user:remove` (reinstate) |
| `DELETE /v1/orgs/{org}/members/{userId}` | `user:remove` |
| `DELETE /v1/orgs/{org}/members/me` | self (not the last owner) |
| `GET /v1/orgs/{org}/devices` | `device:list` |
| `GET /v1/orgs/{org}/devices/{id}` | `device:view` |
| `POST /v1/orgs/{org}/devices` | `device:provision` |
| `PATCH /v1/orgs/{org}/devices/{id}` | `device:update` |
| `DELETE /v1/orgs/{org}/devices/{id}` | `device:provision` |
| `POST /v1/orgs/{org}/devices/{id}/transfer` | `device:provision` in **both** orgs |
| `POST /v1/orgs/{org}/grants` | `grant:create` |
| `GET /v1/orgs/{org}/grants` | `user:read` |
| `DELETE /v1/orgs/{org}/grants/{id}` | `grant:revoke` |
| `POST /v1/orgs/{org}/sessions` | `session:start` **and** the mode permission |
| `GET /v1/orgs/{org}/sessions` | `session:view` |
| `GET /v1/sessions/{id}` | participant **or** `session:view` |
| `DELETE /v1/sessions/{id}` | your own session **or** `session:terminate` |
| `GET /v1/orgs/{org}/users/{userId}/effective` | `user:read`, or self |
| `GET /v1/orgs/{org}/audit` | `audit:read` |

Starting a session asks for two permissions, both on the same device:

| `mode` | Also requires |
|---|---|
| `view` | `device:view` |
| `control` | `device:control` |
| `terminal` | `device:terminal` |

When that request fails, the response has to distinguish *which* of the two was missing. The
caller needs to tell those apart, and so do you. The shipped tests expect particular `reason`
strings; using them is the easy path.

### 5.2 The response shapes the console reads

An error, always the same shape:

```json
{ "error": { "code": "FORBIDDEN", "message": "…", "reason": "missing_permission", "requestId": "…" } }
```

A resolved permission:

```json
{ "effect": "allow", "source": "role:operator", "reason": null }
{ "effect": "deny",  "source": "grant:grt_123", "reason": "explicit_deny" }
{ "effect": "deny",  "source": null,            "reason": "implicit" }
```

`reason` is what lets the console explain itself: *"nobody granted this"* (`implicit`) reads
differently from *"someone denied this"* (`explicit_deny`).

Each device row carries the caller's resolved permissions for **that device**:

```json
{ "id": "dev_lab_mac_01", "name": "lab-mac-01", "kind": "macos", "online": true,
  "permissions": { "device:control": { "effect": "deny", "source": null, "reason": "implicit" } } }
```

That is deliberate. It gives the console everything it needs in one response, so there is no
reason for the frontend to reimplement the rules and no per-row follow-up request.

`GET /users/{userId}/effective` returns `{ "role": "operator", "permissions": { … } }`.

### 5.3 Presence, not state

Design the console however you like. Which elements exist at each permission level is fixed:
every card, every entry, and the permission that governs it. The inventory is fixed, and the
attributes the tests read are listed here.

The rule is blunt:

> An element is **present** — rendered, carrying `data-permission` and
> `data-state="unlocked"` — or **absent**. Not in the DOM at all. There is no disabled state.

Two things follow:

1. **Presence comes from the server's resolved permissions.** Write no role-to-permission table
   in `web/`. If you find yourself typing `if (role === 'admin')` in a component, that is the
   bug.
2. **Absence in the UI does not remove enforcement.** Every hidden element's API call must
   still return `403`. Hiding is presentation; the server decides.

Failure feedback is not permission-gated. A refused sign-in renders `login-error` with the
reason from the server, and it stays on screen until the next attempt. A wrong password and an
account that doesn't exist have to read the same way — telling them apart is an account
enumeration oracle.

The attributes that are read:

```html
<div    data-testid="app-shell"   data-org-id="org_acme" data-org-theme="cobalt">
<button data-testid="org-option"  data-org-id="org_globex">
<button data-testid="create-org">
<tr     data-testid="device-row"  data-device-id="dev_lab_mac_01">
<tr     data-testid="user-row"    data-user-id="usr_sam">
<button data-permission="device:control" data-state="unlocked">   <!-- only when permitted -->
```

---

## 6. Speed

The console should feel immediate on a laptop with the fixture loaded. As a rule of thumb: the
first screen and its first authenticated request land well inside a second, switching orgs does
not stall, and nothing you do gets slower as devices or members are added.

Concretely, the things that usually go wrong:

- a list endpoint that issues one query per row
- re-resolving permissions several times inside one request
- the console making a follow-up request per device to find out what it may do

The device-row shape in §5.2 exists to make the last one unnecessary. If you add caching, it
must never be able to serve authority that is out of date — say in your notes why it can't.

---

## 7. Running it

```sh
npm install
npm run db:reset     # schema + reference data + demo fixture
npm run dev          # http://localhost:8080
```

One process serves the API at `/v1/*` and the SPA everywhere else. `npm run dev` has hot reload.

There is a dependency-free test suite you can run at any point:

```sh
node scripts/check-permissions.js   # the resolution engine
node scripts/check-jwt.js           # token verification
node scripts/check-api.js           # the HTTP contract
npx playwright test                 # the UI contract
```

`check-jwt.js` fails until `verifyAccessToken` exists, and `check-api.js` and the UI suite fail
with it, because every authenticated request depends on it.

**These suites are the easy path.** They cover the happy path and the obvious failures. Passing
all of them is the floor, not the ceiling — we grade on a separate set that goes after the
awkward cases. Green here means you're ready for it, not done.

The demo fixture:

| User | Acme Robotics | Globex Industries |
|---|---|---|
| `dana@example.test` | owner | viewer |
| `sam@example.test` | operator | auditor |
| `owner@acme.test` | owner | — |
| `admin@acme.test` | admin | — |
| `viewer@acme.test` | viewer | — |
| `owner@globex.test` | — | owner |

Password for all: `demo1234`.

**Log in as `sam@example.test` and switch orgs.** In Acme she can control devices and can't read
the audit log. In Globex she can read the audit log and can't control anything. Same person, and
the two items swap. If your build shows that, you've understood the model.

---

## 8. How you're scored

| Component | Weight | |
|---|---|---|
| Hidden tests — API | 30% | resolution, isolation, error codes |
| Hidden tests — UI | 20% | the data attributes, permission-driven views, server-driven state |
| Code quality | 25% | structure, error handling, naming, security hygiene |
| Live walkthrough | 25% | explain your decisions, then make a change we ask for |

We grade in **categories**, not per assertion, so partial credit is real. Correct tenancy with a
broken session lifecycle scores well above zero.

What we're looking for:

- **one source of truth for permissions** — if the rules exist twice they will drift
- **the database as the arbiter** — let unique indexes and foreign keys hold invariants, rather
  than check-then-act code that races
- **errors that tell the truth** — `404` for invisible, `403` for visible-but-forbidden, and a
  `reason` that says which
- **judgement about scope** — what you chose not to build, and why

What we're not looking for: pixel-perfect design, framework fluency, test coverage for its own
sake, breadth.

---

## 9. Walkthrough

Ten minutes at the end. Be ready to use the app as a user would, explain the decisions behind
your design — including at least one you'd argue went the other way — and defend how your
resolution behaves when something changes. We'll ask for one change, made live.

Bring your reasoning, not just your code. We're hiring for judgement; the code is only the
evidence.
