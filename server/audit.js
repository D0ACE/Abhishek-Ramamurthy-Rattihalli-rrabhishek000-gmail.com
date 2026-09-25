// Append-only audit writes.
//
// Two invariants:
//   1. Denied attempts are recorded, not just successes.
//   2. One action = one audit row, written in the same transaction as the change.
//
// The audit_events table has BEFORE UPDATE/DELETE triggers that make it physically
// impossible to alter or delete rows — we only ever INSERT.

import { randomUUID } from 'node:crypto';

// Write a single audit row. All fields come from server-side context — actorId is
// always ctx.userId, never a client-supplied field.
export function audit(db, {
  orgId,
  actorId,
  action,
  targetType = null,
  targetId = null,
  result,          // 'allow' | 'deny'
  reasonCode = null,
  requestId = null,
}) {
  db.prepare(`
    INSERT INTO audit_events (id, org_id, actor_id, action, target_type, target_id,
                              result, reason_code, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    orgId,
    actorId ?? null,
    action,
    targetType,
    targetId,
    result,
    reasonCode,
    requestId,
  );
}

// Run fn(); if it throws a permission error (403 FORBIDDEN), record the denial and
// rethrow. Non-permission errors propagate without an audit row.
export function auditDenials(db, ctx, { action, targetType = null, targetId = null }, fn) {
  try {
    return fn();
  } catch (err) {
    if (err?.status === 403 || err?.code === 'FORBIDDEN' || err?.code === 'LAST_OWNER'
        || err?.code === 'SELF_ROLE_CHANGE') {
      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        action,
        targetType,
        targetId,
        result: 'deny',
        reasonCode: err.reason ?? null,
        requestId: ctx.requestId ?? null,
      });
    }
    throw err;
  }
}
