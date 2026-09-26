# The console — what exists, and when

This document sets out the console's element inventory: which elements exist, and which
permission governs each one. It deliberately does not say what the console looks like, or how it
is built.

What it also doesn't give you: which elements are on screen for which role. Presence follows from
the permission model. The seeded role baselines and grants are the inputs; you derive the rest.
If you can say *why* an element appears or disappears for a given person in a given org, your
engine is right.

---

## 1. Present or absent, never disabled

> If the caller holds the permission, the element is rendered, carrying `data-permission` and
> `data-state="unlocked"`. If they don't, it is not in the DOM at all.

There is no `data-state="locked"` and no greyed-out button. A permission console should not
advertise actions a person cannot take. The "items unlock" requirement in the brief is
implemented as appearance: granting a permission makes an element **appear**.

Three things that hold throughout:

1. **`data-state` comes from the server.** No role-to-permission table in the frontend. The
   server resolves, the console renders what it is told.
2. **The API refuses what the UI hides.** An element that is absent must still get a `403` from
   the endpoint behind it. Hiding is presentation; enforcement is the server's job. Every
   permission test checks both halves.
3. **Absence is not redaction.** A device the caller cannot `device:view` is not a redacted row.
   It is not listed at all.

---

## 2. Cards

Seven cards. A card is visible only when its governing permission is held. `Admin` is the
exception: it appears for `org:update` **or** `org:delete`.

| Card | Nav test id | Governing permission |
|---|---|---|
| Devices | `nav-devices` | `device:list` |
| People | `nav-people` | `user:read` |
| Grants | `nav-grants` | `user:read` |
| Sessions | `nav-sessions` | `session:view` |
| Audit | `nav-audit` | `audit:read` |
| Admin | `nav-admin` | `org:update` or `org:delete` |

Always present, never gated: the org switcher (`org-option`, one per org you belong to),
`create-org`, the active role, and sign-out.

---

## 3. Entries

| Entry | test id | Governing permission |
|---|---|---|
| **Devices card** (`device:list`) | | |
| Device row | `device-row` | `device:view` |
| Add device | `add-device` | `device:provision` |
| View | `start-view` | `device:view` |
| Control | `start-control` | `device:control` |
| Terminal | `start-terminal` | `device:terminal` |
| Transfer files | `transfer-files` | `device:file_transfer` |
| Rename | `rename-device` | `device:update` |
| Decommission | `decommission-device` | `device:provision` |
| **People card** (`user:read`) | | |
| Member row | `user-row` | `user:read` |
| Invite | `invite-user` | `user:invite` |
| Change role | `role-select` | `user:role:update` |
| Suspend / reinstate | `suspend-user` | `user:remove` |
| Remove | `remove-user` | `user:remove` |
| **Grants card** (`user:read`) | | |
| Grant row | `grant-row` | `user:read` |
| New grant | `new-grant` | `grant:create` |
| Revoke | `revoke-grant` | `grant:revoke` |
| **Sessions card** (`session:view`) | | |
| Session row | `session-row` | `session:view` |
| Start a session | `new-session` | `session:start` |
| Stop (your own) | `stop-session` | your own session |
| Stop (someone else's) | `stop-session` | `session:terminate` |
| **Audit card** (`audit:read`) | | |
| Audit row | `audit-row` | `audit:read` |
| **Admin card** (`org:update` or `org:delete`) | | |
| Rename org | `rename-org` | `org:update` |
| Delete org | `delete-org` | `org:delete` |

Three notes that don't follow from the table:

- The Grants card shares its gate with People because the API does — `GET /grants` requires
  `user:read`. There is no `grant:read` permission.
- Device-scoped entries (`start-*`, `rename-device`, `transfer-files`, `decommission-device`) are
  resolved **per row**. That's where the fixture's device-scoped grants and denies show up.
- Which specific device an entry is asserted on varies per org. Resolve per row; don't hardcode
  an id.

---

## 4. When something goes wrong

Not every element is permission-gated. A sign-in that fails has to say so on the page. Swallowing
the reason is the most common way a console like this becomes hard to use, because `403` and
`404` look identical to someone who cannot open a network tab.

| Element | test id | Governed by | Present when |
|---|---|---|---|
| Sign-in error | `login-error` | nothing — not permission-gated | the last sign-in attempt failed |

It carries the server's reason as text, and `data-error-code` with the machine-readable code so
the cause can be told apart. It stays on screen until the next attempt, so it can be read rather
than glimpsed.

Three rules go with it:

- **A failed request is never silent.** When the API refuses, the screen says what happened, in
  words a person can act on. A bare "something went wrong" does not count.
- **The message does not improve on the server's answer.** A wrong password and an account that
  does not exist read identically, because a screen that says "no such account" is an account
  enumeration oracle.
- **It is announced, not just painted.** The element carries a live-region role so a screen
  reader reaches it too.

---

## 5. What the fixture is for

The seed fixture is published, so it isn't a grading input. It's chosen so that the same console
renders differently for different people and different devices: the role baselines put some
entries on for everyone in a role, an org-wide deny removes one entry a role would otherwise
have, and a device-scoped grant puts an action on exactly one row.

If your build reproduces those differences from the fixture without special-casing seed ids,
you've understood the model.
