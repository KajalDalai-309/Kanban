# Kanban Teams

A real-time collaborative Kanban board for organizations with multiple branches (tenants).
Built for the Julley Online FDE Intern assignment with React, Node.js (Express), WebSockets and SQLite.

Example from the brief: **ABC Technologies** has Hyderabad, Bangalore and Chennai branches, each with its own board. A Hyderabad user never sees Bangalore data.

## Features

- Organizations -> tenants (branches) -> boards -> columns -> tasks
- Roles: **org admin** (all branches), **tenant admin** (manage one branch), **member** (work on tasks)
- Strict tenant isolation: scoped routes, composite foreign keys, per-tenant WebSocket channels
- Real-time sync: create, edit, move, delete, columns, members, activity, presence
- Drag and drop with optimistic UI and rollback
- Conflict handling per field (different fields merge, same field asks the user to choose)
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z), also synced to other users
- Offline handling: reconnect with backoff, queued changes, full resync on reconnect
- Activity log per branch, task assignment, priority, due date
- Switching between organizations and branches without a reload

## Run it

Requires **Node 22.13 or newer** (uses the built-in `node:sqlite`, so no C++ build tools are needed). Check with `node -v`.

```bash
npm run install:all
npm run seed        # demo data, creates server/data/kanban.db
npm run dev         # API + WebSocket on :4000, React on http://localhost:5173
```

Production style (one process): `npm run build && npm start`, then open http://localhost:4000.

Demo accounts (password `password123`): `priya@abc.com` (org admin), `ravi@abc.com` (Hyderabad admin),
`anita@abc.com` (member of Hyderabad and Bangalore), `arjun@xyz.com` (admin of a different org).
Open two browsers with different users on the same branch to see live updates.

## Environment variables (all optional in development)

| Name | Default | Purpose |
|---|---|---|
| `PORT` | 4000 | server port |
| `JWT_SECRET` | dev value | **required** when `NODE_ENV=production` |
| `DB_PATH` | `data/kanban.db` | SQLite file |

## Tests

```bash
npm test     # 42 server tests (REST, isolation, RBAC, concurrency, WebSocket) + 11 client tests
```

## Structure

```
server/src  schema.sql  db.js  app.js  middleware.js  seed.js
            routes/ (auth, orgs, tenants, boards, tasks)
            services/ (access, tasks, boards, activity)   <- business rules
            realtime/hub.js                               <- WebSocket channels, presence
            lib/ (ordering, tokens, errors, validate)
client/src  App.jsx  state/ (useWorkspace, boardReducer, history)
            components/ (BoardView, TaskPanel, Sidebar, Header, ...)  lib/ (api, socket, ordering)
docs/       API.md  ER.md  INTERVIEW.md
```

## Design decisions

- **Isolation:** every tenant route passes through `tenantScope`, which reads the caller's role from the database. Non-members get 404. Services always filter by the tenant from the URL, never from the body. Composite foreign keys stop cross-tenant references even if application code is wrong.
- **Ordering:** fractional positions, so a move rewrites one row. The server computes the position from the neighbours the user dropped between, so two simultaneous drops both land.
- **Conflicts:** each task has a version and a per-field version. See `docs/INTERVIEW.md`.
- **Real time:** the server publishes after the database commit. Clients ignore events whose version they already have, so their own echo is harmless.

## Limitations

- Single server instance: WebSocket channels are in memory. To scale out, publish through Redis pub/sub.
- Users must register themselves first, then an admin adds them by email (no email invitations).
- Undo of an edit fails if someone else changed the same field since (by design).
- Offline queue lives in memory, so it is lost if the tab is closed while offline.
- JWT is kept in localStorage for simplicity; httpOnly cookies would be safer in production.
- Not tested in Safari or on touch devices (HTML5 drag and drop does not work on most touch browsers; the task panel has a column selector as the alternative).
