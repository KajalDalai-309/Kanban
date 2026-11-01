import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// Node's built-in SQLite needs no native build step (so no Visual Studio / node-gyp on Windows).
// This thin wrapper adds the one helper the services use: db.transaction(fn)().
// Transactions can nest; inner ones become savepoints.
class Db {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.depth = 0;
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  prepare(sql) {
    return this.raw.prepare(sql);
  }

  transaction(fn) {
    return () => {
      const name = `sp${this.depth}`;
      this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn();
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (err) {
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      }
    };
  }

  close() {
    this.raw.close();
  }
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Db(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  return db;
}
