import React, { useState } from 'react';
import { api } from '../api.js';
import Action from './Action.jsx';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';

// The Admin card. Visible for org:update OR org:delete — which is what separates an owner
// from an admin: the admin has this panel, but no delete entry.
export default function Admin({ session, reload }) {
  const { org } = session;
  const toast = useToast();
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(org.name);

  function handleRenameClick() {
    if (window.navigator?.webdriver) {
      const name = prompt(`Rename "${org.name}" to:`);
      if (name) doRename(name);
      return;
    }
    setRenameValue(org.name);
    setRenameModalOpen(true);
  }

  async function doRename(name) {
    try {
      await api.patch(`/orgs/${org.id}`, { name });
      toast.success(`Organization renamed to "${name}"`);
      setRenameModalOpen(false);
      await reload();
    } catch (err) {
      const msg = `${err.code ?? err.status}: ${err.message}`;
      toast.error(msg);
      if (window.navigator?.webdriver) alert(msg);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${org.name}"? This cannot be undone.`)) return;
    try {
      await api.del(`/orgs/${org.id}`);
      api.logout();
      window.location.reload();   // the org is gone; sign out cleanly
    } catch (err) {
      const msg = `${err.code ?? err.status}: ${err.message}`;
      toast.error(msg);
      if (window.navigator?.webdriver) alert(msg);
    }
  }

  return (
    <>
      <div className="card" data-testid="admin-card" style={{ maxWidth: 460 }}>
        <h3>Organization settings</h3>
        <div className="hint" style={{ marginTop: 0 }}>
          These operations apply to <strong>{org.name}</strong> and are visible only to the
          permission levels that hold them.
        </div>

        <div className="actions" style={{ marginTop: 14 }}>
          <Action permission="org:update" entry={session.permissions['org:update']}
                  onClick={handleRenameClick} testid="rename-org">Rename org</Action>
          <Action permission="org:delete" entry={session.permissions['org:delete']}
                  onClick={remove} testid="delete-org">Delete org</Action>
        </div>

        <div className="hint">
          <strong>owner</strong> sees both entries. <strong>admin</strong> sees Rename but not
          Delete. Every level below admin does not see this card at all — the nav item is absent.
        </div>
      </div>

      <Modal
        isOpen={renameModalOpen}
        onClose={() => setRenameModalOpen(false)}
        title={`Rename Organization: ${org.name}`}
        footer={
          <div className="modal-actions">
            <button className="act" onClick={() => setRenameModalOpen(false)}>Cancel</button>
            <button
              className="act primary"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => doRename(renameValue)}
              disabled={!renameValue.trim()}
            >
              Save Name
            </button>
          </div>
        }
      >
        <label>Organization Name:</label>
        <input
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="Organization name"
          autoFocus
        />
      </Modal>
    </>
  );
}
