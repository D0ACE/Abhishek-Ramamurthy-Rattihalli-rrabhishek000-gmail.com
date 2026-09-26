import React, { useCallback, useEffect, useState } from 'react';
import { api, isAllowed, describeError } from './api.js';
import Action from './components/Action.jsx';
import Login from './components/Login.jsx';
import Devices from './components/Devices.jsx';
import People from './components/People.jsx';
import Grants from './components/Grants.jsx';
import Sessions from './components/Sessions.jsx';
import Audit from './components/Audit.jsx';
import AcceptInvite from './components/AcceptInvite.jsx';
import Admin from './components/Admin.jsx';
import Modal from './components/Modal.jsx';
import AuthInspector from './components/AuthInspector.jsx';
import { ToastProvider, useToast } from './components/Toast.jsx';

const NAV = [
  { key: 'devices', label: 'Devices', permission: 'device:list' },
  { key: 'people', label: 'People', permission: 'user:read' },
  { key: 'grants', label: 'Grants', permission: 'user:read' },
  { key: 'sessions', label: 'Sessions', permission: 'session:view' },
  { key: 'audit', label: 'Audit log', permission: 'audit:read' },
  { key: 'admin', label: 'Admin', anyOf: ['org:update', 'org:delete'] },
];

function holds(permissions, item) {
  if (item.anyOf) return item.anyOf.some((p) => isAllowed(permissions, p));
  return isAllowed(permissions, item.permission);
}

const INVITE_PATH = /^\/invite\/([^/]+)$/;
const THEMES = ['cobalt', 'amber', 'moss', 'plum', 'rust', 'teal'];

