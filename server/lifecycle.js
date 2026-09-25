// Shared domain rules: role ranks, last-owner protection, ending sessions.
//
// TRAP 1: `roles.rank` is MODIFICATION AUTHORITY ONLY — it must NEVER answer a can()
// question. operator and auditor are unordered by permission, and using rank to resolve
// permissions is the exact bug the auditor role exists to catch.
//
// TRAP 2: a permission change does NOT end a session in flight (grandfathering).
// Suspension, membership removal and device transfer DO cascade.

import { randomUUID } from 'node:crypto';
import { forbidden, badRequest, lastOwner as lastOwnerErr } from './http.js';

// ---------------------------------------------------------------------------
// Role rank helpers — for modification authority checks only.
// ---------------------------------------------------------------------------

// Returns a Map<roleName, rank> read fresh from the DB.
export function roleRanks(db) {
  const rows = db.prepare('SELECT key, rank FROM roles').all();
  return new Map(rows.map(r => [r.key, r.rank]));
}

// Throw if the named role does not exist in the roles table.
export function assertRoleExists(db, role) {
  const row = db.prepare('SELECT key FROM roles WHERE key = ? LIMIT 1').get(role);
  if (!row) throw badRequest(`unknown role: ${role}`);
}

// Throw if the caller's role rank does not dominate the target's role rank.
// Lower rank value = higher in the hierarchy for modification authority.
// A caller cannot modify someone of equal or higher rank than themselves.
export function assertCanModify(db, callerRole, targetRole) {
  const ranks = roleRanks(db);
  const callerRank = ranks.get(callerRole) ?? Infinity;
  const targetRank = ranks.get(targetRole) ?? Infinity;
  if (callerRank >= targetRank) {
    throw forbidden(
      `your role (${callerRole}) cannot modify ${targetRole} — insufficient rank`,
      'insufficient_rank'
    );
  }
}

// Throw if removing or demoting userId from orgId would leave no owner.
export function assertNotLastOwner(db, orgId, userId) {
  // Count active owners excluding the candidate user.
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM memberships
     WHERE org_id = ? AND role = 'owner' AND status = 'active' AND user_id != ?
  `).get(orgId, userId);
  if (count === 0) throw lastOwnerErr();
}

// ---------------------------------------------------------------------------
// Session termination — the one implementation of "what ends a session".
// Called for tenancy events (suspension, removal, device transfer), NOT for
// permission or role changes (those are grandfathered).
// ---------------------------------------------------------------------------

// End all active sessions that match the criteria.
// Criteria: { orgId, userId?, deviceId?, reason, exceptSessionId? }
export function endActiveSessions(db, { orgId, userId = null, deviceId = null, reason, exceptSessionId = null }) {
  const at = new Date().toISOString();
  const where = ['s.org_id = ?', "s.state = 'active'"];
  const args = [orgId];

  if (userId) { where.push('s.user_id = ?'); args.push(userId); }
  if (deviceId) { where.push('s.device_id = ?'); args.push(deviceId); }
  if (exceptSessionId) { where.push('s.id != ?'); args.push(exceptSessionId); }

  db.prepare(`
    UPDATE sessions SET state = 'ended', end_reason = ?, ended_at = ?
     WHERE ${where.join(' AND ')}
  `).run(reason, at, ...args);
}

// Snapshot the authority at session-start time.
// Callers resolve permissions first and pass the result in.
// Stored as the `authorized_by` JSON on the sessions row — this locks in the
// authority at start time so permission changes don't retroactively affect running sessions.
export function snapshotAuthority({ role, permissions }) {
  return JSON.stringify({ role, permissions });
}

// Compute the session expiry timestamp for a new session.
// Sessions last at most org.max_session_minutes.
export function sessionExpiry(db, orgId) {
  const org = db.prepare('SELECT max_session_minutes FROM organizations WHERE id = ? LIMIT 1').get(orgId);
  const minutes = org?.max_session_minutes ?? 60;
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}
