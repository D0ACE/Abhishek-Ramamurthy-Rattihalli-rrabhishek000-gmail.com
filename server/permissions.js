// The permission resolution engine. THE ONLY PLACE allow-vs-deny is decided.
//
// Design principles:
//   - Never hard-code role names, permission names, or the documented matrix.
//     Everything is read from the DB so the personalisation overlay (and grading
//     with a different nonce) just works.
//   - One code path: resolve() for a single (user, org, device?) question.
//     resolveDevices() is a batched wrapper so list endpoints avoid N+1 queries.
//   - Deny wins unconditionally regardless of scope or specificity (D1).
//   - Device permissions are always scoped to a device (D6). The org-level "union"
//     view for navigation gating uses deviceId=null, which counts a permission as
//     held if ANY device in the org would allow it.

import { forbidden } from './http.js';

export const MODE_PERMISSION = { view: 'device:view', control: 'device:control', terminal: 'device:terminal' };

// ---------------------------------------------------------------------------
// Core: resolve one user's permission set in one org for one optional device.
// Returns { role, status, permissions: { [key]: { effect, source, reason } } }
// ---------------------------------------------------------------------------
export function resolve(db, { userId, orgId, deviceId = null, now = new Date() }) {
  const nowIso = now.toISOString();

  // 1. Fetch membership — gate on status before anything else.
  const membership = db.prepare(
    `SELECT role, status FROM memberships
      WHERE org_id = ? AND user_id = ? LIMIT 1`
  ).get(orgId, userId);

  // All permissions in the catalogue (read fresh — never hardcode).
  const allPerms = db.prepare('SELECT key FROM permissions').all().map(r => r.key);

  // Not a member: total deny with not_a_member reason.
  if (!membership) {
    return {
      role: null,
      status: null,
      permissions: Object.fromEntries(
        allPerms.map(k => [k, { effect: 'deny', source: null, reason: 'not_a_member' }])
      ),
    };
  }

  const { role, status } = membership;

  // Suspended: total deny — empty authority.
  if (status === 'suspended') {
    return {
      role,
      status,
      permissions: Object.fromEntries(
        allPerms.map(k => [k, { effect: 'deny', source: null, reason: 'suspended' }])
      ),
    };
  }

  // Removed / invited members are effectively non-members for permission purposes.
  if (status !== 'active') {
    return {
      role,
      status,
      permissions: Object.fromEntries(
        allPerms.map(k => [k, { effect: 'deny', source: null, reason: 'not_a_member' }])
      ),
    };
  }

  // 2. Role baseline: which permissions does this role grant by default?
  //    Read from role_permissions — never from a hardcoded matrix.
  const baseline = new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role = ?')
      .all(role).map(r => r.permission)
  );

  // 3. Fetch applicable grants for this user in this org.
  //    A grant is applicable if: not revoked, time window includes now.
  //    Device scope: we collect all grants that apply to this question.
  //    For a device-level question (deviceId != null): org-wide grants (device_id IS NULL)
  //    plus device-specific grants for this device.
  //    For an org-level question (deviceId == null): all grants for this user in this org.
  let grantsQuery;
  let grantsArgs;
  if (deviceId !== null) {
    grantsQuery = `
      SELECT g.id, g.effect, g.device_id, GROUP_CONCAT(gp.permission) AS perms
        FROM grants g
        JOIN grant_permissions gp ON gp.grant_id = g.id
       WHERE g.user_id = ? AND g.org_id = ?
         AND g.revoked_at IS NULL
         AND (g.starts_at IS NULL OR g.starts_at <= ?)
         AND (g.expires_at IS NULL OR g.expires_at > ?)
         AND (g.device_id IS NULL OR g.device_id = ?)
       GROUP BY g.id`;
    grantsArgs = [userId, orgId, nowIso, nowIso, deviceId];
  } else {
    grantsQuery = `
      SELECT g.id, g.effect, g.device_id, GROUP_CONCAT(gp.permission) AS perms
        FROM grants g
        JOIN grant_permissions gp ON gp.grant_id = g.id
       WHERE g.user_id = ? AND g.org_id = ?
         AND g.revoked_at IS NULL
         AND (g.starts_at IS NULL OR g.starts_at <= ?)
         AND (g.expires_at IS NULL OR g.expires_at > ?)
       GROUP BY g.id`;
    grantsArgs = [userId, orgId, nowIso, nowIso];
  }
  const grantRows = db.prepare(grantsQuery).all(...grantsArgs);

  // Expand wildcard patterns to concrete permissions.
  // permission_patterns has the supersets like 'device:*' and '*'.
  const allPatterns = db.prepare('SELECT pattern FROM permission_patterns').all().map(r => r.pattern);

  function expandPatterns(rawPerms) {
    const result = new Set();
    for (const p of rawPerms) {
      if (p.endsWith(':*') || p === '*') {
        // Expand: match all concrete permissions this pattern covers.
        const prefix = p === '*' ? '' : p.slice(0, p.length - 1); // e.g. 'device:'
        for (const k of allPerms) {
          if (p === '*' || k.startsWith(prefix)) result.add(k);
        }
      } else if (allPerms.includes(p)) {
        result.add(p);
      }
    }
    return result;
  }

  // 4. Build deny set and allow set from grants.
  //    Rule D1: deny is unconditional — an org-wide deny cannot be overridden by any
  //    device-scoped allow at the same or narrower scope.
  const denySet = new Set();
  const allowSet = new Set();

  for (const g of grantRows) {
    const patterns = (g.perms ?? '').split(',').filter(Boolean);
    const expanded = expandPatterns(patterns);
    if (g.effect === 'deny') {
      for (const p of expanded) denySet.add(p);
    } else {
      for (const p of expanded) allowSet.add(p);
    }
  }

  // 5. Resolve each permission with provenance.
  const permissions = {};
  for (const key of allPerms) {
    if (denySet.has(key)) {
      // Find the grant that caused the deny (first one wins for reporting).
      const grantId = grantRows.find(g => {
        const patterns = (g.perms ?? '').split(',').filter(Boolean);
        return g.effect === 'deny' && expandPatterns(patterns).has(key);
      })?.id ?? null;
      permissions[key] = { effect: 'deny', source: grantId ? `grant:${grantId}` : null, reason: 'explicit_deny' };
    } else if (baseline.has(key) || allowSet.has(key)) {
      let source;
      if (allowSet.has(key)) {
        const grantId = grantRows.find(g => {
          const patterns = (g.perms ?? '').split(',').filter(Boolean);
          return g.effect === 'allow' && expandPatterns(patterns).has(key);
        })?.id;
        source = grantId ? `grant:${grantId}` : `role:${role}`;
      } else {
        source = `role:${role}`;
      }
      permissions[key] = { effect: 'allow', source, reason: null };
    } else {
      permissions[key] = { effect: 'deny', source: null, reason: 'implicit' };
    }
  }

  return { role, status, permissions };
}

