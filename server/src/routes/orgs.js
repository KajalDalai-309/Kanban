import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { authenticate, orgScope, requireOrgAdmin } from '../middleware.js';
import { listAccessibleOrgs } from '../services/access.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });
const emailSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export function orgRoutes(ctx) {
  const { db, hub } = ctx;
  const router = Router();
  router.use('/orgs', authenticate(ctx));

  router.get('/orgs', (req, res) => res.json({ orgs: listAccessibleOrgs(db, req.user.id) }));

  // Anyone signed in can create an organization and becomes its admin.
  router.post('/orgs', (req, res) => {
    const { name } = parse(nameSchema, req.body);
    const id = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run(id, name);
      db.prepare("INSERT INTO memberships (id, user_id, org_id, tenant_id, role) VALUES (?, ?, ?, NULL, 'org_admin')")
        .run(randomUUID(), req.user.id, id);
    })();
    res.status(201).json({ org: { id, name } });
  });

  const scoped = Router({ mergeParams: true });
  router.use('/orgs/:orgId', orgScope(ctx), scoped);

  scoped.get('/', (req, res) => {
    const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(req.org.id);
    res.json({ org: { ...org, role: req.org.role } });
  });

  scoped.patch('/', requireOrgAdmin, (req, res) => {
    const { name } = parse(nameSchema, req.body);
    db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, req.org.id);
    res.json({ org: { id: req.org.id, name } });
  });

  scoped.delete('/', requireOrgAdmin, (req, res) => {
    const tenantIds = db.prepare('SELECT id FROM tenants WHERE org_id = ?').all(req.org.id).map((t) => t.id);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(req.org.id);
    tenantIds.forEach((id) => hub.closeTenant(id));
    res.status(204).end();
  });

  // ----- Tenants (branches) -----
  scoped.get('/tenants', (req, res) => {
    const org = listAccessibleOrgs(db, req.user.id).find((o) => o.id === req.org.id);
    res.json({ tenants: org?.tenants ?? [] });
  });

  scoped.post('/tenants', requireOrgAdmin, (req, res) => {
    const { name } = parse(nameSchema, req.body);
    if (db.prepare('SELECT 1 FROM tenants WHERE org_id = ? AND name = ?').get(req.org.id, name)) {
      throw conflict('A tenant with this name already exists in the organization');
    }
    const id = randomUUID();
    db.prepare('INSERT INTO tenants (id, org_id, name) VALUES (?, ?, ?)').run(id, req.org.id, name);
    res.status(201).json({ tenant: { id, orgId: req.org.id, name, role: 'org_admin' } });
  });

  // ----- Organization admins (org-level memberships) -----
  scoped.get('/admins', requireOrgAdmin, (req, res) => {
    const admins = db
      .prepare(
        `SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.org_id = ? AND m.tenant_id IS NULL ORDER BY u.name`
      )
      .all(req.org.id);
    res.json({ admins });
  });

  scoped.post('/admins', requireOrgAdmin, (req, res) => {
    const { email } = parse(emailSchema, req.body);
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (!user) throw notFound('User');
    // Replace any tenant-level memberships with a single org-level one.
    db.transaction(() => {
      db.prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?').run(user.id, req.org.id);
      db.prepare("INSERT INTO memberships (id, user_id, org_id, tenant_id, role) VALUES (?, ?, ?, NULL, 'org_admin')")
        .run(randomUUID(), user.id, req.org.id);
    })();
    res.status(201).json({ admin: user });
  });

  scoped.delete('/admins/:userId', requireOrgAdmin, (req, res) => {
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND tenant_id IS NULL")
      .get(req.org.id).n;
    if (count <= 1) throw badRequest('An organization needs at least one admin');
    const result = db
      .prepare('DELETE FROM memberships WHERE org_id = ? AND tenant_id IS NULL AND user_id = ?')
      .run(req.org.id, req.params.userId);
    if (!result.changes) throw notFound('Admin');
    hub.revalidateUser(req.params.userId);
    res.status(204).end();
  });

  return router;
}
