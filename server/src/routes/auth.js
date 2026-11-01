import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { signToken } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';
import { authenticate } from '../middleware.js';
import { listAccessibleOrgs } from '../services/access.js';

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase(), password: z.string() });

export function authRoutes(ctx) {
  const { db } = ctx;
  const router = Router();

  router.post('/auth/register', (req, res) => {
    const { name, email, password } = parse(registerSchema, req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'email_taken', 'An account with this email already exists');
    }
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(
      id, email, name, bcrypt.hashSync(password, config.bcryptRounds)
    );
    res.status(201).json({ token: signToken(id), user: { id, name, email } });
  });

  router.post('/auth/login', (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same error for unknown email and wrong password.
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');
    }
    res.json({ token: signToken(row.id), user: { id: row.id, name: row.name, email: row.email } });
  });

  // Current user plus every org and tenant they can open, with their role in each.
  router.get('/me', authenticate(ctx), (req, res) => {
    res.json({ user: req.user, orgs: listAccessibleOrgs(db, req.user.id) });
  });

  return router;
}
