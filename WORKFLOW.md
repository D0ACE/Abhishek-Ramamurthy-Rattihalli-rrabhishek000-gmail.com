# Getting from the skeleton to a submission

One suggested route through the build, in the order that works. This is a plan, not a rulebook.
Take it or leave it.

Three things shape the work:

1. **Everything depends on auth.** `verifyAccessToken` is a stub, so until it works every
   authenticated request fails — the API, the console, and every test suite.
2. **Everything depends on resolution.** One engine decides allow and deny, and both the routes
   and the console consume it.
3. **The console mirrors the server.** Presence comes from the resolved permissions the API
   sends. Build the API first and the UI becomes thin.

---

## 1. The areas of work

Eight, roughly in dependency order. Where the spec leaves something open, it's flagged — those
are the parts we'll ask you about.

**Token verification — `server/auth.js`.** Implement the `verifyAccessToken` stub. The failure
modes are signature, algorithm pinning, expiry, issuer and audience, and staleness against the
permission version. The
semantics are fully specified, so the only real choice is how you structure the function and map
its errors into your one error path.

**Caller context — `server/context.js`.** Token to caller: identity, active org, role, resolved
org-level permissions. One org per token, and switching orgs mints a new token. Isolation must be
structural: a caller never reaches across orgs, and cross-org resources are `404`, not `403`. How
you express that — join shape, guard middleware, query scoping — is yours; the outcome isn't.

**Resolution engine — `server/permissions.js`.** The algorithm is: identity,
applicable grants, deny wins, baseline plus allow grants, implicit deny with provenance.
Wildcards, device scope, half-open windows. This module is also where `source` and `reason` come
from, so it feeds the console directly. Data structures and any caching are your call — with the
one constraint that a cache must never serve authority that is out of date.

**Orgs, members, invites — `server/routes/orgs.js`, `invites.js`.** Org CRUD with the creator
becoming owner; the Admin card split across `org:update` and `org:delete`; members listed, role
changed, suspended, reinstated, removed, self-leave. Rank rules for modification, last-owner
protection. Invites created, listed, cancelled, and redeemed through the public token route.
Hashed at rest, single-use, expiring. Removal never deletes a user.

**Devices and grants — `server/routes/devices.js`.** Device CRUD scoped by org, with the caller's
resolved permissions on each row. Grants created, listed, revoked: per user, device-scoped or
org-wide, with an effect and a window. Transfer needs `device:provision` in both orgs.

**Sessions — `server/routes/sessions.js`.** Start is a compound check — `session:start` plus the
mode permission, on the same device — and a refusal has to say which one was missing. `control`
and `terminal` are exclusive per device; `view` is not. Termination is yours or, with
`session:terminate`, someone else's. Permission changes never end a session in flight;
suspension, membership removal and device transfer do. Every session is TTL-bounded.

**Audit — `server/audit.js`.** Append-only, and it records denied attempts as well as successful
ones. Readable with `audit:read`. Which context fields you add beyond the ones the schema carries
is your choice.

**The console — `web/`.** One SPA, same process. Create 2–3 orgs, switch between them with the
active org visibly distinct, keep orgs isolated, and let permissions change what is on screen.
Elements are present or absent, never disabled, derived from what the server sends. Which
elements exist is fixed; how they look is not.

Most of the design is yours: layout, visual language, the per-org identity and its
`data-org-theme` value, how the switcher and cards are composed, how you explain a lock to a user
(`source` and `reason` are the raw material), empty and error states, and everything the element
inventory doesn't fix. The test ids and the presence rule are fixed; the product design is not.

---

## 2. Suggested order

Phases 1–3 are serial. After that, split the work however suits you.

| Phase | Work | Done when |
|---|---|---|
| 0 | install, `db:reset`, read all four documents, run the public suites against the untouched skeleton | you know your starting line |
| 1 | token verification | `check-jwt.js` is green |
| 2 | caller context and the resolution engine | `check-permissions.js` is green and authenticated GETs work |
| 3 | orgs, members, invites, devices, grants | `check-api.js` is green |
| 4 | sessions and audit | the whole API surface is wired and the fixture story works end to end |
| 5 | the console — switcher, cards, presence, per-org identity | the UI suite is green and Sam's two-org story reads correctly |
| 6 | hardening — the awkward cases, error paths, audit of denials | you can defend any rule by pointing at your code |
| 7 | speed and polish — check the app feels immediate, then write up and rehearse the walkthrough | your decisions are stated, not implied |

Commit at every green step. We read the history.

The fixture is designed so a correct build reproduces a specific story without special-casing
seed ids: log in as `sam@example.test`, switch orgs, and the two locked items swap. Acme lets her
control devices but not read the audit log; Globex is the other way round. The seeded grants and
denies also make individual rows differ within one view, which is a good self-check for device
scoping.

---

## 3. Decisions you own

Some behaviour is contract — build against it, and write up your disagreement if you have one.
The following are genuinely yours, and the walkthrough will ask about them:

1. **The product design of the console.** Layout, theme, how presence is communicated. The
   inventory fixes which elements exist, not how they look.
2. **How a lock explains itself.** The server gives you `effect`, `source` and `reason`. What a
   user sees for `implicit` versus `explicit_deny` versus an expired window is a design decision.
3. **Performance.** Where you cache resolution results, and how you invalidate. Whatever you
   choose, be ready to say why it can't serve stale authority.
4. **Scope.** What you deliberately didn't build — batch operations, search, pagination, theming
   depth — and why.
5. **Anything in the spec you think is wrong.** Build against it as written and write up the
   argument. We grade the judgement, not the agreement.

Write these down as you go. A short `NOTES.md` at the repo root is plenty. A decision that isn't
written down didn't happen.

---

## 4. Ground rules

They matter more than the plan:

- No real remote access. Sessions are records, not screen sharing.
- No secrets in the client. Refresh and invite tokens hashed at rest, never logged.
- Don't edit `db/schema.sql` or `db/reference.sql` — argue in the write-up instead.
- The seed fixture is published. Never special-case it.