// ---------------------------------------------------------------------------
// Batched resolve for list endpoints — avoids calling resolve() N times.
// Returns { role, byDevice: { [deviceId]: { [permKey]: {...} } } }
// ---------------------------------------------------------------------------
export function resolveDevices(db, { userId, orgId, deviceIds, now = new Date() }) {
  const nowIso = now.toISOString();

  const membership = db.prepare(
    'SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ? LIMIT 1'
  ).get(orgId, userId);

  const allPerms = db.prepare('SELECT key FROM permissions').all().map(r => r.key);
  const emptySet = Object.fromEntries(
    allPerms.map(k => [k, { effect: 'deny', source: null, reason: 'not_a_member' }])
  );

  if (!membership || membership.status !== 'active') {
    const reason = membership?.status === 'suspended' ? 'suspended' : 'not_a_member';
    return {
      role: membership?.role ?? null,
      byDevice: Object.fromEntries(
        deviceIds.map(id => [id, Object.fromEntries(allPerms.map(k => [k, { effect: 'deny', source: null, reason }]))])
      ),
    };
  }

  const { role } = membership;
  const baseline = new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role = ?').all(role).map(r => r.permission)
  );

  // One query for all grants touching any of the requested devices or org-wide.
  const placeholders = deviceIds.map(() => '?').join(',');
  const grantRows = db.prepare(`
    SELECT g.id, g.effect, g.device_id, GROUP_CONCAT(gp.permission) AS perms
      FROM grants g
      JOIN grant_permissions gp ON gp.grant_id = g.id
     WHERE g.user_id = ? AND g.org_id = ?
       AND g.revoked_at IS NULL
       AND (g.starts_at IS NULL OR g.starts_at <= ?)
       AND (g.expires_at IS NULL OR g.expires_at > ?)
       AND (g.device_id IS NULL OR g.device_id IN (${placeholders}))
     GROUP BY g.id
  `).all(userId, orgId, nowIso, nowIso, ...deviceIds);

  const allPatterns = db.prepare('SELECT pattern FROM permission_patterns').all().map(r => r.pattern);

  function expandPatterns(rawPerms) {
    const result = new Set();
    for (const p of rawPerms) {
      if (p.endsWith(':*') || p === '*') {
        const prefix = p === '*' ? '' : p.slice(0, p.length - 1);
        for (const k of allPerms) {
          if (p === '*' || k.startsWith(prefix)) result.add(k);
        }
      } else if (allPerms.includes(p)) {
        result.add(p);
      }
    }
    return result;
  }

  const byDevice = {};
  for (const deviceId of deviceIds) {
    // Grants that apply to this device: org-wide (device_id IS NULL) + this device.
    const applicable = grantRows.filter(g => g.device_id === null || g.device_id === deviceId);

    const denySet = new Set();
    const allowSet = new Set();
    const grantSource = {};

    for (const g of applicable) {
      const patterns = (g.perms ?? '').split(',').filter(Boolean);
      const expanded = expandPatterns(patterns);
      for (const p of expanded) {
        if (g.effect === 'deny') {
          denySet.add(p);
          if (!grantSource[`deny:${p}`]) grantSource[`deny:${p}`] = g.id;
        } else {
          allowSet.add(p);
          if (!grantSource[`allow:${p}`]) grantSource[`allow:${p}`] = g.id;
        }
      }
    }

    const permissions = {};
    for (const key of allPerms) {
      if (denySet.has(key)) {
        permissions[key] = { effect: 'deny', source: `grant:${grantSource[`deny:${key}`]}`, reason: 'explicit_deny' };
      } else if (baseline.has(key) || allowSet.has(key)) {
        const gId = grantSource[`allow:${key}`];
        permissions[key] = { effect: 'allow', source: gId ? `grant:${gId}` : `role:${role}`, reason: null };
      } else {
        permissions[key] = { effect: 'deny', source: null, reason: 'implicit' };
      }
    }
    byDevice[deviceId] = permissions;
  }

  return { role, byDevice };
}

