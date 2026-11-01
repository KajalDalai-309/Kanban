import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { atLeast } from '../services/access.js';
import * as tasks from '../services/tasks.js';

const title = z.string().trim().min(1).max(200);
const fields = {
  description: z.string().max(5000),
  priority: z.enum(['low', 'medium', 'high']),
  assigneeId: z.string().nullable(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').nullable(),
};
const anchors = {
  afterId: z.string().nullable().optional(),
  beforeId: z.string().nullable().optional(),
};

const createSchema = z.object({
  id: z.uuid().optional(),
  title,
  description: fields.description.optional(),
  priority: fields.priority.optional(),
  assigneeId: fields.assigneeId.optional(),
  dueDate: fields.dueDate.optional(),
  ...anchors,
});

const updateSchema = z.object({
  baseVersion: z.number().int().min(0),
  changes: z
    .object({ title, ...fields })
    .partial()
    .strict()
    .refine((c) => Object.keys(c).length > 0, { message: 'no changes given' }),
});

const moveSchema = z.object({ columnId: z.string(), ...anchors });

// Mounted at /api/tenants/:tenantId, after authenticate + tenantScope.
// Every service call receives the tenant id from the URL scope, never from the body.
export function taskRoutes(ctx) {
  const { db, hub } = ctx;
  const router = Router({ mergeParams: true });
  const actorOf = (req) => ({ id: req.user.id, name: req.user.name });
  const canManageAll = (req) => atLeast(req.tenant.role, 'tenant_admin');

  router.post('/columns/:columnId/tasks', (req, res) => {
    const input = parse(createSchema, req.body);
    const actor = actorOf(req);
    const result = tasks.createTask(db, {
      tenantId: req.tenant.tenantId, columnId: req.params.columnId, actor, input,
    });
    if (result.created) {
      if (result.reordered) hub.publish(req.tenant.tenantId, 'positions.changed', result.reordered);
      hub.publish(req.tenant.tenantId, 'task.created', { task: result.task }, { actor, activity: result.activity });
    }
    res.status(result.created ? 201 : 200).json({ task: result.task });
  });

  router.get('/tasks/:taskId', (req, res) => {
    res.json({ task: tasks.getTask(db, req.tenant.tenantId, req.params.taskId) });
  });

  router.patch('/tasks/:taskId', (req, res) => {
    const { baseVersion, changes } = parse(updateSchema, req.body);
    const actor = actorOf(req);
    const result = tasks.updateTask(db, {
      tenantId: req.tenant.tenantId, taskId: req.params.taskId, actor, baseVersion, changes,
    });
    if (result.changed) {
      hub.publish(req.tenant.tenantId, 'task.updated', { task: result.task }, { actor, activity: result.activity });
    }
    res.json({ task: result.task });
  });

  router.post('/tasks/:taskId/move', (req, res) => {
    const input = parse(moveSchema, req.body);
    const actor = actorOf(req);
    const result = tasks.moveTask(db, {
      tenantId: req.tenant.tenantId, taskId: req.params.taskId, actor, ...input,
    });
    if (result.reordered) hub.publish(req.tenant.tenantId, 'positions.changed', result.reordered);
    if (result.changed) {
      hub.publish(req.tenant.tenantId, 'task.moved', { task: result.task }, { actor, activity: result.activity });
    }
    res.json({ task: result.task });
  });

  router.delete('/tasks/:taskId', (req, res) => {
    const actor = actorOf(req);
    const result = tasks.deleteTask(db, {
      tenantId: req.tenant.tenantId, taskId: req.params.taskId, actor, canManageAll: canManageAll(req),
    });
    hub.publish(
      req.tenant.tenantId, 'task.deleted',
      { taskId: result.taskId, boardId: result.boardId, version: result.version },
      { actor, activity: result.activity }
    );
    res.status(204).end();
  });

  router.post('/tasks/:taskId/restore', (req, res) => {
    const actor = actorOf(req);
    const result = tasks.restoreTask(db, {
      tenantId: req.tenant.tenantId, taskId: req.params.taskId, actor, canManageAll: canManageAll(req),
    });
    hub.publish(req.tenant.tenantId, 'task.restored', { task: result.task }, { actor, activity: result.activity });
    res.json({ task: result.task });
  });

  return router;
}
