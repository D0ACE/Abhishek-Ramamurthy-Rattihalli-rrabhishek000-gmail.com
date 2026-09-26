import React, { useCallback, useEffect, useState } from 'react';
import { api, isAllowed } from '../api.js';
import Action from './Action.jsx';

export default function People({ session, reload }) {
  const { org } = session;
  const [members, setMembers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [membersRes, rolesRes] = await Promise.all([
        api.get(`/orgs/${org.id}/members`),
        api.get(`/orgs/${org.id}/roles`).catch(() => ({ roles: [] })),
      ]);
      setMembers(membersRes.members);
      if (rolesRes && Array.isArray(rolesRes.roles) && rolesRes.roles.length > 0) {
        setRoles(rolesRes.roles);
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  async function act(fn) {
    setError(null);
    try {
      await fn();
      await load();
      await reload();   // permissions may have changed; re-read server truth
    } catch (err) {
      setError(`${err.code ?? err.status}${err.reason ? ` / ${err.reason}` : ''}: ${err.message}`);
    }
  }

  // Derive available roles dynamically from server and current members (no hardcoded roles)
  const memberRoles = members ? members.map((m) => m.role) : [];
  const availableRoles = Array.from(new Set([...roles, ...memberRoles]));

  const setRole = (userId, role) => act(() => api.patch(`/orgs/${org.id}/members/${userId}`, { role }));
  const suspend = (userId) => act(() => api.post(`/orgs/${org.id}/members/${userId}/suspend`));
  const reinstate = (userId) => act(() => api.del(`/orgs/${org.id}/members/${userId}/suspend`));
  const remove = (userId) => act(() => api.del(`/orgs/${org.id}/members/${userId}`));

  async function invite() {
    const email = prompt('Email to invite?');
    if (!email) return;
    const rolePrompt = availableRoles.length > 0
      ? `Role? one of ${availableRoles.join(', ')}`
      : 'Role?';
    const defaultRole = availableRoles.includes('viewer')
      ? 'viewer'
      : (availableRoles[availableRoles.length - 1] || 'viewer');
    const role = prompt(rolePrompt, defaultRole);
    if (!role) return;
    await act(async () => {
      const out = await api.post(`/orgs/${org.id}/invites`, { email, role });
      // Shown once. There is no endpoint that returns it again.
      alert(`Invite created.\n\nToken (shown once):\n${out.inviteToken}`);
    });
  }

  if (!members) return <div>Loading people…</div>;

  return (
    <>
      {error && <div className="banner" data-testid="people-error">{error}</div>}

      <div className="actions" style={{ marginBottom: 12 }}>
        <Action permission="user:invite" entry={session.permissions['user:invite']}
                onClick={invite} testid="invite-user">
          Invite someone
        </Action>
      </div>

      <table data-testid="people-table">
        <thead>
          <tr><th>Person</th><th>Role</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const isSelf = m.id === session.user.id;
            const canUpdateRole = isAllowed(session.permissions, 'user:role:update') && !isSelf;
            const canRemove = isAllowed(session.permissions, 'user:remove') && !isSelf;
            return (
              <tr key={m.id} data-testid="user-row" data-user-id={m.id} data-role={m.role}>
                <td>
                  <strong>{m.name}</strong>
                  {isSelf && <span className="pill" style={{ marginLeft: 6 }}>you</span>}
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.email}</div>
                </td>
                <td>
                  {/* Presence, not state: the select exists only for levels holding
                      user:role:update. Everyone else sees their role as plain text. */}
                  {canUpdateRole ? (
                    <select
                      value={m.role}
                      data-testid="role-select"
                      data-permission="user:role:update"
                      data-state="unlocked"
                      onChange={(e) => setRole(m.id, e.target.value)}
                    >
                      {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span data-testid="role-label" data-permission="user:role:update">{m.role}</span>
                  )}
                </td>
                <td><span className={`pill ${m.status === 'active' ? 'online' : ''}`}>{m.status}</span></td>
                <td>
                  <div className="actions">
                    {m.status === 'active'
                      ? <Action permission="user:remove" entry={session.permissions['user:remove']}
                                onClick={() => suspend(m.id)} testid="suspend-user">Suspend</Action>
                      : <Action permission="user:remove" entry={session.permissions['user:remove']}
                                onClick={() => reinstate(m.id)} testid="reinstate-user">Reinstate</Action>}
                    <Action permission="user:remove" entry={session.permissions['user:remove']}
                            onClick={() => remove(m.id)} testid="remove-user">Remove</Action>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="hint">
        Removing a person removes their <strong>membership</strong>, never the user account —
        they may belong to other organizations, and their audit history must survive.
      </div>
    </>
  );
}
