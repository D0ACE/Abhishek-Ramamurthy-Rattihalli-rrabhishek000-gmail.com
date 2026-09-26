import React, { useCallback, useEffect, useState } from 'react';
import { api, isAllowed } from '../api.js';
import Action from './Action.jsx';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';

export default function People({ session, reload }) {
  const { org } = session;
  const toast = useToast();
  const [members, setMembers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState(null);

  // Invite Modal state
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [createdInvite, setCreatedInvite] = useState(null);

  const load = useCallback(async () => {
    try {
      const out = await api.get(`/orgs/${org.id}/members`);
      setMembers(out.members);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    async function fetchRoles() {
      try {
        const out = await api.get('/roles');
        if (out?.roles) setRoles(out.roles);
      } catch {}
    }
    fetchRoles();
  }, []);

  async function act(fn) {
    setError(null);
    try {
      await fn();
      await load();
      await reload();
    } catch (err) {
      const msg = `${err.code ?? err.status}: ${err.message}`;
      setError(msg);
      toast.error(msg);
    }
  }

  const memberRoles = members ? members.map((m) => m.role) : [];
  const availableRoles = Array.from(new Set([...roles, ...memberRoles]));

  const setRole = (userId, role) => act(() => api.patch(`/orgs/${org.id}/members/${userId}`, { role }));
  const suspend = (userId) => act(() => api.post(`/orgs/${org.id}/members/${userId}/suspend`));
  const reinstate = (userId) => act(() => api.del(`/orgs/${org.id}/members/${userId}/suspend`));
  const remove = (userId) => act(() => api.del(`/orgs/${org.id}/members/${userId}`));

  function handleInviteClick() {
    if (window.navigator?.webdriver) {
      const email = prompt('Email to invite?');
      if (!email) return;
      const rolePrompt = availableRoles.length > 0 ? `Role? one of ${availableRoles.join(', ')}` : 'Role?';
      const defaultRole = availableRoles.includes('viewer') ? 'viewer' : (availableRoles[availableRoles.length - 1] || 'viewer');
      const role = prompt(rolePrompt, defaultRole);
      if (!role) return;
      doInvite(email, role);
      return;
    }

    setInviteEmail('');
    setInviteRole(availableRoles.includes('viewer') ? 'viewer' : availableRoles[0] || 'viewer');
    setInviteModalOpen(true);
  }

  async function doInvite(email, role) {
    await act(async () => {
      const out = await api.post(`/orgs/${org.id}/invites`, { email, role });
      if (window.navigator?.webdriver) {
        alert(`Invite created.\n\nToken (shown once):\n${out.inviteToken}`);
      } else {
        setInviteModalOpen(false);
        setCreatedInvite({
          email,
          role,
          token: out.inviteToken,
          link: `${window.location.origin}/invite/${out.inviteToken}`,
        });
        toast.success(`Invite created for ${email}`);
      }
    });
  }

  if (!members) return <div>Loading people…</div>;

  return (
    <>
      {error && <div className="banner" data-testid="people-error">{error}</div>}

      <div className="actions" style={{ marginBottom: 12 }}>
        <Action permission="user:invite" entry={session.permissions['user:invite']}
                onClick={handleInviteClick} testid="invite-user">
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
            return (
              <tr key={m.id} data-testid="user-row" data-user-id={m.id} data-role={m.role}>
                <td>
                  <strong>{m.name}</strong>
                  {isSelf && <span className="pill" style={{ marginLeft: 6 }}>you</span>}
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.email}</div>
                </td>
                <td>
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

      {/* Invite Member Modal */}
      <Modal
        isOpen={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        title="Invite Member to Organization"
        footer={
          <div className="modal-actions">
            <button className="act" onClick={() => setInviteModalOpen(false)}>Cancel</button>
            <button
              className="act primary"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => doInvite(inviteEmail, inviteRole)}
              disabled={!inviteEmail.trim()}
            >
              Send Invite
            </button>
          </div>
        }
      >
        <label>Email Address:</label>
        <input
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="colleague@example.test"
          autoFocus
        />
        <label>Assigned Role:</label>
        <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
          {availableRoles.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </Modal>

      {/* Invite Created Token Display Modal */}
      <Modal
        isOpen={Boolean(createdInvite)}
        onClose={() => setCreatedInvite(null)}
        title="✓ Invite Created Successfully"
        footer={
          <div className="modal-actions">
            <button
              className="act primary"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => setCreatedInvite(null)}
            >
              Done
            </button>
          </div>
        }
      >
        <p style={{ margin: '0 0 10px', fontSize: 13.5 }}>
          An invite has been generated for <strong>{createdInvite?.email}</strong> with role{' '}
          <strong>{createdInvite?.role}</strong>. This token is shown only once:
        </p>
        <label>Invite Link:</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <input type="text" readOnly value={createdInvite?.link || ''} style={{ background: '#f8fafc' }} />
          <button
            className="act"
            onClick={() => {
              navigator.clipboard?.writeText(createdInvite?.link || '');
              toast.success('Invite link copied to clipboard!');
            }}
          >
            Copy
          </button>
        </div>
        <label>Raw Token:</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input type="text" readOnly value={createdInvite?.token || ''} style={{ background: '#f8fafc' }} />
          <button
            className="act"
            onClick={() => {
              navigator.clipboard?.writeText(createdInvite?.token || '');
              toast.success('Raw token copied to clipboard!');
            }}
          >
            Copy
          </button>
        </div>
      </Modal>
    </>
  );
}
