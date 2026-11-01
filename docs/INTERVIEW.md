# Interview preparation

Know these answers in your own words. Open the file named in brackets and be ready to walk through it.

## Core decisions

**How do you guarantee tenant isolation?** Three layers. (1) `tenantScope` middleware resolves the caller's membership for the tenant in the URL and returns 404 otherwise [middleware.js]. (2) Every service query filters by `tenant_id` taken from that scope, so passing a task id from another tenant finds nothing [services/tasks.js]. (3) Composite foreign keys make cross-tenant rows impossible at the database level [schema.sql]. The WebSocket repeats the check on join and only broadcasts to the tenant's own channel [realtime/hub.js]. The tests try all of these from an outsider's side [test/api.test.js].

**Why 404 and not 403 for a tenant you are not in?** So the API does not reveal that the tenant exists.

**Why are roles read from the database and not stored in the JWT?** Removing a member must work immediately. A token-embedded role would stay valid until expiry.

**How do you handle two people editing the same task?** Each task has `version` and `field_versions` (the version at which each field last changed). The client sends `baseVersion` and only the fields it changed. The server rejects a field only if someone else changed that same field after `baseVersion` to a different value (409 with the current task). Different fields merge. The UI then shows "Theirs vs Mine" per field [services/tasks.js `updateTask`, components/TaskPanel.jsx]. Trade-off: more logic than last-write-wins, but nobody silently loses edits.

**How does drag and drop stay consistent when two users drag at once?** The client sends the neighbours it dropped between (`afterId`, `beforeId`), not an absolute position. The server computes the position at that moment inside a transaction, and SQLite serializes writes. Both drops land. If a neighbour was deleted, it falls back to the other one, then to the end [lib/ordering.js].

**Why fractional positions?** Moving a card updates one row. Midpoints run out of precision after many insertions in the same gap, so when neighbours get closer than 1e-6 the column is renumbered and the new positions are broadcast (`positions.changed`). Tested with 40 repeated drops.

**What is optimistic UI here?** Local state changes first, then the request. On success the server's task replaces the local one. On an error the snapshot is rolled back, unless a newer version arrived meanwhile. A network error keeps the change and queues it for retry [state/useWorkspace.js `perform`].

**Why does your own WebSocket echo not cause flicker?** The reducer ignores a task whose version is not newer than the stored one [state/boardReducer.js]. Deleted tasks leave a tombstone version so late events cannot revive them.

**How does reconnect work?** Exponential backoff, a ping every 20s to detect half-open connections, and on every (re)connect the client flushes queued changes and reloads the board, so events missed while offline are recovered [lib/socket.js].

**How does undo work with several users?** Undo calls the server, like any other change, so everyone sees it and it is logged. Edit undo sends the previous values with the last known version, so it is refused if someone else touched those fields. Delete is a soft delete so it can be restored.

**What would you change to scale to many servers?** Move channel broadcast to Redis pub/sub, replace SQLite with PostgreSQL (the same schema works, the composite foreign keys and transactions carry over), and add row-level security as a third isolation layer.

## Likely questions, short answers

- *Why SQLite?* Zero setup for a reviewer, real transactions and foreign keys. Services are separated from routes so changing the database is contained.
- *Why plain `useReducer` and not Redux?* State is one board per branch with a handful of actions. The reducer is pure and unit tested.
- *Why `ws` and not Socket.IO?* I needed rooms and auth only. The protocol is small and documented in API.md.
- *How is the password stored?* bcrypt hash. Login errors are identical for unknown email and wrong password.
- *What validation do you do?* zod schemas on every request body, with length limits. React escapes output, so task text cannot inject HTML.
- *What is not done / known weaknesses?* See Limitations in the README. Be honest about them: no rate limiting, in-memory channels, no email invitations, JWT in localStorage.
- *Hardest bug or decision?* Choosing positions server-side from neighbour ids so concurrent drags do not clobber each other.

## Demo script (3 minutes)

1. Sign in as Ravi and as Anita in two windows (Hyderabad). Show presence avatars.
2. Anita adds a task. It appears for Ravi. Ravi drags it to Done. Anita sees it move. Ctrl+Z.
3. Both edit the same task: different fields merge, same field shows the conflict chooser.
4. Switch Anita to Bangalore: different data. Sign in as Arjun: a different organization, none of the ABC data.
5. Ravi removes Anita from Hyderabad: her live connection drops.
6. Stop the server briefly: the status shows Reconnecting, make a change, restart, it syncs.
