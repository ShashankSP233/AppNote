import express from 'express';
import bcrypt from 'bcryptjs';
import { one, many, query } from '../db.js';
import { wrap, httpError, safeUser, requireAuth, requireRole, audit } from '../middleware.js';

const router = express.Router();

export const ROLES = [
  { value: 'preparer', label: 'Preparer (Purchase)' },
  { value: 'checker', label: 'Checker' },
  { value: 'verifier', label: 'Verifier' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'approver', label: 'Approver' },
  { value: 'admin', label: 'Administrator' },
];

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    throw httpError(400, 'Enter a username and a password.');
  }

  const user = await one(
    'SELECT * FROM users WHERE lower(username) = lower($1) AND is_active',
    [String(username).trim()],
  );

  // Compare regardless, so a missing user and a wrong password take the same
  // time and cannot be told apart.
  const hash = user?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(String(password), hash);

  if (!user || !ok) {
    throw httpError(401, 'That username and password do not match.');
  }

  req.session.user = safeUser(user);
  req.user = req.session.user;
  await audit(req, { action: 'login', entity: 'user', entityId: user.id });

  res.json({ user: req.session.user });
}));

router.post('/logout', wrap(async (req, res) => {
  await new Promise((resolve) => req.session.destroy(resolve));
  res.json({ ok: true });
}));

router.get('/me', (req, res) => {
  res.json({ user: req.session?.user || null, roles: ROLES });
});

router.post('/password', requireAuth, wrap(async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  if (!current || !next) throw httpError(400, 'Enter the current password and the new one.');
  if (String(next).length < 8) throw httpError(400, 'The new password needs at least 8 characters.');

  const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const ok = await bcrypt.compare(String(current), user.password_hash);
  if (!ok) throw httpError(401, 'The current password is not right.');

  if (String(next) === String(current)) {
    throw httpError(400, 'The new password is the same as the current one.');
  }

  const hash = await bcrypt.hash(String(next), 10);
  await query(
    'UPDATE users SET password_hash = $1, password_changed_at = now(), updated_at = now() WHERE id = $2',
    [hash, user.id],
  );
  await audit(req, { action: 'password_changed', entity: 'user', entityId: user.id });

  // Refresh the session copy so the "still on a given password" nudge stops
  // straight away rather than on the next sign-in.
  if (req.session?.user) req.session.user.password_changed_at = new Date().toISOString();

  res.json({ ok: true });
}));

// --- User administration ---------------------------------------------------

router.get('/users', requireAuth, wrap(async (req, res) => {
  const rows = req.user.role === 'admin'
    ? await many(
      `SELECT id, username, full_name, designation, email, role, is_active, created_at,
              password_changed_at
         FROM users ORDER BY is_active DESC, full_name`,
    )
    : await many(
      `SELECT id, username, full_name, designation, role, is_active
         FROM users ORDER BY is_active DESC, full_name`,
    );
  res.json({ users: rows });
}));

router.post('/users', requireRole('admin'), wrap(async (req, res) => {
  const { username, password, full_name: fullName, designation, email, role } = req.body || {};

  if (!username || !password || !fullName) {
    throw httpError(400, 'A username, a password and a full name are needed.');
  }
  if (String(password).length < 8) {
    throw httpError(400, 'The password needs at least 8 characters.');
  }
  if (role && !ROLES.some((r) => r.value === role)) {
    throw httpError(400, 'That is not a role this system knows.');
  }

  const existing = await one('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (existing) throw httpError(409, 'That username is already taken.');

  const hash = await bcrypt.hash(String(password), 10);
  const user = await one(
    `INSERT INTO users (username, password_hash, full_name, designation, email, role)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, username, full_name, designation, email, role, is_active`,
    [String(username).trim(), hash, fullName, designation || null, email || null, role || 'preparer'],
  );

  await audit(req, { action: 'user_created', entity: 'user', entityId: user.id, detail: { username, role } });
  res.status(201).json({ user });
}));

router.patch('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { full_name: fullName, designation, email, role, is_active: isActive, password } = req.body || {};

  if (role && !ROLES.some((r) => r.value === role)) {
    throw httpError(400, 'That is not a role this system knows.');
  }

  const target = await one('SELECT id, role, is_active FROM users WHERE id = $1', [id]);
  if (!target) throw httpError(404, 'There is no user with that id.');

  // Two ways to lock everyone out of administration; both are easy to do by
  // accident and impossible to undo from inside the application.
  if (id === req.user.id && isActive === false) {
    throw httpError(409, 'You cannot deactivate your own account. Ask another administrator to do it.');
  }

  const losingAdmin = target.role === 'admin'
    && ((role && role !== 'admin') || isActive === false);

  if (losingAdmin) {
    const others = await one(
      `SELECT COUNT(*)::int AS count FROM users
        WHERE role = 'admin' AND is_active AND id <> $1`,
      [id],
    );
    if (others.count === 0) {
      throw httpError(409, 'This is the only active administrator. Make someone else an administrator first, or nobody will be able to manage users.');
    }
  }

  const fields = [];
  const values = [];
  const push = (sql, value) => { values.push(value); fields.push(`${sql} = $${values.length}`); };

  if (fullName !== undefined) push('full_name', fullName);
  if (designation !== undefined) push('designation', designation);
  if (email !== undefined) push('email', email);
  if (role !== undefined) push('role', role);
  if (isActive !== undefined) push('is_active', Boolean(isActive));
  if (password) {
    if (String(password).length < 8) throw httpError(400, 'The password needs at least 8 characters.');
    push('password_hash', await bcrypt.hash(String(password), 10));
    // Deliberately not stamping password_changed_at: an admin reset means the
    // account is on a password a second person knows, so it still counts as
    // needing the owner to set their own.
    push('password_changed_at', null);
  }

  if (!fields.length) throw httpError(400, 'There is nothing to change.');

  values.push(id);
  const user = await one(
    `UPDATE users SET ${fields.join(', ')}, updated_at = now()
      WHERE id = $${values.length}
      RETURNING id, username, full_name, designation, email, role, is_active,
                password_changed_at`,
    values,
  );

  if (!user) throw httpError(404, 'There is no user with that id.');

  await audit(req, { action: 'user_updated', entity: 'user', entityId: id });
  res.json({ user });
}));

export default router;
