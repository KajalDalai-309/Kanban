// Who can see what. Roles are always read from the database (never from the JWT),
// so removing a membership takes effect on the very next request.

const RANK = { member: 1, tenant_admin: 2, org_admin: 3 };

export const atLeast = (role, min) => (RANK[role] ?? 0) >= RANK[min];

// Returns { tenantId, orgId, name, role } or null.
// null covers both "tenant does not exist" and "you are not in it", so callers
// answer 404 for both and never reveal that a tenant exists.
export function getTenantAccess(db, userId, tenantId) {
  const row = db
    .prepare(
      `SELECT t.id, t.org_id AS orgId, t.name,
              om.id AS orgMembership, tm.role AS tenantRole
         FROM tenants t
         LEFT JOIN memberships om
                ON om.user_id = @u AND om.org_id = t.org_id AND om.tenant_id IS NULL
         LEFT JOIN memberships tm
                ON tm.user_id = @u AND tm.tenant_id = t.id
        WHERE t.id = @t`
    )
    .get({ u: userId, t: tenantId });
  if (!row) return null;
  const role = row.orgMembership ? 'org_admin' : row.tenantRole;
  return role ? { tenantId: row.id, orgId: row.orgId, name: row.name, role } : null;
}

// 'org_admin' | 'member' (belongs to at least one tenant of the org) | null
export function getOrgRole(db, userId, orgId) {
  const rows = db
    .prepare('SELECT tenant_id FROM memberships WHERE user_id = ? AND org_id = ?')
    .all(userId, orgId);
  if (rows.some((r) => r.tenant_id === null)) return 'org_admin';
  return rows.length ? 'member' : null;
}

export function listAccessibleOrgs(db, userId) {
  const memberships = db
    .prepare('SELECT org_id, tenant_id, role FROM memberships WHERE user_id = ?')
    .all(userId);
  const orgIds = [...new Set(memberships.map((m) => m.org_id))];

  return orgIds
    .map((orgId) => {
      const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId);
      const isAdmin = memberships.some((m) => m.org_id === orgId && m.tenant_id === null);
      const tenants = isAdmin
        ? db
            .prepare('SELECT id, name FROM tenants WHERE org_id = ? ORDER BY name')
            .all(orgId)
            .map((t) => ({ ...t, role: 'org_admin' }))
        : memberships
            .filter((m) => m.org_id === orgId)
            .map((m) => ({
              id: m.tenant_id,
              name: db.prepare('SELECT name FROM tenants WHERE id = ?').get(m.tenant_id).name,
              role: m.role,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
      return { id: org.id, name: org.name, role: isAdmin ? 'org_admin' : 'member', tenants };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Everyone who can open this tenant: its own members plus the org admins.
export function listTenantMembers(db, tenantId, orgId) {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ?
       UNION
       SELECT u.id, u.name, u.email, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND m.tenant_id IS NULL
        ORDER BY 2`
    )
    .all(tenantId, orgId);
  return rows.map((r) => ({ ...r, inherited: r.role === 'org_admin' }));
}

export function canAccessTenant(db, userId, tenantId) {
  return getTenantAccess(db, userId, tenantId) !== null;
}
