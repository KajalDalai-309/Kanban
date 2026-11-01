import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { requireTenantRole } from '../middleware.js';
import * as boards from '../services/boards.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });
const createBoardSchema = z.object({
  name: z.string().trim().min(1).max(80),
  columns: z.array(z.string().trim().min(1).max(80)).max(20).default(['To Do', 'In Progress', 'Done']),
});
const anchors = {
  afterId: z.string().nullable().optional(),
  beforeId: z.string().nullable().optional(),
};
const createColumnSchema = z.object({ name: z.string().trim().min(1).max(80), ...anchors });
const updateColumnSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), ...anchors })
  .refine((v) => v.name !== undefined || v.afterId !== undefined || v.beforeId !== undefined, {
    message: 'nothing to update',
  });

// Boards and columns. Reading is open to every member; changing the structure needs tenant_admin.
export function boardRoutes(ctx) {
  const { db, hub } = ctx;
  const router = Router({ mergeParams: true });
  const admin = requireTenantRole('tenant_admin');
  const actorOf = (req) => ({ id: req.user.id, name: req.user.name });

  router.get('/boards', (req, res) => res.json({ boards: boards.listBoards(db, req.tenant.tenantId) }));

  router.post('/boards', admin, (req, res) => {
    const { name, columns } = parse(createBoardSchema, req.body);
    const actor = actorOf(req);
    const { board, activity } = boards.createBoard(db, { tenantId: req.tenant.tenantId, actor, name, columns });
    hub.publish(req.tenant.tenantId, 'board.created', { board }, { actor, activity });
    res.status(201).json({ board });
  });

  router.get('/boards/:boardId', (req, res) => {
    res.json(boards.getBoardSnapshot(db, req.tenant.tenantId, req.params.boardId));
  });

  router.patch('/boards/:boardId', admin, (req, res) => {
    const { name } = parse(nameSchema, req.body);
    const actor = actorOf(req);
    const { board, activity } = boards.renameBoard(db, {
      tenantId: req.tenant.tenantId, boardId: req.params.boardId, actor, name,
    });
    hub.publish(req.tenant.tenantId, 'board.updated', { board }, { actor, activity });
    res.json({ board });
  });

  router.delete('/boards/:boardId', admin, (req, res) => {
    const actor = actorOf(req);
    const { boardId, activity } = boards.deleteBoard(db, { tenantId: req.tenant.tenantId, boardId: req.params.boardId, actor });
    hub.publish(req.tenant.tenantId, 'board.deleted', { boardId }, { actor, activity });
    res.status(204).end();
  });

  router.post('/boards/:boardId/columns', admin, (req, res) => {
    const input = parse(createColumnSchema, req.body);
    const actor = actorOf(req);
    const { column, columns, activity } = boards.createColumn(db, {
      tenantId: req.tenant.tenantId, boardId: req.params.boardId, actor, ...input,
    });
    hub.publish(req.tenant.tenantId, 'columns.changed', { boardId: req.params.boardId, columns }, { actor, activity });
    res.status(201).json({ column, columns });
  });

  router.patch('/columns/:columnId', admin, (req, res) => {
    const input = parse(updateColumnSchema, req.body);
    const actor = actorOf(req);
    const { column, columns, activity } = boards.updateColumn(db, {
      tenantId: req.tenant.tenantId, columnId: req.params.columnId, actor, ...input,
    });
    hub.publish(req.tenant.tenantId, 'columns.changed', { boardId: column.boardId, columns }, { actor, activity });
    res.json({ column, columns });
  });

  router.delete('/columns/:columnId', admin, (req, res) => {
    const actor = actorOf(req);
    const { columnId, boardId, activity } = boards.deleteColumn(db, {
      tenantId: req.tenant.tenantId, columnId: req.params.columnId, actor,
    });
    hub.publish(req.tenant.tenantId, 'column.deleted', { boardId, columnId }, { actor, activity });
    res.status(204).end();
  });

  return router;
}
