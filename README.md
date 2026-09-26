# RemoteOps

A multi-organization permission console. One process, one port, one command.

Repository: [https://github.com/D0ACE/Abhishek-Ramamurthy-Rattihalli-rrabhishek000-gmail.com](https://github.com/D0ACE/Abhishek-Ramamurthy-Rattihalli-rrabhishek000-gmail.com)  
Candidate: `Abhishek-Ramamurthy-Rattihalli-rrabhishek000-gmail.com`

---

## Overview

RemoteOps is a complete, production-grade multi-organization permission console built for managing users, roles, device permissions, access sessions, lifecycle operations, and tamper-proof audit trails.

The application treats the database as the sole source of truth. All roles, permissions, baseline matrices, and grants are loaded and resolved dynamically from SQLite at runtime rather than relying on hardcoded enums or fixture values.

---

## Architecture

The system operates as a single, unified Node.js process serving both the REST API and the React single-page application (SPA):

- **Backend Runtime**: Node.js (ES Modules, Node 20+) using standard library `node:http`.
- **API Routing**: Lightweight zero-dependency router (`server/router.js`) with pattern matching and parameter extraction (`/v1/*`).
- **Database**: SQLite 3 (via `better-sqlite3`) utilizing `STRICT` tables, `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, and append-only database triggers for audit integrity.
- **Frontend**: React 19 SPA (`web/`) with Vanilla CSS design system. In development (`npm run dev`), Vite runs in middleware mode providing instantaneous Hot Module Replacement (HMR). In production (`npm run build && npm start`), pre-built static assets in `dist/` are served directly by `node:http`. There is no second server, and there is no CORS overhead.
- **Dynamic Extensibility**: Dynamic role discovery via `GET /v1/orgs/:org/roles` and runtime permission resolution handle custom and undocumented roles (e.g. `reviewer`) seamlessly.

```
.
├── server/
│   ├── auth.js            # scrypt password hashing & HMAC-SHA256 JWT verification
│   ├── context.js         # Token verification & org-scoped execution context
│   ├── permissions.js     # Single authoritative runtime permission resolution engine
│   ├── lifecycle.js       # Role rank enforcement, last-owner invariant, session termination
│   ├── audit.js           # Structured append-only audit event logging
│   ├── db.js              # SQLite connection, PRAGMAs, ID generation, and version bumps
│   ├── http.js            # Standardized HTTP error responses and request body parsing
│   ├── router.js          # REST route registration and matcher
│   ├── index.js           # Server pipeline & Vite middleware / static file server
│   └── routes/            # Route modules (auth, orgs, devices, invites, sessions)
├── web/
│   ├── App.jsx            # Main application shell, state management, and tab routing
│   ├── api.js             # In-memory token management, auto-refresh, and API client
│   ├── index.css          # Design system, themes, and component styling
│   └── components/        # Devices, People, Grants, Sessions, Audit, Admin, Login, Invite, Action
├── db/
│   ├── schema.sql         # STRICT tables, partial unique indexes, immutable audit triggers
│   └── reference.sql      # System roles, permissions, and role baseline matrices
├── scripts/
│   ├── load-db.js         # Database initializer (schema + reference + demo fixture + overlay)
│   ├── check-jwt.js       # JWT specification & edge-case test suite (43 tests)
│   ├── check-permissions.js # Permission resolution engine test suite (35 tests)
│   ├── check-api.js       # HTTP API integration test suite (66 tests)
│   ├── check-personalisation.js # Personalised overlay test suite (18 tests)
│   └── personalise.js     # Additive per-candidate nonce overlay generator
├── tests/
│   └── ui.spec.js         # Playwright end-to-end console contract test suite (25 tests)
├── BUILD-LOG.md           # Progressive engineering and discovery log
├── DECISIONS.md           # Architecture Decision Records (ADRs)
├── BRIEF.md               # Hackathon functional specification
├── PERMISSIONS.md         # Permission model and resolution rules
├── AUTH-DATA-MODEL.md     # Authentication & database data model
├── UI-INVENTORY.md        # UI component testid & presence inventory
├── WORKFLOW.md            # Permission resolution workflow specification
├── DISCOVERY-BRIEF.md     # Discovery and writeup criteria
├── package.json           # Scripts and dependencies
└── README.md              # Project documentation
```

---

## Installation & Setup

### Prerequisites

- **Node.js**: v20 or higher
- **npm**: v10 or higher
- **Git**

Verify your environment:
```sh
node --version
npm --version
git --version
```

### Installation

Clone the candidate repository:
```sh
git clone https://github.com/D0ACE/Abhishek-Ramamurthy-Rattihalli-rrabhishek000-gmail.com.git
cd Abhishek-Ramamurthy-Rattihalli-rrabhishek000-gmail.com
npm install
```

### Database Initialization

Initialize the database from clean SQL schemas and load the seed fixture along with the candidate personalisation overlay:
```sh
npm run db:reset
```
This initializes:
- `db/schema.sql`: Table definitions with `STRICT`, foreign keys, and audit immutability triggers.
- `db/reference.sql`: Reference roles, permissions, and baseline role-permission maps.
- `seed/orgs.json`: Acme Robotics and Globex Industries organizations and demo accounts.
- `.candidate-nonce` overlay: Adds an extra organisation with an undocumented role (`reviewer`) and custom permission (`device:reboot`).

---

## Running the Application

### Development Mode

Runs the unified Node server with file watching and Vite HMR middleware:
```sh
npm run dev
```
Open your browser at `http://localhost:8080`.

Demo accounts (password for all: `demo1234`):
- `dana@example.test`: Owner in Acme Robotics, Viewer in Globex Industries
- `sam@example.test`: Operator in Acme Robotics, Auditor in Globex Industries
- `admin@acme.test`: Admin in Acme Robotics
- `viewer@acme.test`: Viewer in Acme Robotics

### Production Mode

Build the React frontend bundle and start the production server:
```sh
npm run build
npm start
```
The application is served at `http://localhost:8080`.

---

## Verification & Test Commands

Every component has been verified against the test suites:

```sh
# 1. JWT verification test suite (43 tests)
node scripts/check-jwt.js

# 2. Permission resolution engine test suite (35 tests)
node scripts/check-permissions.js

# 3. HTTP API contract test suite (66 tests)
node scripts/check-api.js

# 4. Personalisation overlay test suite (18 tests)
node scripts/check-personalisation.js

# 5. Playwright E2E UI presence test suite (25 tests)
npx playwright test
```

All 187 tests pass cleanly.

---

## Security & Implementation Details

### Authentication

- **Password Storage**: Passwords are saved as cryptographically salted hashes using `node:crypto` `scrypt` with random 16-byte salts.
- **Access Tokens**: Short-lived (15 minutes) HMAC-SHA256 (HS256) JWT access tokens. Tokens are held **in memory only** by the frontend client and are never written to `localStorage` or `sessionStorage` (preventing persistent XSS token theft).
- **Refresh Tokens**: Cryptographically random 32-byte hex tokens stored as hashes in the database with 7-day expiration. Refresh tokens are transmitted exclusively via `httpOnly`, `SameSite=Lax`, `Path=/v1/auth` cookies.
- **Timing Safe Validation**: Signature comparison uses `timingSafeEqual` to eliminate timing side-channel attacks.

### Authorization & Permission Engine

- **Single Authority**: `server/permissions.js` is the sole arbiter of allow/deny decisions. The frontend never assumes authority or calculates permissions locally.
- **Resolution Pipeline**:
  1. Verify caller membership in the target organization (`active` status required).
  2. Load role baseline permissions from `role_permissions`.
  3. Load and evaluate active `grants`:
     - Both org-wide and device-scoped grants.
     - Half-open time window: `starts_at <= now < expires_at`.
     - Wildcard pattern matching (e.g. `device:*`).
  4. **Deny Wins**: Any applicable `deny` grant immediately overrides any `allow` grant or baseline permission.
  5. Provenance is recorded for every decision (`baseline`, `grant`, `explicit_deny`, `implicit`).

### Organization Isolation

- Every API endpoint under `/v1/orgs/:org/*` validates that the caller's verified JWT token is scoped to `:org`.
- **Existence Privacy**: When a user attempts to access an organization they do not belong to, the API returns `404 NOT_FOUND` rather than `403 FORBIDDEN`, ensuring the existence of foreign organizations is never leaked.
- All database queries enforce strict tenant scoping (`org_id = ?`).

### Lifecycle Management

- **Role Modification Authority**: Users may only assign or modify roles ranked strictly below their own (e.g. an admin cannot modify another admin or promote anyone to owner). Only an owner may confer ownership.
- **Last-Owner Invariant**: An organization must always maintain at least one active owner. Attempts by the last owner to leave, demote themselves, or be suspended are rejected with `409 LAST_OWNER`.
- **Session Grandfathering**: Role or permission modifications affect future sessions only. In-flight sessions remain valid until natural expiration.
- **Tenancy Cascades**: Tenancy lifecycle events (suspension, membership removal) immediately terminate active sessions.

### Audit Logging

- All security-sensitive actions (device control, user invites, role changes, grant updates, logins) are recorded in the `audit_events` table.
- **Immutable Log**: SQLite database triggers (`BEFORE UPDATE` and `BEFORE DELETE`) prevent modification or deletion of audit entries.
- **Denial Auditing**: Denied authorization attempts are captured along with denial reason codes (`missing_permission`, `explicit_deny`, `suspended`, etc.) and request IDs.

### Frontend Console Contract

- **Presence-Based UI**: In accordance with the console contract, elements are either present with `data-state="unlocked"` or completely omitted from the DOM. Elements are never rendered in a disabled state.
- **Dynamic Roles**: The user management interface (`People.jsx`) queries `GET /v1/orgs/:org/roles` dynamically, populating role selections from the database and supporting undocumented roles (such as `reviewer`) without code changes.
- **Tenant Context**: The console dynamically updates its theme and branding (`data-org-theme`) when switching between organizations.

---

## Clean Checkout Verification

To verify that the candidate repository is completely self-contained and reproducible:

```sh
# 1. Clone to a temporary directory
git clone https://github.com/D0ACE/Abhishek-Ramamurthy-Rattihalli-rrabhishek000-gmail.com.git /tmp/remoteops-test
cd /tmp/remoteops-test

# 2. Install dependencies
npm install

# 3. Reset database
npm run db:reset

# 4. Run all verification test suites
node scripts/check-jwt.js
node scripts/check-permissions.js
node scripts/check-api.js
node scripts/check-personalisation.js
npx playwright test

# 5. Start the development server
npm run dev
```

---

## Development Logs & Decisions

- `BUILD-LOG.md`: Chronological log of engineering discoveries, design evolution, and test validations.
- `DECISIONS.md`: Formal Architecture Decision Records (ADRs) documenting technical tradeoffs and rationale.
