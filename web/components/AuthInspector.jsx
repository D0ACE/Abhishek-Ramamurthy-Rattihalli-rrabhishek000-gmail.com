import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function AuthInspector({ session, activeDeviceId, onClose }) {
  const { org, user, role, permissions: orgPermissions } = session;
  const [selectedDevice, setSelectedDevice] = useState(activeDeviceId ?? 'org-wide');
  const [deviceList, setDeviceList] = useState([]);
  const [devicePerms, setDevicePerms] = useState(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function fetchDevices() {
      try {
        const out = await api.get(`/orgs/${org.id}/devices`);
        setDeviceList(out.devices || []);
      } catch {}
    }
    fetchDevices();
  }, [org.id]);

  useEffect(() => {
    if (activeDeviceId) {
      setSelectedDevice(activeDeviceId);
    }
  }, [activeDeviceId]);

  useEffect(() => {
    if (selectedDevice === 'org-wide') {
      setDevicePerms(null);
      return;
    }
    async function loadDevice() {
      setLoading(true);
      try {
        const dev = await api.get(`/orgs/${org.id}/devices/${selectedDevice}`);
        setDevicePerms(dev.permissions);
      } catch {
        setDevicePerms(null);
      } finally {
        setLoading(false);
      }
    }
    loadDevice();
  }, [selectedDevice, org.id]);

  const activePerms = devicePerms ?? orgPermissions;
  const currentDeviceName = deviceList.find((d) => d.id === selectedDevice)?.name;

  const entries = Object.entries(activePerms || {}).filter(([perm]) => {
    if (!filter) return true;
    return perm.toLowerCase().includes(filter.toLowerCase());
  });

  return (
    <div className="inspector-panel" data-testid="auth-inspector">
      <div className="inspector-header">
        <div>
          <h3 className="inspector-title">🔍 Authorization Inspector</h3>
          <div className="inspector-subtitle">
            Evaluating resolved authority for <strong>{user.name}</strong> ({role}) in <strong>{org.name}</strong>
          </div>
        </div>
        {onClose && (
          <button className="modal-close" onClick={onClose} aria-label="Close inspector">
            ×
          </button>
        )}
      </div>

      <div className="inspector-controls">
        <div style={{ flex: 1, minWidth: 220 }}>
          <label className="inspector-label">Resolution Scope:</label>
          <select
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
            className="inspector-select"
          >
            <option value="org-wide">🌐 Organization Scope (Org-wide Union)</option>
            {deviceList.map((d) => (
              <option key={d.id} value={d.id}>
                💻 Device: {d.name} ({d.kind})
              </option>
            ))}
          </select>
        </div>

        <div style={{ flex: 1, minWidth: 180 }}>
          <label className="inspector-label">Filter Permission:</label>
          <input
            type="text"
            placeholder="Search permissions…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="inspector-input"
          />
        </div>
      </div>

      <div className="inspector-context-box">
        <strong>Active Evaluation Scope:</strong>{' '}
        {selectedDevice === 'org-wide' ? (
          <span>Org-wide baseline + org-level grants</span>
        ) : (
          <span>Device: <code>{currentDeviceName || selectedDevice}</code> (includes device-scoped overrides)</span>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>Resolving permissions…</div>
      ) : (
        <div className="inspector-table-wrapper">
          <table className="inspector-table">
            <thead>
              <tr>
                <th>Permission</th>
                <th>Effect</th>
                <th>Source</th>
                <th>Reason / Provenance</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([perm, entry]) => {
                const effect = entry.effect;
                const reason = entry.reason;
                const source = entry.source;

                let badgeClass = 'pill-implicit';
                let effectLabel = 'IMPLICIT DENY';
                if (effect === 'allow') {
                  badgeClass = 'pill-allow';
                  effectLabel = 'ALLOW';
                } else if (reason === 'explicit_deny') {
                  badgeClass = 'pill-deny';
                  effectLabel = 'EXPLICIT DENY';
                }

                return (
                  <tr key={perm}>
                    <td>
                      <code>{perm}</code>
                    </td>
                    <td>
                      <span className={`inspector-pill ${badgeClass}`}>{effectLabel}</span>
                    </td>
                    <td>
                      {source ? (
                        <code className="source-tag">{source}</code>
                      ) : (
                        <span className="muted-text">—</span>
                      )}
                    </td>
                    <td>
                      {reason ? (
                        <span className="reason-text">{reason}</span>
                      ) : effect === 'allow' ? (
                        <span className="reason-text" style={{ color: 'var(--ok)' }}>
                          granted by {source}
                        </span>
                      ) : (
                        <span className="muted-text">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="hint" style={{ marginTop: 12 }}>
        <strong>Precedence Engine:</strong> Deny overrides Allow unconditionally. Device-scoped allows cannot carve out
        org-wide denies. All provenance is resolved server-side.
      </div>
    </div>
  );
}
