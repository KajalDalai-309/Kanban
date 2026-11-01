import { useState } from 'react';
import { ROLE_LABELS, timeAgo } from '../lib/format.js';
import Avatar from './Avatar.jsx';

export function PresenceBar({ presence, connection, pending }) {
  const label = {
    connecting: 'Connecting…',
    online: 'Live',
    reconnecting: 'Reconnecting…',
    closed: 'Disconnected',
  }[connection];

  return (
    <div className="presence">
      <span className={`status status-${connection}`} role="status">
        <i className="dot" />{label}
        {pending > 0 && <em> · {pending} change{pending > 1 ? 's' : ''} waiting to sync</em>}
      </span>
      <div className="avatars" aria-label={`${presence.length} online`}>
        {presence.slice(0, 6).map((u) => <Avatar key={u.id} user={u} color={u.color} size={26} ring />)}
        {presence.length > 6 && <span className="avatar avatar-more">+{presence.length - 6}</span>}
      </div>
    </div>
  );
}

export function ActivityFeed({ items, done, onLoadMore }) {
  if (items.length === 0) return <p className="muted pad">No activity yet.</p>;
  return (
    <ul className="feed">
      {items.map((a) => (
        <li key={a.id}>
          <div>{a.summary}</div>
          <time className="muted small" dateTime={a.createdAt}>{timeAgo(a.createdAt)}</time>
        </li>
      ))}
      {!done && <li><button className="link-btn" onClick={onLoadMore}>Load older activity</button></li>}
    </ul>
  );
}

export function MembersPanel({ members, presence, canManage, currentUserId, onAdd, onRole, onRemove }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const online = new Set(presence.map((p) => p.id));

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    const ok = await onAdd(email.trim(), role);
    setBusy(false);
    if (ok) setEmail('');
  }

  return (
    <div className="members">
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.id}>
            <Avatar user={m} size={28} />
            <div className="member-info">
              <div>{m.name}{m.id === currentUserId && <span className="muted"> (you)</span>} {online.has(m.id) && <i className="dot dot-online" title="Online" />}</div>
              <div className="muted small">{m.email}</div>
            </div>
            {canManage && !m.inherited ? (
              <div className="member-actions">
                <select value={m.role} onChange={(e) => onRole(m.id, e.target.value)} aria-label={`Role of ${m.name}`}>
                  <option value="member">Member</option><option value="tenant_admin">Branch admin</option>
                </select>
                <button className="icon-btn" onClick={() => onRemove(m.id)} aria-label={`Remove ${m.name}`}>✕</button>
              </div>
            ) : (
              <span className="role-badge">{ROLE_LABELS[m.role]}</span>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <form className="add-member" onSubmit={add}>
          <div className="muted small">Add an existing user to this branch</div>
          <input type="email" placeholder="email@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <div className="row">
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="member">Member</option><option value="tenant_admin">Branch admin</option>
            </select>
            <button className="btn btn-primary btn-sm" disabled={busy}>Add</button>
          </div>
        </form>
      )}
    </div>
  );
}
