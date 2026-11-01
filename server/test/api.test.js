import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildWorld, startTestServer } from './helpers.js';

let t;
let w;
before(async () => {
  t = await startTestServer();
  w = await buildWorld(t);
});
after(() => t.close());

const tasksUrl = (tenantId, columnId) => `/api/tenants/${tenantId}/columns/${columnId}/tasks`;
const taskUrl = (tenantId, taskId) => `/api/tenants/${tenantId}/tasks/${taskId}`;
const makeTask = async (user, title, extra = {}) =>
  (await t.call(user.token, 'POST', tasksUrl(w.T1.id, w.todo.id), { title, ...extra })).body.task;

describe('authentication', () => {
  test('rejects requests without a valid token', async () => {
    assert.equal((await t.call(null, 'GET', '/api/me')).status, 401);
    assert.equal((await t.call('garbage', 'GET', `/api/tenants/${w.T1.id}/boards`)).status, 401);
  });

  test('wrong password and unknown email give the same error', async () => {
    const a = await t.call(null, 'POST', '/api/auth/login', { email: w.bob.email, password: 'nope-nope' });
    const b = await t.call(null, 'POST', '/api/auth/login', { email: 'nobody@test.com', password: 'nope-nope' });
    assert.equal(a.status, 401);
    assert.deepEqual(a.body, b.body);
  });

  test('/me lists orgs and tenants with roles', async () => {
    const alice = (await t.call(w.alice.token, 'GET', '/api/me')).body;
    assert.equal(alice.orgs.length, 1);
    assert.equal(alice.orgs[0].role, 'org_admin');
    assert.deepEqual(alice.orgs[0].tenants.map((x) => x.name), ['T1', 'T2']);

    const carol = (await t.call(w.carol.token, 'GET', '/api/me')).body;
    assert.deepEqual(carol.orgs[0].tenants.map((x) => [x.name, x.role]), [['T1', 'member']]);
  });
});

describe('tenant isolation', () => {
  let secret;
  before(async () => {
    secret = await makeTask(w.bob, 'T1 secret');
  });

  test('a user outside the organization gets 404 for tenant, board and task', async () => {
    for (const path of [
      `/api/tenants/${w.T1.id}/boards`,
      `/api/tenants/${w.T1.id}/boards/${w.board1.id}`,
      taskUrl(w.T1.id, secret.id),
      `/api/tenants/${w.T1.id}/activity`,
      `/api/tenants/${w.T1.id}/members`,
    ]) {
      assert.equal((await t.call(w.eve.token, 'GET', path)).status, 404, path);
    }
  });

  test('a member of another tenant in the same organization gets 404', async () => {
    assert.equal((await t.call(w.dave.token, 'GET', `/api/tenants/${w.T1.id}/boards`)).status, 404);
    assert.equal((await t.call(w.dave.token, 'POST', tasksUrl(w.T1.id, w.todo.id), { title: 'x' })).status, 404);
  });

  test('ids from tenant A are not reachable through the URL of tenant B', async () => {
    // Eve is a legitimate admin of T3 but asks for T1's task / column / board under T3.
    assert.equal((await t.call(w.eve.token, 'GET', taskUrl(w.T3.id, secret.id))).status, 404);
    assert.equal((await t.call(w.eve.token, 'PATCH', taskUrl(w.T3.id, secret.id), { baseVersion: 1, changes: { title: 'hacked' } })).status, 404);
    assert.equal((await t.call(w.eve.token, 'DELETE', taskUrl(w.T3.id, secret.id))).status, 404);
    assert.equal((await t.call(w.eve.token, 'POST', tasksUrl(w.T3.id, w.todo.id), { title: 'x' })).status, 404);
    assert.equal((await t.call(w.eve.token, 'GET', `/api/tenants/${w.T3.id}/boards/${w.board1.id}`)).status, 404);
    const still = (await t.call(w.bob.token, 'GET', taskUrl(w.T1.id, secret.id))).body.task;
    assert.equal(still.title, 'T1 secret');
  });

  test('a task cannot be moved into a column of another tenant', async () => {
    const eveBoard = (await t.call(w.eve.token, 'POST', `/api/tenants/${w.T3.id}/boards`, { name: 'E' })).body.board;
    const eveCols = (await t.call(w.eve.token, 'GET', `/api/tenants/${w.T3.id}/boards/${eveBoard.id}`)).body.columns;
    const res = await t.call(w.bob.token, 'POST', `${taskUrl(w.T1.id, secret.id)}/move`, { columnId: eveCols[0].id });
    assert.equal(res.status, 404);
  });

  test('the database itself refuses cross-tenant references', () => {
    const otherColumn = t.db.prepare('SELECT id FROM columns WHERE tenant_id = ? LIMIT 1').get(w.T3.id);
    assert.throws(
      () =>
        t.db
          .prepare(
            `INSERT INTO tasks (id, tenant_id, board_id, column_id, title, position, created_at, updated_at)
             VALUES ('x', ?, ?, ?, 'x', 1, '', '')`
          )
          .run(w.T1.id, w.board1.id, otherColumn.id),
      /FOREIGN KEY/
    );
  });

  test('cannot assign a task to someone outside the tenant', async () => {
    const res = await t.call(w.bob.token, 'POST', tasksUrl(w.T1.id, w.todo.id), { title: 'x', assigneeId: w.dave.id });
    assert.equal(res.status, 400);
  });

  test('removing a member takes effect on the next request', async () => {
    const extra = await t.signUp('Frank');
    await t.call(w.bob.token, 'POST', `/api/tenants/${w.T1.id}/members`, { email: extra.email });
    assert.equal((await t.call(extra.token, 'GET', `/api/tenants/${w.T1.id}/boards`)).status, 200);
    await t.call(w.bob.token, 'DELETE', `/api/tenants/${w.T1.id}/members/${extra.id}`);
    assert.equal((await t.call(extra.token, 'GET', `/api/tenants/${w.T1.id}/boards`)).status, 404);
  });
});

