import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { ConfirmModal, Modal } from './Dialogs.jsx';

// Organization admin tools: rename the org, rename or delete branches, manage org admins.
export default function OrgSettings({ org, onClose, onChanged, toast }) {
  const [name, setName] = useState(org.name);
  const [admins, setAdmins] = useState([]);
  const [adminEmail, setAdminEmail] = useState('');
  const [tenantNames, setTenantNames] = useState(() => Object.fromEntries(org.tenants.map((t) => [t.id, t.name])));
  const [confirm, setConfirm] = useState(null);
  const base = `/api/orgs/${org.id}`;

  const loadAdmins = () => api.get(`${base}/admins`).then((r) => setAdmins(r.admins)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { loadAdmins(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn, okMessage) => {
    try {
      await fn();
      if (okMessage) toast(okMessage, 'info');
      await onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <Modal title="Organization settings" onClose={onClose} wide>
      <div className="stack">
        <section className="stack">
          <h3>Organization name</h3>
          <div className="row">
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Organization name" />
            <button className="btn" disabled={!name.trim() || name === org.name}
              onClick={() => run(() => api.patch(base, { name: name.trim() }), 'Organization renamed')}>Rename</button>
          </div>
        </section>

        <section className="stack">
          <h3>Branches</h3>
          {org.tenants.map((t) => (
            <div className="row" key={t.id}>
              <input value={tenantNames[t.id] ?? ''} maxLength={80} aria-label={`Name of ${t.name}`}
                onChange={(e) => setTenantNames((n) => ({ ...n, [t.id]: e.target.value }))} />
              <button className="btn" disabled={!tenantNames[t.id]?.trim() || tenantNames[t.id] === t.name}
                onClick={() => run(() => api.patch(`/api/tenants/${t.id}`, { name: tenantNames[t.id].trim() }), 'Branch renamed')}>Rename</button>
              <button className="btn btn-danger-ghost" onClick={() => setConfirm({ type: 'tenant', tenant: t })}>Delete</button>
            </div>
          ))}
        </section>

        <section className="stack">
          <h3>Organization admins</h3>
          <p className="muted small">Org admins can open every branch of this organization and manage branches.</p>
          <ul className="member-list">
            {admins.map((a) => (
              <li key={a.id}>
                <div className="member-info"><div>{a.name}</div><div className="muted small">{a.email}</div></div>
                <button className="icon-btn" aria-label={`Remove ${a.name} as admin`}
                  onClick={() => run(async () => { await api.del(`${base}/admins/${a.id}`); await loadAdmins(); }, 'Admin removed')}>✕</button>
              </li>
            ))}
          </ul>
          <form className="row" onSubmit={(e) => {
            e.preventDefault();
            run(async () => { await api.post(`${base}/admins`, { email: adminEmail }); setAdminEmail(''); await loadAdmins(); }, 'Admin added');
          }}>
            <input type="email" required placeholder="email of an existing user" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            <button className="btn">Add admin</button>
          </form>
        </section>

        <section className="stack danger-zone">
          <h3>Danger zone</h3>
          <button className="btn btn-danger" onClick={() => setConfirm({ type: 'org' })}>Delete organization</button>
        </section>
      </div>

      {confirm?.type === 'tenant' && (
        <ConfirmModal title="Delete branch" confirmLabel="Delete branch"
          message={`Delete "${confirm.tenant.name}" with all its boards and tasks? This cannot be undone.`}
          onConfirm={() => run(() => api.del(`/api/tenants/${confirm.tenant.id}`), 'Branch deleted')}
          onClose={() => setConfirm(null)} />
      )}
      {confirm?.type === 'org' && (
        <ConfirmModal title="Delete organization" confirmLabel="Delete everything"
          message={`Delete "${org.name}", all its branches, boards and tasks? This cannot be undone.`}
          onConfirm={() => run(async () => { await api.del(base); onClose(); }, 'Organization deleted')}
          onClose={() => setConfirm(null)} />
      )}
    </Modal>
  );
}
