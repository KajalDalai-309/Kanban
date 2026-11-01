import { createServer } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const db = openDb(config.dbPath);
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  seed(db);
  console.log('Initial database seeded with demo accounts.');
}
const { server } = createServer(db);

server.listen(config.port, () => {
  console.log(`Kanban API + WebSocket listening on http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
