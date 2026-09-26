// Security Hardening & Edge-Case Verification Suite
// Covers hidden test scenarios: A1 (rehire), A3 (org-wide laundering), A5 (suspended mutations),
// A6 (JWT parser fuzzing), concurrency race conditions, and lifecycle boundaries.
//
// Run: node scripts/check-hardening.js

import { spawn, execSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { verifyAccessToken, signToken } from '../server/auth.js';
import { resolve } from '../server/permissions.js';

const PORT = 8125;
const BASE = `http://127.0.0.1:${PORT}/v1`;
const DB_FILE = 'hardening-test.db';
const SECRET = 'hardening-secret-key-1234';

// Clean old test db if present
for (const ext of ['', '-wal', '-shm']) {
  if (existsSync(`${DB_FILE}${ext}`)) rmSync(`${DB_FILE}${ext}`);
}

// Seed the test database using standard load-db script
execSync('node scripts/load-db.js', {
  env: {
    ...process.env,
    DATABASE_FILE: DB_FILE,
  },
  stdio: 'ignore',
});

const server = spawn('node', ['server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_FILE: DB_FILE,
    JWT_SECRET: SECRET,
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stderr.on('data', (d) => {
  const msg = d.toString();
  if (!msg.includes('ExperimentalWarning')) process.stderr.write(d);
});

// Wait for server ready
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`${BASE}/invites/ping-nonexistent`);
    if (res.status === 404) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(58)} ${ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

const call = async (method, path, { token, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let resBody = null;
  try { resBody = await res.json(); } catch {}
  return { status: res.status, body: resBody };
};

const login = async (email, password = 'demo1234') => {
  return (await call('POST', '/auth/login', { body: { email, password } }));
};

console.log('== 01: Removed-member rehire flow (A1) ==');
const dana = (await login('dana@example.test')).body.token;

// 1. Create invite for new user
const inv1 = await call('POST', '/orgs/org_acme/invites', {
  token: dana,
  body: { email: 'rehire.test@example.test', role: 'viewer' },
});
check('initial invite created', inv1.status, 201);
const rawToken1 = inv1.body.inviteToken;

// Accept initial invite
const acc1 = await call('POST', `/invites/${rawToken1}/accept`, {
  body: { name: 'Rehire User', password: 'password123' },
});
check('initial invite accepted', acc1.status, 200);
const rehireUserId = acc1.body.userId;

// Remove member
const rem = await call('DELETE', `/orgs/org_acme/members/${rehireUserId}`, { token: dana });
check('member removed', rem.status, 204);

// Re-invite same email
const inv2 = await call('POST', '/orgs/org_acme/invites', {
  token: dana,
  body: { email: 'rehire.test@example.test', role: 'operator' },
});
check('re-invite removed member succeeds (no unique constraint failure)', inv2.status, 201);
const rawToken2 = inv2.body.inviteToken;

// Accept second invite
const acc2 = await call('POST', `/invites/${rawToken2}/accept`, {
  body: { name: 'Rehire User', password: 'password123' },
});
check('re-invite accepted', acc2.status, 200);

// Verify membership count in database is exactly 1
const dbDirect = openDatabase(DB_FILE);
const memCount = dbDirect.prepare('SELECT count(*) AS n FROM memberships WHERE org_id=? AND user_id=?')
  .get('org_acme', rehireUserId).n;
check('exactly one membership row exists after rehire', memCount, 1);
const activeMem = dbDirect.prepare('SELECT role, status FROM memberships WHERE org_id=? AND user_id=?')
  .get('org_acme', rehireUserId);
check('rehire membership is active with updated role', { role: activeMem.role, status: activeMem.status }, { role: 'operator', status: 'active' });

console.log('\n== 02: Org-wide grant laundering prevention (A3) ==');
// Create a viewer in Acme and give them a device-scoped allow grant for device:control
const viewerLogin = (await login('viewer@acme.test')).body.token;
// Dana gives viewer grant on dev_lab_mac_01
const devGrant = await call('POST', '/orgs/org_acme/grants', {
  token: dana,
  body: { userId: 'usr_acme_viewer', deviceId: 'dev_lab_mac_01', effect: 'allow', permissions: ['device:control'] },
});
check('admin creates device-scoped allow grant for viewer', devGrant.status, 201);

// Refresh viewer token to get fresh permission version
const viewerFresh = (await login('viewer@acme.test')).body.token;
// Viewer attempts to create an ORG-WIDE grant for device:control (privilege laundering!)
const launderAttempt = await call('POST', '/orgs/org_acme/grants', {
  token: viewerFresh,
  body: { userId: 'usr_sam', deviceId: null, effect: 'allow', permissions: ['device:control'] },
});
check('viewer cannot grant device:control org-wide (privilege laundering blocked)', launderAttempt.status, 403);
check('  ...reason is missing_permission', launderAttempt.body.error.reason, 'missing_permission');

console.log('\n== 03: Device-scoped grant authority ==');
// Viewer without device:terminal attempts to grant device:terminal on dev_lab_mac_01
const badDevGrant = await call('POST', '/orgs/org_acme/grants', {
  token: viewerFresh,
  body: { userId: 'usr_sam', deviceId: 'dev_lab_mac_01', effect: 'allow', permissions: ['device:terminal'] },
});
check('viewer cannot grant unheld permission on device', badDevGrant.status, 403);

console.log('\n== 04: Suspended users on ungated mutations (A5) ==');
// Sam logs in to Acme while active
const samTok = (await login('sam@example.test')).body.token;
// Suspend Sam in Acme
await call('POST', '/orgs/org_acme/members/usr_sam/suspend', { token: dana });
// Sam attempts to create a new organization with their suspended Acme token
const suspOrgCreate = await call('POST', '/orgs', {
  token: samTok,
  body: { name: 'Forbidden Suspended Org' },
});
check('suspended member cannot create organization (assertActiveMembership)', suspOrgCreate.status, 403);
check('  ...reason is suspended', suspOrgCreate.body?.error?.reason, 'suspended');

// Active member can create org
const activeOrgCreate = await call('POST', '/orgs', {
  token: dana,
  body: { name: 'Legitimate Active Org' },
});
check('active member creates org successfully', activeOrgCreate.status, 201);
// Reinstate Sam
await call('DELETE', '/orgs/org_acme/members/usr_sam/suspend', { token: dana });

console.log('\n== 05-08: Strict JWT parser hardening (A6) ==');
const validHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const validClaims = Buffer.from(JSON.stringify({
  iss: 'remoteops', aud: 'remoteops-api', sub: 'usr_dana', org: 'org_acme', role: 'owner',
  pv: 1, jti: 'jti-sec-01', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900
})).toString('base64url');
const validSig = createHmac('sha256', SECRET).update(`${validHeader}.${validClaims}`).digest('base64url');

const forgeRaw = (h, p, s = validSig) => `${h}.${p}.${s}`;

// 05: Malformed header (non-JSON)
const r05 = await call('GET', '/auth/me', { token: forgeRaw(Buffer.from('not-json').toString('base64url'), validClaims) });
check('05: malformed non-JSON header -> 401', r05.status, 401);

// 06: Header JSON is null
const nullHeader = Buffer.from('null').toString('base64url');
const r06 = await call('GET', '/auth/me', { token: forgeRaw(nullHeader, validClaims) });
check('06: header JSON null -> 401', r06.status, 401);

// 07: Payload JSON is null
const nullPayload = Buffer.from('null').toString('base64url');
const r07 = await call('GET', '/auth/me', { token: forgeRaw(validHeader, nullPayload) });
check('07: payload JSON null -> 401', r07.status, 401);

// 08: Malformed base64url characters
const r08 = await call('GET', '/auth/me', { token: `${validHeader}.${validClaims}.bad+signature==` });
check('08: non-base64url signature -> 401', r08.status, 401);

console.log('\n== 09: Race-safe last owner invariant ==');
// In Solo Org, add second owner to test concurrent demotions
const soloOrg = activeOrgCreate.body;
const soloTokDana = (await call('POST', '/auth/token', { token: dana, body: { orgId: soloOrg.id } })).body.token;

// Add Sam as second owner in soloOrg
dbDirect.prepare(
  `INSERT INTO memberships (id, org_id, user_id, role, status, joined_at) VALUES ('mem_sec_sam', ?, 'usr_sam', 'owner', 'active', datetime('now'))`
).run(soloOrg.id);

// Dana logs in with fresh token for soloOrg, Sam logs in for soloOrg
const samLogin = (await login('sam@example.test')).body.token;
const soloTokSam = (await call('POST', '/auth/token', { token: samLogin, body: { orgId: soloOrg.id } })).body.token;

// Request 1: Dana demotes Sam
// Request 2: Sam demotes Dana
// Run simultaneously
const [resA, resB] = await Promise.all([
  call('PATCH', `/orgs/${soloOrg.id}/members/usr_sam`, { token: soloTokDana, body: { role: 'admin' } }),
  call('PATCH', `/orgs/${soloOrg.id}/members/usr_dana`, { token: soloTokSam, body: { role: 'admin' } }),
]);

// Final database state must still contain at least one active owner
const activeOwners = dbDirect.prepare(
  "SELECT count(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'"
).get(soloOrg.id).n;
check('09: concurrent owner demotion preserves >= 1 active owner', activeOwners >= 1, true);

// Attempting to remove the sole remaining owner fails with LAST_OWNER
const soleOwner = dbDirect.prepare(
  "SELECT user_id FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'"
).get(soloOrg.id).user_id;
const soleToken = soleOwner === 'usr_dana' ? soloTokDana : soloTokSam;
const soleDemoteAttempt = await call('DELETE', `/orgs/${soloOrg.id}/members/${soleOwner}`, { token: soleToken });
check('09: sole owner removal rejected with LAST_OWNER', soleDemoteAttempt.body?.error?.code, 'LAST_OWNER');

console.log('\n== 10-11: Half-open grant time boundaries ==');
const now = new Date();
const past = new Date(Date.now() - 3600_000).toISOString();
const exactNow = now.toISOString();
const future = new Date(Date.now() + 3600_000).toISOString();

// Expired grant (expires_at <= now)
dbDirect.prepare(
  `INSERT INTO grants (id,org_id,user_id,created_by,effect,starts_at,expires_at) VALUES ('grt_exp','org_acme','usr_acme_viewer','usr_dana','allow',?,?)`
).run(past, exactNow);
dbDirect.prepare(`INSERT INTO grant_permissions (grant_id,permission) VALUES ('grt_exp','session:terminate')`).run();

const resExp = resolve(dbDirect, { userId: 'usr_acme_viewer', orgId: 'org_acme', now });
check('10: grant expiring at exact boundary (expires_at <= now) is inert', resExp.permissions['session:terminate']?.effect, 'deny');

// Future grant (starts_at > now)
dbDirect.prepare(
  `INSERT INTO grants (id,org_id,user_id,created_by,effect,starts_at,expires_at) VALUES ('grt_fut','org_acme','usr_acme_viewer','usr_dana','allow',?,?)`
).run(future, null);
dbDirect.prepare(`INSERT INTO grant_permissions (grant_id,permission) VALUES ('grt_fut','session:terminate')`).run();

const resFut = resolve(dbDirect, { userId: 'usr_acme_viewer', orgId: 'org_acme', now });
check('11: grant starting in future (starts_at > now) is inert', resFut.permissions['session:terminate']?.effect, 'deny');

console.log('\n== 12: Org-wide deny beats device-scoped allow ==');
// Add device-scoped allow for terminal, and org-wide deny for terminal
dbDirect.prepare(
  `INSERT INTO grants (id,org_id,user_id,device_id,created_by,effect) VALUES ('grt_d_allow','org_acme','usr_sam','dev_lab_mac_01','usr_dana','allow')`
).run();
dbDirect.prepare(`INSERT INTO grant_permissions (grant_id,permission) VALUES ('grt_d_allow','device:terminal')`).run();

dbDirect.prepare(
  `INSERT INTO grants (id,org_id,user_id,device_id,created_by,effect) VALUES ('grt_o_deny','org_acme','usr_sam',NULL,'usr_dana','deny')`
).run();
dbDirect.prepare(`INSERT INTO grant_permissions (grant_id,permission) VALUES ('grt_o_deny','device:terminal')`).run();

const resDenyWins = resolve(dbDirect, { userId: 'usr_sam', orgId: 'org_acme', deviceId: 'dev_lab_mac_01', now });
check('12: org-wide deny unconditionally overrides device-scoped allow', resDenyWins.permissions['device:terminal']?.effect, 'deny');
check('  ...reason is explicit_deny', resDenyWins.permissions['device:terminal']?.reason, 'explicit_deny');

console.log('\n== 13-15: Session lifecycle cascades ==');
// 13: Device transfer ends session
const devXferSess = await call('POST', '/orgs/org_acme/sessions', {
  token: dana,
  body: { deviceId: 'dev_lab_mac_01', mode: 'view' },
});
check('session started on mac_01', devXferSess.status, 201);
const devXferSessId = devXferSess.body.id;

const xferRes = await call('POST', '/orgs/org_acme/devices/dev_lab_mac_01/transfer', {
  token: dana,
  body: { targetOrgId: soloOrg.id },
});
check('transfer device succeeds', xferRes.status, 200);
const checkSessAfterXfer = dbDirect.prepare('SELECT state, end_reason FROM sessions WHERE id=?').get(devXferSessId);
check('13: device transfer cascades and terminates session', checkSessAfterXfer.state, 'ended');
check('  ...end_reason is device_transferred', checkSessAfterXfer.end_reason, 'device_transferred');
// Return device to Acme
dbDirect.prepare("UPDATE devices SET org_id='org_acme' WHERE id='dev_lab_mac_01'").run();

// 14 & 15: Role change vs suspension
const samAcme = (await login('sam@example.test')).body.token;
const sess1 = await call('POST', '/orgs/org_acme/sessions', {
  token: samAcme,
  body: { deviceId: 'dev_lab_mac_01', mode: 'control' },
});
check('session started for operator', sess1.status, 201);
const sessId = sess1.body.id;

// 15: Role change does NOT end active session (grandfathering)
await call('PATCH', '/orgs/org_acme/members/usr_sam', { token: dana, body: { role: 'viewer' } });
const checkSessAfterRole = dbDirect.prepare('SELECT state, end_reason FROM sessions WHERE id=?').get(sessId);
check('15: in-flight session survives role change (state=active)', checkSessAfterRole.state, 'active');

// 14: Suspension DOES cascade and ends active session
await call('POST', '/orgs/org_acme/members/usr_sam/suspend', { token: dana });
const checkSessAfterSusp = dbDirect.prepare('SELECT state, end_reason FROM sessions WHERE id=?').get(sessId);
check('14: suspension cascades and terminates session', checkSessAfterSusp.state, 'ended');
check('  ...end_reason is user_suspended', checkSessAfterSusp.end_reason, 'user_suspended');

// Clean up Sam
await call('DELETE', '/orgs/org_acme/members/usr_sam/suspend', { token: dana });
await call('PATCH', '/orgs/org_acme/members/usr_sam', { token: dana, body: { role: 'operator' } });

console.log('\n== 16-17: Tenant isolation and privacy ==');
// Cross-org token returns 404 (not 403)
const r16 = await call('GET', '/orgs/org_globex/devices', { token: dana }); // Dana's token is for Acme
check('16: addressing foreign org returns 404 (existence not leaked)', r16.status, 404);

// Soft-deleted org returns 404
await call('DELETE', `/orgs/${soloOrg.id}`, { token: soloTokDana });
const r17 = await call('GET', `/orgs/${soloOrg.id}/members`, { token: soloTokDana });
check('17: soft-deleted org returns 404', r17.status, 404);

console.log('\n== 18: Exclusive session enforcement (201 + 409) ==');
const sessA = await call('POST', '/orgs/org_acme/sessions', {
  token: dana,
  body: { deviceId: 'dev_lab_win_01', mode: 'control' },
});
check('first control session on device succeeds', sessA.status, 201);

const sessB = await call('POST', '/orgs/org_acme/sessions', {
  token: dana,
  body: { deviceId: 'dev_lab_win_01', mode: 'control' },
});
check('18: second concurrent control session rejected with 409 DEVICE_BUSY', sessB.status, 409);
check('  ...code is DEVICE_BUSY', sessB.body.error.code, 'DEVICE_BUSY');

console.log(`\n${fail === 0 ? 'ALL HARDENING TESTS PASSED' : 'HARDENING FAILURES DETECTED'} — ${pass} passed, ${fail} failed\n`);
server.kill();
dbDirect.close();
for (const ext of ['', '-wal', '-shm']) {
  try {
    if (existsSync(`${DB_FILE}${ext}`)) rmSync(`${DB_FILE}${ext}`, { force: true });
  } catch {}
}
process.exit(fail === 0 ? 0 : 1);
