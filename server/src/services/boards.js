import { randomUUID } from 'node:crypto';
import { conflict, notFound } from '../lib/errors.js';
import { computePosition, GAP } from '../lib/ordering.js';
import { logActivity } from './activity.js';
import { toTask } from './tasks.js';

const toBoard = (r) => ({ id: r.id, tenantId: r.tenant_id, name: r.name, createdAt: r.created_at });
const toColumn = (r) => ({
  id: r.id,
  tenantId: r.tenant_id,
  boardId: r.board_id,
  name: r.name,
  position: r.position,
});

function getBoardRow(db, tenantId, boardId) {
  const row = db.prepare('SELECT * FROM boards WHERE id = ? AND tenant_id = ?').get(boardId, tenantId);
  if (!row) throw notFound('Board');
  return row;
}

function getColumnRow(db, tenantId, columnId) {
  const row = db.prepare('SELECT * FROM columns WHERE id = ? AND tenant_id = ?').get(columnId, tenantId);
  if (!row) throw notFound('Column');
  return row;
}

export function listBoards(db, tenantId) {
  return db.prepare('SELECT * FROM boards WHERE tenant_id = ? ORDER BY created_at, id').all(tenantId).map(toBoard);
}

export function getBoardSnapshot(db, tenantId, boardId) {
  const board = toBoard(getBoardRow(db, tenantId, boardId));
  const columns = db
    .prepare('SELECT * FROM columns WHERE tenant_id = ? AND board_id = ? ORDER BY position, id')
    .all(tenantId, boardId)
    .map(toColumn);
  const tasks = db
    .prepare(
      `SELECT * FROM tasks WHERE tenant_id = ? AND board_id = ? AND deleted_at IS NULL
        ORDER BY position, created_at, id`
    )
    .all(tenantId, boardId)
    .map(toTask);
  return { board, columns, tasks };
}

export function createBoard(db, { tenantId, actor, name, columns }) {
  return db.transaction(() => {
    const id = randomUUID();
    db.prepare('INSERT INTO boards (id, tenant_id, name, created_by) VALUES (?, ?, ?, ?)').run(id, tenantId, name, actor.id);
    const insert = db.prepare('INSERT INTO columns (id, tenant_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)');
    columns.forEach((colName, i) => insert.run(randomUUID(), tenantId, id, colName, (i + 1) * GAP));
    const activity = logActivity(db, {
      tenantId, boardId: id, actor, action: 'board.created', entityType: 'board', entityId: id,
      summary: `${actor.name} created board "${name}"`,
    });
    return { board: toBoard(getBoardRow(db, tenantId, id)), activity };
  })();
}

export function renameBoard(db, { tenantId, boardId, actor, name }) {
  return db.transaction(() => {
    getBoardRow(db, tenantId, boardId);
    db.prepare('UPDATE boards SET name = ? WHERE id = ? AND tenant_id = ?').run(name, boardId, tenantId);
    const activity = logActivity(db, {
      tenantId, boardId, actor, action: 'board.updated', entityType: 'board', entityId: boardId,
      summary: `${actor.name} renamed a board to "${name}"`,
    });
    return { board: toBoard(getBoardRow(db, tenantId, boardId)), activity };
  })();
}

export function deleteBoard(db, { tenantId, boardId, actor }) {
  return db.transaction(() => {
    const board = getBoardRow(db, tenantId, boardId);
    db.prepare('DELETE FROM boards WHERE id = ? AND tenant_id = ?').run(boardId, tenantId);
    const activity = logActivity(db, {
      tenantId, actor, action: 'board.deleted', entityType: 'board', entityId: boardId,
      summary: `${actor.name} deleted board "${board.name}"`,
    });
    return { boardId, activity };
  })();
}

export function createColumn(db, { tenantId, boardId, actor, name, afterId, beforeId }) {
  return db.transaction(() => {
    const board = getBoardRow(db, tenantId, boardId);
    const siblings = db
      .prepare('SELECT id, position FROM columns WHERE tenant_id = ? AND board_id = ? ORDER BY position, id')
      .all(tenantId, boardId);
    const { position, rebalanced } = computePosition(siblings, { afterId, beforeId });
    if (rebalanced) rebalanceColumns(db, tenantId, rebalanced);
    const id = randomUUID();
    db.prepare('INSERT INTO columns (id, tenant_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)').run(
      id, tenantId, boardId, name, position
    );
    const activity = logActivity(db, {
      tenantId, boardId, actor, action: 'column.created', entityType: 'column', entityId: id,
      summary: `${actor.name} added column "${name}" to ${board.name}`,
    });
    return { column: toColumn(getColumnRow(db, tenantId, id)), columns: columnsOf(db, tenantId, boardId), activity };
  })();
}

export function updateColumn(db, { tenantId, columnId, actor, name, afterId, beforeId }) {
  return db.transaction(() => {
    const column = getColumnRow(db, tenantId, columnId);
    if (name !== undefined) {
      db.prepare('UPDATE columns SET name = ? WHERE id = ? AND tenant_id = ?').run(name, columnId, tenantId);
    }
    if (afterId !== undefined || beforeId !== undefined) {
      const siblings = db
        .prepare('SELECT id, position FROM columns WHERE tenant_id = ? AND board_id = ? AND id <> ? ORDER BY position, id')
        .all(tenantId, column.board_id, columnId);
      const { position, rebalanced } = computePosition(siblings, { afterId, beforeId });
      if (rebalanced) rebalanceColumns(db, tenantId, rebalanced);
      db.prepare('UPDATE columns SET position = ? WHERE id = ? AND tenant_id = ?').run(position, columnId, tenantId);
    }
    const activity = logActivity(db, {
      tenantId, boardId: column.board_id, actor, action: 'column.updated', entityType: 'column', entityId: columnId,
      summary: `${actor.name} ${name !== undefined ? `renamed column "${column.name}" to "${name}"` : `reordered column "${column.name}"`}`,
    });
    return { column: toColumn(getColumnRow(db, tenantId, columnId)), columns: columnsOf(db, tenantId, column.board_id), activity };
  })();
}

export function deleteColumn(db, { tenantId, columnId, actor }) {
  return db.transaction(() => {
    const column = getColumnRow(db, tenantId, columnId);
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE tenant_id = ? AND column_id = ? AND deleted_at IS NULL')
      .get(tenantId, columnId);
    if (n > 0) throw conflict('Move or delete the tasks in this column first');
    db.prepare('DELETE FROM columns WHERE id = ? AND tenant_id = ?').run(columnId, tenantId);
    const activity = logActivity(db, {
      tenantId, boardId: column.board_id, actor, action: 'column.deleted', entityType: 'column', entityId: columnId,
      summary: `${actor.name} deleted column "${column.name}"`,
    });
    return { columnId, boardId: column.board_id, activity };
  })();
}

function columnsOf(db, tenantId, boardId) {
  return db
    .prepare('SELECT * FROM columns WHERE tenant_id = ? AND board_id = ? ORDER BY position, id')
    .all(tenantId, boardId)
    .map(toColumn);
}

function rebalanceColumns(db, tenantId, rebalanced) {
  const update = db.prepare('UPDATE columns SET position = ? WHERE id = ? AND tenant_id = ?');
  for (const s of rebalanced) update.run(s.position, s.id, tenantId);
}