function MainApp() {
  const inviteToken = INVITE_PATH.exec(window.location.pathname)?.[1] ?? null;
  const toast = useToast();

  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(null);
  const [view, setView] = useState('devices');

  // Org modal state
  const [createOrgModalOpen, setCreateOrgModalOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTheme, setNewOrgTheme] = useState('cobalt');

  // Inspector state
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectedDeviceId, setInspectedDeviceId] = useState(null);

  const reload = useCallback(async () => {
    try {
      setSession(await api.me());
      return true;
    } catch (err) {
      if (err.status === 401) {
        const restored = await api.refresh();
        if (restored) {
          setSession(await api.me());
          return true;
        }
        api.logout();
        setSession(null);
      }
      return false;
    }
  }, []);

  useEffect(() => {
    if (inviteToken) { setBooting(false); return; }
    (async () => {
      try {
        if (await api.refresh()) await reload();
      } catch (err) {
        setBootError(describeError(err));
      } finally {
        setBooting(false);
      }
    })();
  }, [reload, inviteToken]);

  async function switchOrg(orgId) {
    if (orgId === session?.org?.id) return;
    await api.switchOrg(orgId);
    await reload();
    setView('devices');
    setInspectedDeviceId(null);
  }

  async function createOrg() {
    if (window.navigator?.webdriver) {
      const name = prompt('New organization name?');
      if (!name) return;
      await doCreateOrg(name);
      return;
    }
    setNewOrgName('');
    setNewOrgTheme('cobalt');
    setCreateOrgModalOpen(true);
  }

  async function doCreateOrg(name, theme) {
    try {
      const created = await api.post('/orgs', { name, theme });
      await api.switchOrg(created.id);
      await reload();
      setCreateOrgModalOpen(false);
      setView('devices');
      toast.success(`Organization "${name}" created`);
    } catch (err) {
      const msg = `${err.code ?? err.status}: ${err.message}`;
      toast.error(msg);
      if (window.navigator?.webdriver) {
        alert(msg);
      }
    }
  }

  if (inviteToken) {
    return (
      <AcceptInvite
        token={inviteToken}
        onAccepted={async () => {
          window.history.replaceState({}, '', '/');
          window.location.reload();
        }}
      />
    );
  }

  if (booting) return <div className="center">Loading…</div>;
  if (!session) return <Login onSignedIn={reload} initialError={bootError} />;

  const { org, user, role, orgs, permissions } = session;
  const visible = NAV.filter((item) => holds(permissions, item));
  const activeView = visible.find((n) => n.key === view) ?? visible[0];

  return (
    <div className="app-shell" data-testid="app-shell" data-org-id={org.id} data-org-theme={org.theme}>
      <header className="topbar">
        <h1>RemoteOps</h1>

        <div className="org-switcher" data-testid="org-switcher">
          {orgs.map((o) => (
            <button
              key={o.id}
              className="org-option"
              data-testid="org-option"
              data-org-id={o.id}
              data-org-theme={o.theme}
              aria-pressed={o.id === org.id}
              onClick={() => switchOrg(o.id)}
              title={`${o.name} — you are ${o.role} here`}
            >
              {o.name} · {o.role}
            </button>
          ))}
          <button className="org-option" data-testid="create-org" onClick={createOrg}
                  title="Create a new organization; you become its owner">
            + New org
          </button>
        </div>

        <button
          className={`org-option inspector-toggle ${inspectorOpen ? 'active' : ''}`}
          onClick={() => {
            setInspectedDeviceId(null);
            setInspectorOpen((v) => !v);
          }}
          title="Inspect runtime permissions and provenance"
        >
          🔍 Auth Inspector
        </button>

        <span className="who">
          {user.name} · <strong data-testid="active-role">{role}</strong>
        </span>
        <button className="org-option" onClick={() => { api.logout(); setSession(null); }}>Sign out</button>
      </header>

      <div className="layout">
        <nav className="nav">
          {visible.map((item) => (
            <button
              key={item.key}
              data-testid={`nav-${item.key}`}
              data-permission={item.permission ?? item.anyOf?.join('|')}
              data-state="unlocked"
              aria-current={item.key === activeView.key}
              onClick={() => {
                setView(item.key);
                setInspectorOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main className="main">
          {inspectorOpen ? (
            <AuthInspector
              session={session}
              activeDeviceId={inspectedDeviceId}
              onClose={() => setInspectorOpen(false)}
            />
          ) : (
            <>
              <h2>{activeView.label}</h2>
              <div className="sub">
                {org.name} — you are <strong>{role}</strong> in this organization
              </div>

              {activeView.key === 'devices' && (
                <Devices
                  session={session}
                  reload={reload}
                  onInspectDevice={(devId) => {
                    setInspectedDeviceId(devId);
                    setInspectorOpen(true);
                  }}
                />
              )}
              {activeView.key === 'people' && <People session={session} reload={reload} />}
              {activeView.key === 'grants' && <Grants session={session} reload={reload} />}
              {activeView.key === 'sessions' && <Sessions session={session} reload={reload} />}
              {activeView.key === 'audit' && <Audit session={session} reload={reload} />}
              {activeView.key === 'admin' && <Admin session={session} reload={reload} />}
            </>
          )}
        </main>
      </div>

      {/* Create Organization Modal */}
      <Modal
        isOpen={createOrgModalOpen}
        onClose={() => setCreateOrgModalOpen(false)}
        title="Create New Organization"
        footer={
          <div className="modal-actions">
            <button className="act" onClick={() => setCreateOrgModalOpen(false)}>Cancel</button>
            <button
              className="act primary"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => doCreateOrg(newOrgName, newOrgTheme)}
              disabled={!newOrgName.trim()}
            >
              Create Organization
            </button>
          </div>
        }
      >
        <label>Organization Name:</label>
        <input
          type="text"
          value={newOrgName}
          onChange={(e) => setNewOrgName(e.target.value)}
          placeholder="e.g. Apex Dynamics"
          autoFocus
        />
        <label>Visual Color Theme:</label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {THEMES.map((th) => (
            <button
              key={th}
              type="button"
              className={`theme-badge ${newOrgTheme === th ? 'selected' : ''}`}
              data-theme={th}
              onClick={() => setNewOrgTheme(th)}
              style={{ textTransform: 'capitalize' }}
            >
              {th}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <MainApp />
    </ToastProvider>
  );
}