// ---------------------------------------------------------------------------
// Convenience helpers used by routes.
// ---------------------------------------------------------------------------

export function can(db, ctx, permission, deviceId = null) {
  const result = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  return result.permissions[permission]?.effect === 'allow';
}

export function assertCan(db, ctx, permission, deviceId = null) {
  const result = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  const p = result.permissions[permission];
  if (!p || p.effect !== 'allow') {
    throw forbidden(
      `missing permission: ${permission}`,
      p?.reason === 'explicit_deny' ? 'explicit_deny' : 'missing_permission'
    );
  }
}

// No privilege laundering: the caller must hold every permission they are granting,
// at the same scope (org-wide if no device, device-level if device is given).
export function assertMayGrant(db, ctx, patterns, deviceId = null) {
  const allPerms = db.prepare('SELECT key FROM permissions').all().map(r => r.key);
  const allPatternKeys = db.prepare('SELECT pattern FROM permission_patterns').all().map(r => r.pattern);

  // Expand patterns to concrete permissions for the "holds" check.
  function expand(p) {
    if (p.endsWith(':*') || p === '*') {
      const prefix = p === '*' ? '' : p.slice(0, p.length - 1);
      return allPerms.filter(k => p === '*' || k.startsWith(prefix));
    }
    return allPerms.includes(p) ? [p] : [];
  }

  const result = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });

  for (const pattern of patterns) {
    const concrete = expand(pattern);
    for (const perm of concrete) {
      if (result.permissions[perm]?.effect !== 'allow') {
        throw forbidden(
          `cannot grant ${perm}: you do not hold it at this scope`,
          'missing_permission'
        );
      }
    }
  }
}

// The compound session check: session:start AND the mode permission, both on the same device.
// The refusal must distinguish which was missing.
export function assertCanStartSession(db, ctx, mode, deviceId) {
  const modePerm = MODE_PERMISSION[mode];
  if (!modePerm) throw forbidden(`unknown session mode: ${mode}`);

  const result = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });

  if (result.permissions['session:start']?.effect !== 'allow') {
    const err = forbidden('missing session:start permission', 'missing_permission');
    err.reason = 'missing_permission';
    throw err;
  }

  if (result.permissions[modePerm]?.effect !== 'allow') {
    const err = forbidden(`missing ${modePerm} permission for this device`, 'missing_device_permission');
    err.reason = 'missing_device_permission';
    throw err;
  }
}
