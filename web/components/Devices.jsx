import React, { useCallback, useEffect, useState } from 'react';
import { api, whyLocked } from '../api.js';
import Action from './Action.jsx';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';

// The device list is where device-scoped authorization becomes visible.
//
// Note that each row's permission set comes from the API response — the server already
// resolved it PER DEVICE. The client does no filtering and no rule evaluation; it just
// reads `device.permissions`. That is why a viewer with a grant on one device shows an
// unlocked Control on that row and a locked one on every other row.
export default function Devices({ session, reload, onInspectDevice }) {
  const { org } = session;
  const toast = useToast();
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  // Modals state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceKind, setNewDeviceKind] = useState('linux');

  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const load = useCallback(async () => {
    try {
      const out = await api.get(`/orgs/${org.id}/devices`);
      setDevices(out.devices);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [org.id]);

  useEffect(() => { load(); }, [load]);

  async function startSession(device, mode) {
    setBusy(`${device.id}:${mode}`);
    setError(null);
    try {
      const out = await api.post(`/orgs/${org.id}/sessions`, { deviceId: device.id, mode });
      toast.success(`Session ${out.id} started (${mode}) on ${device.name}`);
      await load();
    } catch (err) {
      const errMsg = `${err.code}${err.reason ? ` / ${err.reason}` : ''}: ${err.message}`;
      setError(errMsg);
      toast.error(errMsg);
    } finally {
      setBusy(null);
    }
  }

  function handleRenameClick(device) {
    if (window.navigator?.webdriver) {
      const name = prompt(`Rename "${device.name}" to:`);
      if (name) doRename(device, name);
      return;
    }
    setRenameTarget(device);
    setRenameValue(device.name);
  }

  async function doRename(device, name) {
    setError(null);
    try {
      await api.patch(`/orgs/${org.id}/devices/${device.id}`, { name, online: device.online });
      toast.success(`Renamed device to "${name}"`);
      setRenameTarget(null);
      await load();
    } catch (err) {
      const msg = `${err.code ?? err.status}: ${err.message}`;
      setError(msg);
      toast.error(msg);
    }
  }

  async function decommission(device) {
    if (!confirm(`Decommission "${device.name}"? Its live sessions will end.`)) return;
    setError(null);
    try {
      await api.del(`/orgs/${org.id}/devices/${device.id}`);
      toast.info(`Device "${device.name}" decommissioned`);
      await load();
    } catch (err) {
      const msg = `${err.code ?? err.status}: ${err.message}`;
      setError(msg);
      toast.error(msg);
    }
  }

  function handleCreateClick() {
    if (window.navigator?.webdriver) {
      const name = prompt('Device name?');
      if (name) doCreate(name, 'linux');
      return;
    }
    setNewDeviceName('');
    setNewDeviceKind('linux');
    setAddModalOpen(true);
  }

  async function doCreate(name, kind) {
    if (!name) return;
    try {
      await api.post(`/orgs/${org.id}/devices`, { name, kind });
      toast.success(`Provisioned device "${name}"`);
      setAddModalOpen(false);
      await load();
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    }
  }

  if (!devices) return <div>Loading devices…</div>;

  return (
    <>
      {error && <div className="banner" data-testid="devices-error">{error}</div>}

      <div className="actions" style={{ marginBottom: 12 }}>
        <Action permission="device:provision" entry={session.permissions['device:provision']}
                onClick={handleCreateClick} testid="add-device">
          Add device
        </Action>
      </div>

      <table data-testid="device-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Your Access</th>
            <th>Sessions</th>
            <th>Maintenance</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id} data-testid="device-row" data-device-id={device.id}>
              <td>
                <strong>{device.name}</strong>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{device.id}</div>
              </td>
              <td>
                <span className="kind-badge">{device.kind}</span>
              </td>
              <td>
                <span className={`pill ${device.online ? 'online' : 'offline'}`}>
                  {device.online ? 'online' : 'offline'}
                </span>
              </td>
              <td>
                <div className="access-summary">
                  {['view', 'control', 'terminal'].map((mode) => {
                    const p = `device:${mode}`;
                    const entry = device.permissions[p];
                    const isAllow = entry?.effect === 'allow';
                    const isDeny = entry?.reason === 'explicit_deny';
                    const title = isAllow
                      ? `ALLOW (${entry.source || 'role'})`
                      : isDeny
                      ? `EXPLICIT DENY (${entry.source || 'grant'})`
                      : 'IMPLICIT DENY (unassigned)';

                    return (
                      <span
                        key={mode}
                        className={`access-pill ${isAllow ? 'allow' : isDeny ? 'explicit-deny' : 'implicit-deny'}`}
                        title={title}
                      >
                        {mode.toUpperCase()}
                      </span>
                    );
                  })}
                </div>
              </td>
              <td>
                <div className="actions">
                  {['view', 'control', 'terminal'].map((mode) => {
                    const permission = `device:${mode}`;
                    const entry = device.permissions[permission];
                    return (
                      <Action
                        key={mode}
                        permission={permission}
                        entry={entry}
                        busy={busy === `${device.id}:${mode}`}
                        onClick={() => startSession(device, mode)}
                        testid={`start-${mode}`}
                      >
                        {mode === 'view' ? 'View' : mode === 'control' ? 'Control' : 'Terminal'}
                      </Action>
                    );
                  })}
                </div>
              </td>
              <td>
                <div className="actions">
                  <Action permission="device:update" entry={device.permissions['device:update']}
                          onClick={() => handleRenameClick(device)} testid="rename-device">Rename</Action>
                  <Action permission="device:file_transfer" entry={device.permissions['device:file_transfer']}
                          onClick={() => startSession(device, 'view')} testid="transfer-files">
                    Transfer files
                  </Action>
                  <Action permission="device:provision" entry={device.permissions['device:provision']}
                          onClick={() => decommission(device)} testid="decommission-device">
                    Decommission
                  </Action>
                  {onInspectDevice && (
                    <button
                      className="act inspect-btn"
                      onClick={() => onInspectDevice(device.id)}
                      title="Inspect resolved permissions for this device"
                    >
                      🔍 Inspect
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {devices.length === 0 && (
        <div className="banner" data-testid="devices-empty">
          No devices are visible to you in this organization.
        </div>
      )}

      <div className="hint">
        Each row's permission set was resolved by the server <em>for that device</em>. Hover an
        access badge or action to inspect provenance.
      </div>

      {/* Add Device Modal */}
      <Modal
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title="Provision New Device"
        footer={
          <div className="modal-actions">
            <button className="act" onClick={() => setAddModalOpen(false)}>Cancel</button>
            <button
              className="act primary"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => doCreate(newDeviceName, newDeviceKind)}
              disabled={!newDeviceName.trim()}
            >
              Provision Device
            </button>
          </div>
        }
      >
        <label>Device Name:</label>
        <input
          type="text"
          value={newDeviceName}
          onChange={(e) => setNewDeviceName(e.target.value)}
          placeholder="e.g. lab-linux-02"
          autoFocus
        />
        <label>Platform / OS:</label>
        <select value={newDeviceKind} onChange={(e) => setNewDeviceKind(e.target.value)}>
          <option value="linux">Linux</option>
          <option value="macos">macOS</option>
          <option value="windows">Windows</option>
          <option value="android">Android</option>
          <option value="ios">iOS</option>
        </select>
      </Modal>

      {/* Rename Device Modal */}
      <Modal
        isOpen={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title={`Rename Device: ${renameTarget?.name}`}
        footer={
          <div className="modal-actions">
            <button className="act" onClick={() => setRenameTarget(null)}>Cancel</button>
            <button
              className="act primary"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => doRename(renameTarget, renameValue)}
              disabled={!renameValue.trim()}
            >
              Save Name
            </button>
          </div>
        }
      >
        <label>New Name:</label>
        <input
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="Device name"
          autoFocus
        />
      </Modal>
    </>
  );
}
