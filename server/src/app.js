import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createHub } from './realtime/hub.js';
import { notFound } from './lib/errors.js';
import { authenticate, errorHandler, tenantScope } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { boardRoutes } from './routes/boards.js';
import { orgRoutes } from './routes/orgs.js';
import { taskRoutes } from './routes/tasks.js';
import { tenantRoutes } from './routes/tenants.js';

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

// Builds the HTTP server (REST + WebSocket upgrade) for a given database.
export function createServer(db) {
  const ctx = { db, hub: createHub({ db }) };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', authRoutes(ctx));
  app.use('/api', orgRoutes(ctx));

  // Everything below belongs to one tenant. authenticate + tenantScope run first,
  // so no handler can run for a tenant the caller is not a member of.
  const inTenant = [authenticate(ctx), tenantScope(ctx)];
  app.use('/api/tenants/:tenantId', ...inTenant, tenantRoutes(ctx), boardRoutes(ctx), taskRoutes(ctx));

  app.use('/api', (req, res, next) => next(notFound('Endpoint')));

  // In production the built React app is served by the same process.
  if (fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist));
    app.use((req, res, next) =>
      req.method === 'GET' ? res.sendFile(path.join(clientDist, 'index.html')) : next()
    );
  }

  app.use(errorHandler);

  const server = http.createServer(app);
  ctx.hub.attach(server);
  server.on('close', () => ctx.hub.close());
  return { server, hub: ctx.hub };
}
