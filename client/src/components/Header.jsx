import { ROLE_LABELS } from '../lib/format.js';
import Avatar from './Avatar.jsx';

// Top bar: organization selector, branch (tenant) switcher and the signed-in user.
export default function Header({ user, orgs, org, tenant, onSelectOrg, onSelectTenant, onNewOrg, onNewTenant, onOrgSettings, onSignOut }) {
  const isOrgAdmin = org?.role === 'org_admin';

  return (
    <header className="header">
      <div className="brand"><span className="brand-mark" aria-hidden="true" />Kanban Teams</div>

      <div className="header-group">
        <label className="select-wrap">
          <span className="sr-only">Organization</span>
          <select
            className="select"
            value={org?.id ?? ''}
            onChange={(e) => (e.target.value === '__new' ? onNewOrg() : onSelectOrg(e.target.value))}
            aria-label="Organization"
          >
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            <option value="__new">+ New organization…</option>
          </select>
        </label>
        {isOrgAdmin && (
          <button className="icon-btn" onClick={onOrgSettings} title="Organization settings" aria-label="Organization settings">⚙</button>
        )}
      </div>

      <nav className="tenant-tabs" aria-label="Branches">
        {org?.tenants.map((t) => (
          <button
            key={t.id}
            className={`tenant-tab ${tenant?.id === t.id ? 'active' : ''}`}
            onClick={() => onSelectTenant(t.id)}
            aria-current={tenant?.id === t.id ? 'true' : undefined}
          >
            {t.name}
          </button>
        ))}
        {isOrgAdmin && <button className="tenant-tab tenant-add" onClick={onNewTenant} title="Add a branch">+ Branch</button>}
      </nav>

      <div className="header-user">
        {tenant && <span className="role-badge">{ROLE_LABELS[tenant.role]}</span>}
        <Avatar user={user} size={28} />
        <span className="user-name">{user.name}</span>
        <button className="btn btn-ghost" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}