describe('role based access control', () => {
  test('members cannot manage boards, columns or tenants', async () => {
    const base = `/api/tenants/${w.T1.id}`;
    assert.equal((await t.call(w.carol.token, 'POST', `${base}/boards`, { name: 'No' })).status, 403);
    assert.equal((await t.call(w.carol.token, 'DELETE', `${base}/boards/${w.board1.id}`)).status, 403);
    assert.equal((await t.call(w.carol.token, 'POST', `${base}/boards/${w.board1.id}/columns`, { name: 'No' })).status, 403);
    assert.equal((await t.call(w.carol.token, 'POST', `${base}/members`, { email: w.dave.email })).status, 403);
    assert.equal((await t.call(w.carol.token, 'DELETE', base)).status, 403);
  });

  test('tenant admins cannot create tenants or touch the organization', async () => {
    assert.equal((await t.call(w.bob.token, 'POST', `/api/orgs/${w.org1.id}/tenants`, { name: 'T9' })).status, 403);
    assert.equal((await t.call(w.bob.token, 'DELETE', `/api/orgs/${w.org1.id}`)).status, 403);
    assert.equal((await t.call(w.bob.token, 'DELETE', `/api/tenants/${w.T1.id}`)).status, 403);
  });

  test('org admin has admin rights in every tenant of the org, and nowhere else', async () => {
    const res = await t.call(w.alice.token, 'POST', `/api/tenants/${w.T2.id}/boards`, { name: 'By admin' });
    assert.equal(res.status, 201);
    assert.equal((await t.call(w.alice.token, 'GET', `/api/tenants/${w.T3.id}/boards`)).status, 404);
  });

  test('members delete only their own tasks, admins any', async () => {
    const bobs = await makeTask(w.bob, 'Bobs task');
    const carols = await makeTask(w.carol, 'Carols task');
    assert.equal((await t.call(w.carol.token, 'DELETE', taskUrl(w.T1.id, bobs.id))).status, 403);
    assert.equal((await t.call(w.carol.token, 'DELETE', taskUrl(w.T1.id, carols.id))).status, 204);
    assert.equal((await t.call(w.bob.token, 'DELETE', taskUrl(w.T1.id, bobs.id))).status, 204);
  });

  test('members can create, edit and move tasks', async () => {
    const task = await makeTask(w.carol, 'Edit me');
    const edit = await t.call(w.carol.token, 'PATCH', taskUrl(w.T1.id, task.id), { baseVersion: 1, changes: { priority: 'high' } });
    assert.equal(edit.status, 200);
    const move = await t.call(w.carol.token, 'POST', `${taskUrl(w.T1.id, task.id)}/move`, { columnId: w.doing.id });
    assert.equal(move.status, 200);
  });
});

