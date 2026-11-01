process.env.BCRYPT_ROUNDS = '4';

import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../src/app.js';
import { openDb } from '../src/db.js';

export async function startTestServer() {
  const db = openDb(':memory:');
  const { server } = createServer(db);
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  async function call(token, method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  let counter = 0;
  async function signUp(name) {
    const email = `${name.toLowerCase()}${++counter}@test.com`;
    const { body } = await call(null, 'POST', '/api/auth/register', { name, email, password: 'password123' });
    return { id: body.user.id, name, email, token: body.token };
  }

  return {
    db, base, port, call, signUp,
    wsUrl: `ws://localhost:${port}/ws`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// A small world: org1 (admin + tenants T1/T2), org2 with its own tenant.
export async function buildWorld(t) {
  const alice = await t.signUp('Alice'); // org1 admin
  const bob = await t.signUp('Bob'); // tenant admin of T1
  const carol = await t.signUp('Carol'); // member of T1
  const dave = await t.signUp('Dave'); // member of T2
  const eve = await t.signUp('Eve'); // org2 admin

  const org1 = (await t.call(alice.token, 'POST', '/api/orgs', { name: 'Org One' })).body.org;
  const T1 = (await t.call(alice.token, 'POST', `/api/orgs/${org1.id}/tenants`, { name: 'T1' })).body.tenant;
  const T2 = (await t.call(alice.token, 'POST', `/api/orgs/${org1.id}/tenants`, { name: 'T2' })).body.tenant;
  await t.call(alice.token, 'POST', `/api/tenants/${T1.id}/members`, { email: bob.email, role: 'tenant_admin' });
  await t.call(alice.token, 'POST', `/api/tenants/${T1.id}/members`, { email: carol.email, role: 'member' });
  await t.call(alice.token, 'POST', `/api/tenants/${T2.id}/members`, { email: dave.email, role: 'member' });

  const org2 = (await t.call(eve.token, 'POST', '/api/orgs', { name: 'Org Two' })).body.org;
  const T3 = (await t.call(eve.token, 'POST', `/api/orgs/${org2.id}/tenants`, { name: 'T3' })).body.tenant;

  const board1 = (await t.call(bob.token, 'POST', `/api/tenants/${T1.id}/boards`, { name: 'Board 1' })).body.board;
  const snap = (await t.call(bob.token, 'GET', `/api/tenants/${T1.id}/boards/${board1.id}`)).body;
  const [todo, doing, done] = snap.columns;
  return { alice, bob, carol, dave, eve, org1, org2, T1, T2, T3, board1, todo, doing, done };
}

export function connectWs(t, { token, tenantId }) {
  const ws = new WebSocket(t.wsUrl);
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', token, tenantId })));

  const waitFor = async (predicate, ms = 2000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('timed out waiting for message');
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { ws, messages, closed, waitFor, close: () => ws.close() };
}
