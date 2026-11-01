import { randomUUID } from 'node:crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { computePosition } from '../lib/ordering.js';
import { canAccessTenant } from './access.js';
import { logActivity } from './activity.js';

// API field name -> database column. Only these fields can be edited with PATCH.
const EDITABLE = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  assigneeId: 'assignee_id',
  dueDate: 'due_date',
};

export const toTask = (r) => ({
  id: r.id,
  tenantId: r.tenant_id,
  boardId: r.board_id,
  columnId: r.column_id,
  title: r.title,
  description: r.description,
  priority: r.priority,
  assigneeId: r.assignee_id,
  dueDate: r.due_date,
  position: r.position,
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();

function getLiveTask(db, tenantId, taskId) {
  const row = db
    .prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL')
    .get(taskId, tenantId);
  if (!row) throw notFound('Task');
  return row;
}

function liveSiblings(db, tenantId, columnId, excludeId = null) {
  return db
    .prepare(
      `SELECT id, position FROM tasks
        WHERE tenant_id = ? AND column_id = ? AND deleted_at IS NULL AND id <> ?
        ORDER BY position, created_at, id`
    )
    .all(tenantId, columnId, excludeId ?? '');
}

// An assignee must be someone who can actually open this tenant.
function assertAssignable(db, tenantId, userId) {
  if (userId && !canAccessTenant(db, userId, tenantId)) {
    throw badRequest('Assignee does not belong to this tenant');
  }
}

// Writes renumbered positions after a rebalance and returns them for broadcasting.
function persistRebalance(db, tenantId, columnId, rebalanced) {
  const update = db.prepare('UPDATE tasks SET position = ? WHERE id = ? AND tenant_id = ?');
  for (const s of rebalanced) update.run(s.position, s.id, tenantId);
  return { columnId, positions: rebalanced.map(({ id, position }) => ({ id, position })) };
}

export function getTask(db, tenantId, taskId) {
  return toTask(getLiveTask(db, tenantId, taskId));
}

export function createTask(db, { tenantId, columnId, actor, input }) {
  return db.transaction(() => {
    const column = db.prepare('SELECT * FROM columns WHERE id = ? AND tenant_id = ?').get(columnId, tenantId);
    if (!column) throw notFound('Column');
    assertAssignable(db, tenantId, input.assigneeId);

    // The client may pick the id so retries after a network failure are idempotent.
    const id = input.id ?? randomUUID();
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (existing) {
      if (existing.tenant_id !== tenantId) throw conflict('Task id is already in use');
      return { task: toTask(existing), activity: null, reordered: null, created: false };
    }

    const siblings = liveSiblings(db, tenantId, columnId);
    const { position, rebalanced } = computePosition(siblings, input);
    const reordered = rebalanced ? persistRebalance(db, tenantId, columnId, rebalanced) : null;

    const stamp = now();
    const fieldVersions = Object.fromEntries(Object.keys(EDITABLE).map((f) => [f, 1]));
    fieldVersions.column_id = 1;
    fieldVersions.position = 1;
    db.prepare(
      `INSERT INTO tasks (id, tenant_id, board_id, column_id, title, description, priority,
                          assignee_id, due_date, position, version, field_versions,
                          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).run(
      id, tenantId, column.board_id, columnId, input.title, input.description ?? '',
      input.priority ?? 'medium', input.assigneeId ?? null, input.dueDate ?? null, position,
      JSON.stringify(fieldVersions), actor.id, stamp, stamp
    );

    const task = toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    const activity = logActivity(db, {
      tenantId, boardId: task.boardId, actor, action: 'task.created', entityType: 'task', entityId: id,
      summary: `${actor.name} created "${task.title}" in ${column.name}`,
    });
    return { task, activity, reordered, created: true };
  })();
}

/**
 * Optimistic concurrency, per field.
 * The client sends the version it last saw (baseVersion) and only the fields it changed.
 * A field conflicts only if someone else changed that same field after baseVersion
 * AND to a different value. Anything else merges silently.
 * If any field conflicts nothing is applied and the caller gets a 409 with the current task.
 */
export function updateTask(db, { tenantId, taskId, actor, baseVersion, changes }) {
  return db.transaction(() => {
    const row = getLiveTask(db, tenantId, taskId);
    if (changes.assigneeId) assertAssignable(db, tenantId, changes.assigneeId);

    const fieldVersions = JSON.parse(row.field_versions);
    const real = Object.keys(changes).filter((f) => (row[EDITABLE[f]] ?? null) !== (changes[f] ?? null));
    const conflicts = real.filter((f) => (fieldVersions[f] ?? 0) > baseVersion);
    if (conflicts.length) {
      throw conflict('Task was changed by someone else', { conflicts, current: toTask(row) });
    }
    if (!real.length) return { task: toTask(row), activity: null, changed: false };

    const version = row.version + 1;
    for (const f of real) fieldVersions[f] = version;
    const setSql = real.map((f) => `${EDITABLE[f]} = ?`).join(', ');
    const result = db
      .prepare(
        `UPDATE tasks SET ${setSql}, version = ?, field_versions = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND version = ?`
      )
      .run(...real.map((f) => changes[f] ?? null), version, JSON.stringify(fieldVersions), now(), taskId, tenantId, row.version);
    if (result.changes !== 1) throw conflict('Task was changed by someone else', { conflicts: real });

    const task = toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    const activity = logActivity(db, {
      tenantId, boardId: task.boardId, actor, action: 'task.updated', entityType: 'task', entityId: taskId,
      summary: `${actor.name} updated ${real.join(', ')} on "${task.title}"`,
      meta: { fields: real },
    });
    return { task, activity, changed: true };
  })();
}

/**
 * Moves a task to a column, between two neighbours.
 * The position is worked out here, against the data as it is right now, from the
 * neighbour ids the user dropped between. If two users drag at once, both drops
 * apply and each lands next to the neighbour it was aimed at.
 */
export function moveTask(db, { tenantId, taskId, actor, columnId, afterId = null, beforeId = null }) {
  return db.transaction(() => {
    const row = getLiveTask(db, tenantId, taskId);
    const target = db.prepare('SELECT * FROM columns WHERE id = ? AND tenant_id = ?').get(columnId, tenantId);
    if (!target) throw notFound('Column');
    if (target.board_id !== row.board_id) throw badRequest('A task can only move within its board');

    const siblings = liveSiblings(db, tenantId, columnId, taskId);
    const { position, rebalanced } = computePosition(siblings, { afterId, beforeId });
    const reordered = rebalanced ? persistRebalance(db, tenantId, columnId, rebalanced) : null;

    const fromColumnId = row.column_id;
    if (fromColumnId === columnId && position === row.position) {
      return { task: toTask(row), activity: null, reordered, changed: false };
    }

    const version = row.version + 1;
    const fieldVersions = JSON.parse(row.field_versions);
    fieldVersions.column_id = version;
    fieldVersions.position = version;
    db.prepare(
      `UPDATE tasks SET column_id = ?, position = ?, version = ?, field_versions = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`
    ).run(columnId, position, version, JSON.stringify(fieldVersions), now(), taskId, tenantId);

    const task = toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));

    // Reordering inside one column is not logged; it would drown out real events.
    let activity = null;
    if (fromColumnId !== columnId) {
      const from = db.prepare('SELECT name FROM columns WHERE id = ?').get(fromColumnId);
      activity = logActivity(db, {
        tenantId, boardId: task.boardId, actor, action: 'task.moved', entityType: 'task', entityId: taskId,
        summary: `${actor.name} moved "${task.title}" from ${from?.name ?? 'a column'} to ${target.name}`,
        meta: { fromColumnId, toColumnId: columnId },
      });
    }
    return { task, activity, reordered, changed: true };
  })();
}

function assertCanRemove(row, actor, canManageAll) {
  if (!canManageAll && row.created_by !== actor.id) {
    throw forbidden('Members can only delete tasks they created');
  }
}

export function deleteTask(db, { tenantId, taskId, actor, canManageAll }) {
  return db.transaction(() => {
    const row = getLiveTask(db, tenantId, taskId);
    assertCanRemove(row, actor, canManageAll);
    const version = row.version + 1;
    db.prepare('UPDATE tasks SET deleted_at = ?, version = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(now(), version, now(), taskId, tenantId);
    const activity = logActivity(db, {
      tenantId, boardId: row.board_id, actor, action: 'task.deleted', entityType: 'task', entityId: taskId,
      summary: `${actor.name} deleted "${row.title}"`,
    });
    return { taskId, boardId: row.board_id, version, activity };
  })();
}

export function restoreTask(db, { tenantId, taskId, actor, canManageAll }) {
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL')
      .get(taskId, tenantId);
    if (!row) throw notFound('Task');
    assertCanRemove(row, actor, canManageAll);
    db.prepare('UPDATE tasks SET deleted_at = NULL, version = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(row.version + 1, now(), taskId, tenantId);
    const task = toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    const activity = logActivity(db, {
      tenantId, boardId: task.boardId, actor, action: 'task.restored', entityType: 'task', entityId: taskId,
      summary: `${actor.name} restored "${task.title}"`,
    });
    return { task, activity };
  })();
}
