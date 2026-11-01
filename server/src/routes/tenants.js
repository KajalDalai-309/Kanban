import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { requireTenantRole } from '../middleware.js';
import { listTenantMembers } from '../services/access.js';
import { listActivity } from '../services/activity.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });
const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['member', 'tenant_admin']).default('member'),
});
const roleSchema = z.object({ role: z.enum(['member', 'tenant_admin']) });
const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});

// Mounted at /api/tenants/:tenantId, after authenticate + tenantScope.
export function tenantRoutes(ctx) {
  const { db, hub } = ctx;
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const { tenantId, orgId, name, role } = req.tenant;
    res.json({ tenant: { id: tenantId, orgId, name, role } });
  });

  router.patch('/', (req, res) => {
    if (req.tenant.role !== 'org_admin') throw forbidden('Organization admins only');
    const { name } = parse(nameSchema, req.body);
    const taken = db
      .prepare('SELECT 1 FROM tenants WHERE org_id = ? AND name = ? AND id <> ?')
      .get(req.tenant.orgId, name, req.tenant.tenantId);
    if (taken) throw conflict('A tenant with this name already exists in the organization');
    db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(name, req.tenant.tenantId);
    res.json({ tenant: { id: req.tenant.tenantId, orgId: req.tenant.orgId, name } });
  });

  router.delete('/', (req, res) => {
    if (req.tenant.role !== 'org_admin') throw forbidden('Organization admins only');
    db.prepare('DELETE FROM tenants WHERE id = ?').run(req.tenant.tenantId);
    hub.closeTenant(req.tenant.tenantId);
    res.status(204).end();
  });

  // ----- Members -----
  router.get('/members', (req, res) => {
    res.json({ members: listTenantMembers(db, req.tenant.tenantId, req.tenant.orgId) });
  });

  router.post('/members', requireTenantRole('tenant_admin'), (req, res) => {
    const { email, role } = parse(addMemberSchema, req.body);
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (!user) throw notFound('User');
    const { tenantId, orgId } = req.tenant;

    const isOrgAdmin = db
      .prepare('SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ? AND tenant_id IS NULL')
      .get(user.id, orgId);
    if (isOrgAdmin) throw conflict('This user is an organization admin and already has access');
    if (db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND tenant_id = ?').get(user.id, tenantId)) {
      throw conflict('This user is already a member of the tenant');
    }

    db.prepare('INSERT INTO memberships (id, user_id, org_id, tenant_id, role) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), user.id, orgId, tenantId, role);
    hub.publish(tenantId, 'members.changed', {});
    res.status(201).json({ member: { ...user, role, inherited: false } });
  });

  router.patch('/members/:userId', requireTenantRole('tenant_admin'), (req, res) => {
    const { role } = parse(roleSchema, req.body);
    const result = db
      .prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND tenant_id = ?')
      .run(role, req.params.userId, req.tenant.tenantId);
    if (!result.changes) throw notFound('Member');
    hub.publish(req.tenant.tenantId, 'members.changed', {});
    res.json({ ok: true });
  });

  router.delete('/members/:userId', requireTenantRole('tenant_admin'), (req, res) => {
    const result = db
      .prepare('DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?')
      .run(req.params.userId, req.tenant.tenantId);
    if (!result.changes) {
      throw badRequest('Not a direct member of this tenant (organization admins cannot be removed here)');
    }
    // Drop their live sockets right away so they stop receiving events.
    hub.revalidateUser(req.params.userId);
    hub.publish(req.tenant.tenantId, 'members.changed', {});
    res.status(204).end();
  });

  // ----- Activity log -----
  router.get('/activity', (req, res) => {
    const { limit, before } = parse(activityQuery, req.query);
    res.json({ activity: listActivity(db, req.tenant.tenantId, { limit, before }) });
  });

  return router;
}
