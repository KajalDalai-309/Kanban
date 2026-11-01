import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { buildWorld, connectWs, startTestServer } from './helpers.js';

let t;
let w;
before(async () => {
  t = await startTestServer();
  w = await buildWorld(t);
});
after(() => t.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const createTask = (user, title) =>
  t.call(user.token, 'POST', `/api/tenants/${w.T1.id}/columns/${w.todo.id}/tasks`, { title });

describe('websocket channels', () => {
  test('rejects an invalid token', async () => {
    const c = connectWs(t, { token: 'bad', tenantId: w.T1.id });
    assert.equal(await c.closed, 4401);
  });

  test('rejects a user who is not in the tenant, and does not say whether it exists', async () => {
    const outsider = connectWs(t, { token: w.eve.token, tenantId: w.T1.id });
    assert.equal(await outsider.closed, 4403);
    const missing = connectWs(t, { token: w.eve.token, tenantId: 'does-not-exist' });
    assert.equal(await missing.closed, 4403);
    assert.equal(outsider.messages[0].code, missing.messages[0].code);
  });

  test('closes sockets that never join', async () => {
    const ws = new WebSocket(t.wsUrl);
    const code = await new Promise((resolve) => ws.on('close', resolve));
    assert.equal(code, 4401);
  });

  test('members receive events of their tenant only', async () => {
    const carol = connectWs(t, { token: w.carol.token, tenantId: w.T1.id });
    const dave = connectWs(t, { token: w.dave.token, tenantId: w.T2.id });
    await carol.waitFor((m) => m.type === 'joined');
    await dave.waitFor((m) => m.type === 'joined');

    const { body } = await createTask(w.bob, 'Live task');
    const evt = await carol.waitFor((m) => m.type === 'event' && m.name === 'task.created');
    assert.equal(evt.data.task.id, body.task.id);
    assert.equal(evt.tenantId, w.T1.id);
    assert.equal(evt.activity.action, 'task.created');
    assert.equal(evt.actor.name, 'Bob');

    await sleep(150);
    assert.equal(dave.messages.filter((m) => m.type === 'event').length, 0);
    carol.close();
    dave.close();
  });

  test('presence lists each user once and updates on join and leave', async () => {
    const carol1 = connectWs(t, { token: w.carol.token, tenantId: w.T1.id });
    const joined = await carol1.waitFor((m) => m.type === 'joined');
    assert.deepEqual(joined.presence.map((u) => u.name), ['Carol']);

    const bob = connectWs(t, { token: w.bob.token, tenantId: w.T1.id });
    await bob.waitFor((m) => m.type === 'joined');
    const withBob = await carol1.waitFor((m) => m.type === 'presence' && m.users.length === 2);
    assert.deepEqual(withBob.users.map((u) => u.name), ['Bob', 'Carol']);

    // a second tab for the same user does not duplicate them
    const carol2 = connectWs(t, { token: w.carol.token, tenantId: w.T1.id });
    await carol2.waitFor((m) => m.type === 'joined');
    await sleep(100);
    const last = [...bob.messages].reverse().find((m) => m.type === 'presence');
    assert.equal(last.users.length, 2);

    bob.close();
    const afterLeave = await carol1.waitFor((m) => m.type === 'presence' && m.users.length === 1 && m.users[0].name === 'Carol' && m !== joined);
    assert.ok(afterLeave);
    carol1.close();
    carol2.close();
  });

  test('presence is scoped: users of other tenants are never listed', async () => {
    const dave = connectWs(t, { token: w.dave.token, tenantId: w.T2.id });
    const joined = await dave.waitFor((m) => m.type === 'joined');
    assert.deepEqual(joined.presence.map((u) => u.name), ['Dave']);
    dave.close();
  });

  test('switching tenant on the same socket moves the user between channels', async () => {
    const alice = connectWs(t, { token: w.alice.token, tenantId: w.T1.id });
    await alice.waitFor((m) => m.type === 'joined' && m.tenantId === w.T1.id);
    alice.ws.send(JSON.stringify({ type: 'join', tenantId: w.T2.id }));
    await alice.waitFor((m) => m.type === 'joined' && m.tenantId === w.T2.id);

    const before = alice.messages.length;
    await createTask(w.bob, 'After switch');
    await sleep(150);
    assert.equal(alice.messages.slice(before).filter((m) => m.type === 'event').length, 0);
    alice.close();
  });

  test('removing a member disconnects their socket', async () => {
    const guest = await t.signUp('Guest');
    await t.call(w.bob.token, 'POST', `/api/tenants/${w.T1.id}/members`, { email: guest.email });
    const c = connectWs(t, { token: guest.token, tenantId: w.T1.id });
    await c.waitFor((m) => m.type === 'joined');

    await t.call(w.bob.token, 'DELETE', `/api/tenants/${w.T1.id}/members/${guest.id}`);
    assert.equal(await c.closed, 4403);
    assert.ok(c.messages.some((m) => m.type === 'kicked'));
  });

  test('moves, edits and deletes are broadcast with versions so clients can ignore stale events', async () => {
    const carol = connectWs(t, { token: w.carol.token, tenantId: w.T1.id });
    await carol.waitFor((m) => m.type === 'joined');
    const { body } = await createTask(w.bob, 'Versioned');
    const id = body.task.id;

    await t.call(w.bob.token, 'PATCH', `/api/tenants/${w.T1.id}/tasks/${id}`, { baseVersion: 1, changes: { title: 'v2' } });
    await t.call(w.bob.token, 'POST', `/api/tenants/${w.T1.id}/tasks/${id}/move`, { columnId: w.doing.id });
    await t.call(w.bob.token, 'DELETE', `/api/tenants/${w.T1.id}/tasks/${id}`);

    const updated = await carol.waitFor((m) => m.name === 'task.updated' && m.data.task.id === id);
    const moved = await carol.waitFor((m) => m.name === 'task.moved' && m.data.task.id === id);
    const deleted = await carol.waitFor((m) => m.name === 'task.deleted' && m.data.taskId === id);
    assert.deepEqual([updated.data.task.version, moved.data.task.version, deleted.data.version], [2, 3, 4]);
    carol.close();
  });
});
