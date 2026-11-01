// Demo data that follows the example in the assignment notes:
// ABC Technologies with Hyderabad / Bangalore / Chennai branches working on Projects A / B / C.
// A second organization (XYZ Corp) exists so cross-organization isolation can be seen.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { openDb } from './db.js';
import { createBoard } from './services/boards.js';
import { createTask } from './services/tasks.js';

export const DEMO_PASSWORD = 'password123';

export function seed(db) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, config.bcryptRounds);
  const users = {};
  const addUser = (key, name, email) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(id, email, name, hash);
    users[key] = { id, name };
  };
  const addOrg = (name) => {
    const id = randomUUID();
    db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run(id, name);
    return id;
  };
  const addTenant = (orgId, name) => {
    const id = randomUUID();
    db.prepare('INSERT INTO tenants (id, org_id, name) VALUES (?, ?, ?)').run(id, orgId, name);
    return id;
  };
  const addMembership = (user, orgId, tenantId, role) =>
    db.prepare('INSERT INTO memberships (id, user_id, org_id, tenant_id, role) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), user.id, orgId, tenantId, role);

  addUser('priya', 'Priya Sharma', 'priya@abc.com');
  addUser('hydLead', 'Ravi Kumar', 'ravi@abc.com');
  addUser('hydDev', 'Anita Reddy', 'anita@abc.com');
  addUser('blrLead', 'Karthik Rao', 'karthik@abc.com');
  addUser('blrDev', 'Meera Nair', 'meera@abc.com');
  addUser('chnLead', 'Suresh Iyer', 'suresh@abc.com');
  addUser('chnDev', 'Divya Menon', 'divya@abc.com');
  addUser('xyz', 'Arjun Mehta', 'arjun@xyz.com');

  const abc = addOrg('ABC Technologies');
  const hyd = addTenant(abc, 'Hyderabad');
  const blr = addTenant(abc, 'Bangalore');
  const chn = addTenant(abc, 'Chennai');
  const xyz = addOrg('XYZ Corp');
  const mumbai = addTenant(xyz, 'Mumbai');

  addMembership(users.priya, abc, null, 'org_admin');
  addMembership(users.hydLead, abc, hyd, 'tenant_admin');
  addMembership(users.hydDev, abc, hyd, 'member');
  addMembership(users.blrLead, abc, blr, 'tenant_admin');
  addMembership(users.blrDev, abc, blr, 'member');
  addMembership(users.chnLead, abc, chn, 'tenant_admin');
  addMembership(users.chnDev, abc, chn, 'member');
  // Anita also helps the Bangalore team, so she can switch between two branches.
  addMembership(users.hydDev, abc, blr, 'member');
  addMembership(users.xyz, xyz, null, 'org_admin');

  const columnNames = ['Backlog', 'In Progress', 'Review', 'Done'];
  const projects = [
    { tenantId: hyd, name: 'Project A', lead: users.hydLead, dev: users.hydDev, tasks: [
      ['Backlog', 'Set up CI pipeline', 'high'], ['Backlog', 'Write onboarding guide', 'low'],
      ['In Progress', 'Design login screen', 'medium'], ['In Progress', 'Payment API integration', 'high'],
      ['Review', 'Refactor user service', 'medium'], ['Done', 'Project kickoff notes', 'low'] ] },
    { tenantId: blr, name: 'Project B', lead: users.blrLead, dev: users.blrDev, tasks: [
      ['Backlog', 'Evaluate search providers', 'medium'], ['In Progress', 'Dashboard charts', 'high'],
      ['In Progress', 'Fix timezone bug in reports', 'high'], ['Review', 'Upgrade to Node 22', 'low'],
      ['Done', 'Database backup script', 'medium'] ] },
    { tenantId: chn, name: 'Project C', lead: users.chnLead, dev: users.chnDev, tasks: [
      ['Backlog', 'Customer feedback survey', 'low'], ['Backlog', 'Mobile layout audit', 'medium'],
      ['In Progress', 'Invoice export to PDF', 'high'], ['Done', 'Vendor shortlist', 'medium'] ] },
    { tenantId: mumbai, name: 'Mumbai Launch', lead: users.xyz, dev: users.xyz, tasks: [
      ['Backlog', 'Book venue', 'medium'], ['In Progress', 'Press kit', 'high'] ] },
  ];

  for (const p of projects) {
    const { board } = createBoard(db, { tenantId: p.tenantId, actor: p.lead, name: p.name, columns: columnNames });
    const cols = Object.fromEntries(
      db.prepare('SELECT id, name FROM columns WHERE board_id = ?').all(board.id).map((c) => [c.name, c.id])
    );
    p.tasks.forEach(([col, title, priority], i) => {
      const assignee = i % 2 === 0 ? p.dev : p.lead;
      createTask(db, {
        tenantId: p.tenantId, columnId: cols[col], actor: p.lead,
        input: {
          title, priority, assigneeId: assignee.id,
          description: `Details for "${title}".`,
          dueDate: i % 3 === 0 ? '2026-11-15' : undefined,
        },
      });
    });
  }
  return users;
}

const isDirectRun = Boolean(
  process.argv[1] &&
  (path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
   import.meta.url === `file://${process.argv[1]}`)
);

if (isDirectRun) {
  const db = openDb(config.dbPath);
  const priya = db.prepare('SELECT 1 FROM users WHERE email = ?').get('priya@abc.com');
  const force = process.argv.includes('--force') || process.argv.includes('--reset');

  if (priya && !force) {
    console.log(`Database already seeded with demo accounts. Sign in as priya@abc.com with password "${DEMO_PASSWORD}".`);
  } else {
    db.transaction(() => {
      db.exec('DELETE FROM activity_logs');
      db.exec('DELETE FROM tasks');
      db.exec('DELETE FROM columns');
      db.exec('DELETE FROM boards');
      db.exec('DELETE FROM memberships');
      db.exec('DELETE FROM tenants');
      db.exec('DELETE FROM organizations');
      db.exec('DELETE FROM users');
      seed(db);
    })();
    console.log(`Seeded successfully. Sign in as priya@abc.com (org admin) with password "${DEMO_PASSWORD}".`);
  }
  db.close();
}
