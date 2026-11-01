export const initials = (name = '?') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

// Same hash as the server uses for presence, so a person has one colour everywhere.
export function colorFor(id = '') {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 45%)`;
}

export function timeAgo(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// dueDate is a plain YYYY-MM-DD string; compare as local dates to avoid timezone surprises.
export function dueInfo(dueDate) {
  if (!dueDate) return null;
  const [y, m, d] = dueDate.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  const label = due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return { label, overdue: days < 0, soon: days >= 0 && days <= 2 };
}

export const ROLE_LABELS = { org_admin: 'Org admin', tenant_admin: 'Branch admin', member: 'Member' };
export const atLeastAdmin = (role) => role === 'org_admin' || role === 'tenant_admin';
