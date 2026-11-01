# API

All routes are JSON under `/api`. Send `Authorization: Bearer <token>` everywhere except register/login.
Errors look like `{ "error": { "code", "message", ... } }`.

Tenant routes live under `/api/tenants/:tenantId`. Someone who is not a member of the tenant gets **404**, the same as for a tenant that does not exist.

## Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{name, email, password>=8}` -> `{token, user}` |
| POST | `/auth/login` | `{email, password}` -> `{token, user}` |
| GET | `/me` | user plus every org and tenant they can open, with role |

## Organizations (org admin unless noted)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/orgs` | list mine / create (creator becomes org admin) |
| GET | `/orgs/:orgId` | any org member |
| PATCH/DELETE | `/orgs/:orgId` | rename / delete |
| GET/POST | `/orgs/:orgId/tenants` | list (any member, only tenants you can open) / create (admin) |
| GET/POST/DELETE | `/orgs/:orgId/admins[/:userId]` | manage org admins |

## Tenant
| Method | Path | Role |
|---|---|---|
| GET | `/tenants/:id` | member |
| PATCH/DELETE | `/tenants/:id` | org admin |
| GET | `/tenants/:id/members` | member |
| POST/PATCH/DELETE | `/tenants/:id/members[/:userId]` | tenant admin |
| GET | `/tenants/:id/activity?limit&before` | member |

## Boards and columns (read: member, write: tenant admin)
`GET/POST /boards`, `GET/PATCH/DELETE /boards/:id`, `POST /boards/:id/columns`, `PATCH/DELETE /columns/:id`.
Ordering uses neighbours: `{afterId, beforeId}`.

## Tasks (any member)
| Method | Path | Notes |
|---|---|---|
| POST | `/columns/:columnId/tasks` | optional client `id` (idempotent), `{afterId, beforeId}` |
| GET | `/tasks/:id` | |
| PATCH | `/tasks/:id` | `{baseVersion, changes:{...}}`. **409** with `{conflicts, current}` if a changed field was also changed by someone else |
| POST | `/tasks/:id/move` | `{columnId, afterId, beforeId}` |
| DELETE | `/tasks/:id` | soft delete. Members: own tasks only. Admins: any |
| POST | `/tasks/:id/restore` | undo of a delete |

## WebSocket `/ws`
1. Client connects and within 5 seconds sends `{type:"join", token, tenantId}`.
2. Server checks token and membership, replies `{type:"joined", presence}`, or closes with 4401 (bad token) / 4403 (no access).
3. Server pushes `{type:"event", tenantId, name, data, actor, activity}`; names: `task.created|updated|moved|deleted|restored`, `positions.changed`, `columns.changed`, `column.deleted`, `board.created|updated|deleted`, `members.changed`.
4. `{type:"presence", users}` on every join or leave. `{type:"kicked"}` then close 4403 when access is revoked.
5. Client may send `{type:"ping"}`; sending `join` again moves the socket to another tenant.