describe('concurrency', () => {
  test('edits to different fields merge, edits to the same field conflict', async () => {
    const task = await makeTask(w.bob, 'Original');
    const url = taskUrl(w.T1.id, task.id);

    const a = await t.call(w.bob.token, 'PATCH', url, { baseVersion: 1, changes: { title: 'Bob title' } });
    assert.equal(a.status, 200);
    assert.equal(a.body.task.version, 2);

    // Carol still thinks the task is at version 1, but she touches another field.
    const b = await t.call(w.carol.token, 'PATCH', url, { baseVersion: 1, changes: { description: 'Carol notes' } });
    assert.equal(b.status, 200);
    assert.equal(b.body.task.title, 'Bob title');
    assert.equal(b.body.task.description, 'Carol notes');
    assert.equal(b.body.task.version, 3);

    // Carol now edits the title from her stale copy.
    const c = await t.call(w.carol.token, 'PATCH', url, { baseVersion: 1, changes: { title: 'Carol title', priority: 'low' } });
    assert.equal(c.status, 409);
    assert.deepEqual(c.body.error.conflicts, ['title']);
    assert.equal(c.body.error.current.title, 'Bob title');
    // nothing from the rejected request was applied
    const after = (await t.call(w.bob.token, 'GET', url)).body.task;
    assert.equal(after.priority, 'medium');
    assert.equal(after.version, 3);

    // Retrying against the current version succeeds.
    const d = await t.call(w.carol.token, 'PATCH', url, { baseVersion: 3, changes: { title: 'Carol title' } });
    assert.equal(d.status, 200);
  });

  test('two clients writing the same value do not conflict, and a retry is a no-op', async () => {
    const task = await makeTask(w.bob, 'Same');
    const url = taskUrl(w.T1.id, task.id);
    await t.call(w.bob.token, 'PATCH', url, { baseVersion: 1, changes: { priority: 'high' } });
    const res = await t.call(w.carol.token, 'PATCH', url, { baseVersion: 1, changes: { priority: 'high' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.task.version, 2);
  });

  test('simultaneous updates: exactly one wins per field', async () => {
    const task = await makeTask(w.bob, 'Race');
    const url = taskUrl(w.T1.id, task.id);
    const results = await Promise.all(
      [w.bob, w.carol, w.alice].map((u, i) =>
        t.call(u.token, 'PATCH', url, { baseVersion: 1, changes: { title: `Title ${i}` } })
      )
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 2);
  });

  test('create with a client id is idempotent', async () => {
    const id = crypto.randomUUID();
    const first = await t.call(w.carol.token, 'POST', tasksUrl(w.T1.id, w.todo.id), { id, title: 'Once' });
    const again = await t.call(w.carol.token, 'POST', tasksUrl(w.T1.id, w.todo.id), { id, title: 'Once' });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.task.id, id);
    // an id that already exists in another tenant is refused without revealing anything
    const clash = await t.call(w.eve.token, 'POST', `/api/tenants/${w.T3.id}/columns/${(await colOfT3()).id}/tasks`, { id, title: 'Steal' });
    assert.equal(clash.status, 409);
  });
  const colOfT3 = async () => t.db.prepare('SELECT id FROM columns WHERE tenant_id = ? LIMIT 1').get(w.T3.id);

  test('deleted tasks can be restored; editing a deleted task is 404', async () => {
    const task = await makeTask(w.bob, 'Undo me');
    const url = taskUrl(w.T1.id, task.id);
    await t.call(w.bob.token, 'DELETE', url);
    assert.equal((await t.call(w.bob.token, 'PATCH', url, { baseVersion: 1, changes: { title: 'x' } })).status, 404);
    const restored = await t.call(w.bob.token, 'POST', `${url}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.task.title, 'Undo me');
  });
});

describe('ordering and drag and drop', () => {
  const order = async (columnId) => {
    const snap = (await t.call(w.bob.token, 'GET', `/api/tenants/${w.T1.id}/boards/${w.board1.id}`)).body;
    return snap.tasks.filter((x) => x.columnId === columnId).map((x) => x.title);
  };

  test('a task dropped between two neighbours lands between them', async () => {
    const col = (await t.call(w.bob.token, 'POST', `/api/tenants/${w.T1.id}/boards/${w.board1.id}/columns`, { name: 'Order' })).body.column;
    const mk = async (title) => (await t.call(w.bob.token, 'POST', tasksUrl(w.T1.id, col.id), { title })).body.task;
    const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')];
    assert.deepEqual(await order(col.id), ['A', 'B', 'C']);

    await t.call(w.bob.token, 'POST', `${taskUrl(w.T1.id, c.id)}/move`, { columnId: col.id, afterId: a.id, beforeId: b.id });
    assert.deepEqual(await order(col.id), ['A', 'C', 'B']);

    await t.call(w.bob.token, 'POST', `${taskUrl(w.T1.id, b.id)}/move`, { columnId: col.id, afterId: null, beforeId: a.id });
    assert.deepEqual(await order(col.id), ['B', 'A', 'C']);
  });

  test('two users dropping into the same gap both land, nothing is lost', async () => {
    const col = (await t.call(w.bob.token, 'POST', `/api/tenants/${w.T1.id}/boards/${w.board1.id}/columns`, { name: 'Race' })).body.column;
    const mk = async (title) => (await t.call(w.bob.token, 'POST', tasksUrl(w.T1.id, col.id), { title })).body.task;
    const [a, b, x, y] = [await mk('A'), await mk('B'), await mk('X'), await mk('Y')];
    await Promise.all([
      t.call(w.bob.token, 'POST', `${taskUrl(w.T1.id, x.id)}/move`, { columnId: col.id, afterId: a.id, beforeId: b.id }),
      t.call(w.carol.token, 'POST', `${taskUrl(w.T1.id, y.id)}/move`, { columnId: col.id, afterId: a.id, beforeId: b.id }),
    ]);
    const result = await order(col.id);
    assert.equal(result.length, 4);
    assert.equal(result[0], 'A');
    assert.equal(result[3], 'B');
    assert.deepEqual([...result].sort(), ['A', 'B', 'X', 'Y']);
  });

  test('if the neighbour was deleted meanwhile the task goes to the end of the column', async () => {
    const col = (await t.call(w.bob.token, 'POST', `/api/tenants/${w.T1.id}/boards/${w.board1.id}/columns`, { name: 'Gone' })).body.column;
    const mk = async (title) => (await t.call(w.bob.token, 'POST', tasksUrl(w.T1.id, col.id), { title })).body.task;
    const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')];
    await t.call(w.bob.token, 'DELETE', taskUrl(w.T1.id, a.id));
    const moved = await t.call(w.bob.token, 'POST', `${taskUrl(w.T1.id, c.id)}/move`, { columnId: col.id, afterId: a.id, beforeId: null });
    assert.equal(moved.status, 200);
    assert.deepEqual(await order(col.id), ['B', 'C']);
    void b;
  });

  test('repeated drops into the same gap trigger a rebalance and keep the order', async () => {
    const col = (await t.call(w.bob.token, 'POST', `/api/tenants/${w.T1.id}/boards/${w.board1.id}/columns`, { name: 'Squeeze' })).body.column;
    const mk = async (title) => (await t.call(w.bob.token, 'POST', tasksUrl(w.T1.id, col.id), { title })).body.task;
    const first = await mk('first');
    const last = await mk('last');
    const expected = [];
    for (let i = 0; i < 40; i++) {
      const task = await mk(`n${i}`);
      await t.call(w.bob.token, 'POST', `${taskUrl(w.T1.id, task.id)}/move`, { columnId: col.id, afterId: first.id, beforeId: null });
      expected.unshift(`n${i}`);
    }
    assert.deepEqual(await order(col.id), ['first', ...expected, 'last']);
    void last;
  });

  test('deleting a column that still has tasks is refused', async () => {
    const res = await t.call(w.bob.token, 'DELETE', `/api/tenants/${w.T1.id}/columns/${w.todo.id}`);
    assert.equal(res.status, 409);
  });
});

describe('activity log', () => {
  test('records changes per tenant and never leaks across tenants', async () => {
    const task = await makeTask(w.bob, 'Logged task');
    await t.call(w.bob.token, 'POST', `${taskUrl(w.T1.id, task.id)}/move`, { columnId: w.done.id });
    const log = (await t.call(w.carol.token, 'GET', `/api/tenants/${w.T1.id}/activity?limit=5`)).body.activity;
    assert.equal(log[0].action, 'task.moved');
    assert.match(log[0].summary, /Logged task/);
    assert.ok(log.every((e) => e.tenantId === w.T1.id));
    const other = (await t.call(w.dave.token, 'GET', `/api/tenants/${w.T2.id}/activity`)).body.activity;
    assert.ok(other.every((e) => e.tenantId === w.T2.id));
  });
});
