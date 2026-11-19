// Shared HTTP plumbing: errors, auth guards, uploads, audit.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import multer from 'multer';
import { query } from './db.js';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export class HttpError extends Error {
  constructor(status, message, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function httpError(status, message, detail = null) {
  return new HttpError(status, message, detail);
}

/** The shape of a user that is safe to send to the browser. */
export function safeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    designation: user.designation,
    email: user.email,
    role: user.role,
    // Lets the app nudge someone still using a password they were handed.
    password_changed_at: user.password_changed_at ?? null,
  };
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return next(httpError(401, 'Please sign in to continue.'));
  }
  req.user = req.session.user;
  return next();
}

/** Admins pass every role check. */
export function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) return next(httpError(401, 'Please sign in to continue.'));
    if (user.role === 'admin' || roles.includes(user.role)) {
      req.user = user;
      return next();
    }
    return next(httpError(403, `This action needs one of these roles: ${roles.join(', ')}.`));
  };
}

/** Wraps an async handler so a rejection reaches the error middleware. */
export function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export async function audit(req, { noteId = null, action, entity = null, entityId = null, detail = null }) {
  try {
    await query(
      `INSERT INTO audit_log (note_id, user_id, user_name, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [noteId, req.user?.id || null, req.user?.full_name || null, action, entity, entityId,
        detail ? JSON.stringify(detail) : null],
    );
  } catch (error) {
    // An audit failure must never break the operation being audited.
    console.error('[audit]', error.message);
  }
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const ALLOWED_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff',
  '.doc', '.docx', '.xls', '.xlsx']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${stamp}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
    files: 12,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(httpError(400, `${file.originalname} is a ${ext || 'unknown'} file. Attach a PDF, an image, a Word file or a spreadsheet.`));
    }
    return cb(null, true);
  },
});

export function storedPath(storedName) {
  const resolved = path.resolve(UPLOAD_DIR, storedName);
  if (!resolved.startsWith(UPLOAD_DIR + path.sep) && resolved !== UPLOAD_DIR) {
    throw httpError(400, 'That file path is not valid.');
  }
  return resolved;
}

export function notFound(req, res) {
  res.status(404).json({ error: 'There is nothing at that address.' });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `That file is larger than the ${process.env.MAX_UPLOAD_MB || 25} MB limit.`
      : error.code === 'LIMIT_FILE_COUNT'
        ? 'Too many files in one upload.'
        : `Upload failed: ${error.message}`;
    return res.status(400).json({ error: message });
  }

  const status = error.status || 500;
  if (status >= 500) {
    console.error('[error]', error.stack || error.message);
  }

  return res.status(status).json({
    error: status >= 500 ? 'Something went wrong at our end. The details are in the server log.' : error.message,
    detail: error.detail || undefined,
  });
}
