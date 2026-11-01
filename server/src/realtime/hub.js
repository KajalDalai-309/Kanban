import { WebSocketServer } from 'ws';
import { verifyToken } from '../lib/tokens.js';
import { getTenantAccess } from '../services/access.js';

const JOIN_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;

// Stable colour per user so avatars look the same on every screen.
function colorFor(userId) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 45%)`;
}

/**
 * One channel per tenant. A socket is only added to a channel after the server
 * has checked that the token's user is a member of that tenant, and events are
 * only ever sent to the channel of the tenant they belong to, so a client can
 * never receive another tenant's data.
 *
 * Channels live in memory, so this runs as a single instance. To scale out, the
 * publish() call would go through Redis pub/sub (see README).
 */
export function createHub({ db }) {
  const channels = new Map(); // tenantId -> Set<client>
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  const send = (ws, payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  function presenceOf(tenantId) {
    const users = new Map();
    for (const c of channels.get(tenantId) ?? []) {
      users.set(c.user.id, { id: c.user.id, name: c.user.name, color: colorFor(c.user.id) });
    }
    return [...users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function broadcast(tenantId, payload) {
    const text = JSON.stringify(payload);
    for (const c of channels.get(tenantId) ?? []) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(text);
    }
  }

  function leave(client) {
    const tenantId = client.tenantId;
    if (!tenantId) return;
    const set = channels.get(tenantId);
    set?.delete(client);
    if (set && set.size === 0) channels.delete(tenantId);
    client.tenantId = null;
    broadcast(tenantId, { type: 'presence', tenantId, users: presenceOf(tenantId) });
  }

  function join(client, tenantId) {
    const access = getTenantAccess(db, client.user.id, tenantId);
    if (!access) {
      send(client.ws, { type: 'error', code: 'forbidden', message: 'No access to this tenant' });
      client.ws.close(4403, 'forbidden');
      return;
    }
    leave(client);
    client.tenantId = tenantId;
    if (!channels.has(tenantId)) channels.set(tenantId, new Set());
    channels.get(tenantId).add(client);
    send(client.ws, { type: 'joined', tenantId, presence: presenceOf(tenantId) });
    broadcast(tenantId, { type: 'presence', tenantId, users: presenceOf(tenantId) });
  }

  wss.on('connection', (ws) => {
    const client = { ws, user: null, tenantId: null, isAlive: true };
    ws.client = client;
    const joinTimer = setTimeout(() => ws.close(4401, 'join timeout'), JOIN_TIMEOUT_MS);

    ws.on('pong', () => (client.isAlive = true));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'ping') return send(ws, { type: 'pong' });
      if (msg.type !== 'join' || typeof msg.tenantId !== 'string') return;

      if (!client.user) {
        const userId = verifyToken(msg.token);
        const user = userId && db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
        if (!user) {
          send(ws, { type: 'error', code: 'unauthorized', message: 'Invalid token' });
          return ws.close(4401, 'unauthorized');
        }
        client.user = user;
      }
      clearTimeout(joinTimer);
      join(client, msg.tenantId);
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      leave(client);
    });
    ws.on('error', () => ws.terminate());
  });

  // Drop sockets that stopped answering pings (half-open connections).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.client && !ws.client.isAlive) {
        ws.terminate();
        continue;
      }
      if (ws.client) ws.client.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function* channelsFlat() {
    for (const set of channels.values()) yield* set;
  }

  return {
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        if (new URL(req.url, 'http://localhost').pathname !== '/ws') return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });
    },

    // Send an event to everyone currently in a tenant's channel. Call after the DB commit.
    publish(tenantId, name, data, { actor, activity } = {}) {
      broadcast(tenantId, { type: 'event', tenantId, name, data, actor, activity });
    },

    // Re-check every open socket of a user (after a membership was removed or changed).
    revalidateUser(userId) {
      for (const client of [...channelsFlat()]) {
        if (client.user.id !== userId) continue;
        if (!getTenantAccess(db, userId, client.tenantId)) {
          send(client.ws, { type: 'kicked', tenantId: client.tenantId });
          client.ws.close(4403, 'access revoked');
        }
      }
    },

    // Close every socket of a tenant (tenant or organization deleted).
    closeTenant(tenantId) {
      for (const client of [...(channels.get(tenantId) ?? [])]) {
        send(client.ws, { type: 'kicked', tenantId });
        client.ws.close(4403, 'tenant removed');
      }
    },

    presence: presenceOf,

    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
