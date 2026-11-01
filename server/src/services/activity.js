const toDto = (r) => ({
  id: r.id,
  tenantId: r.tenant_id,
  boardId: r.board_id,
  actorId: r.actor_id,
  actorName: r.actor_name,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  summary: r.summary,
  meta: JSON.parse(r.meta),
  createdAt: r.created_at,
});

// Always called inside the same transaction as the change it describes,
// so the log can never disagree with the data.
export function logActivity(
  db,
  { tenantId, boardId = null, actor, action, entityType, entityId = null, summary, meta = {} }
) {
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO activity_logs
         (tenant_id, board_id, actor_id, actor_name, action, entity_type, entity_id, summary, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(tenantId, boardId, actor.id, actor.name, action, entityType, entityId, summary, JSON.stringify(meta), createdAt);
  return toDto(db.prepare('SELECT * FROM activity_logs WHERE id = ?').get(info.lastInsertRowid));
}

export function listActivity(db, tenantId, { limit = 50, before } = {}) {
  const rows = before
    ? db
        .prepare('SELECT * FROM activity_logs WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(tenantId, before, limit)
    : db.prepare('SELECT * FROM activity_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, limit);
  return rows.map(toDto);
}
