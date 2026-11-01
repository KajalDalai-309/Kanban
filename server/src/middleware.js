import { forbidden, HttpError, notFound, unauthorized } from './lib/errors.js';
import { verifyToken } from './lib/tokens.js';
import { atLeast, getOrgRole, getTenantAccess } from './services/access.js';

export const authenticate = (ctx) => (req, res, next) => {
  const header = req.headers.authorization ?? '';
  const userId = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : null);
  const user = userId && ctx.db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
  if (!user) return next(unauthorized());
  req.user = user;
  next();
};

// Every tenant route goes through this. It resolves the caller's role in the
// tenant named in the URL. Not a member and does-not-exist look the same (404).
export const tenantScope = (ctx) => (req, res, next) => {
  const access = getTenantAccess(ctx.db, req.user.id, req.params.tenantId);
  if (!access) return next(notFound('Tenant'));
  req.tenant = access;
  next();
};

export const orgScope = (ctx) => (req, res, next) => {
  const role = getOrgRole(ctx.db, req.user.id, req.params.orgId);
  if (!role) return next(notFound('Organization'));
  req.org = { id: req.params.orgId, role };
  next();
};

export const requireTenantRole = (min) => (req, res, next) =>
  atLeast(req.tenant.role, min) ? next() : next(forbidden());

export const requireOrgAdmin = (req, res, next) =>
  req.org.role === 'org_admin' ? next() : next(forbidden('Organization admins only'));

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Request body is not valid JSON' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
