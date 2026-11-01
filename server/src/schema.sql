-- Multi-organization, multi-tenant schema.
-- Hierarchy: organizations -> tenants (branches) -> boards -> columns -> tasks
--
-- Tenant isolation is enforced twice: every query filters on tenant_id, and the
-- composite foreign keys below make it impossible for a column to point at a
-- board of another tenant, or a task at a column of another tenant.

CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, name),
  UNIQUE (id, org_id)
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A membership is either org-level (tenant_id IS NULL, role = org_admin) or
-- tenant-level (tenant_id set, role = tenant_admin | member).
CREATE TABLE IF NOT EXISTS memberships (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id  TEXT,
  role       TEXT NOT NULL CHECK (role IN ('org_admin', 'tenant_admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (role = 'org_admin' AND tenant_id IS NULL) OR
    (role <> 'org_admin' AND tenant_id IS NOT NULL)
  ),
  -- the tenant must belong to the same org as the membership
  FOREIGN KEY (tenant_id, org_id) REFERENCES tenants(id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_org
  ON memberships(user_id, org_id) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_tenant
  ON memberships(user_id, tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_membership_tenant ON memberships(tenant_id);

CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_boards_tenant ON boards(tenant_id);

CREATE TABLE IF NOT EXISTS columns (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  board_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  position   REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (board_id, tenant_id) REFERENCES boards(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_columns_board ON columns(tenant_id, board_id, position);

-- position: fractional ordering (REAL). Moving a task only rewrites that one row.
-- version: bumped on every change, used for optimistic concurrency.
-- field_versions: JSON map field -> version at which that field last changed,
--                 which lets the server detect conflicts per field instead of per row.
-- deleted_at: soft delete so undo can restore a task.
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  board_id       TEXT NOT NULL,
  column_id      TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  assignee_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date       TEXT,
  position       REAL NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  field_versions TEXT NOT NULL DEFAULT '{}',
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  FOREIGN KEY (column_id, tenant_id) REFERENCES columns(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (board_id, tenant_id) REFERENCES boards(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_tasks_column
  ON tasks(tenant_id, column_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tasks_board ON tasks(tenant_id, board_id);

CREATE TABLE IF NOT EXISTS activity_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  board_id    TEXT,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  summary     TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_activity_tenant ON activity_logs(tenant_id, id DESC);
