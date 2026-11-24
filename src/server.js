import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthCheck, pool } from './db.js';
import { PgSessionStore } from './session-store.js';
import { notFound, errorHandler } from './middleware.js';
import authRoutes from './routes/auth.js';
import masterRoutes from './routes/masters.js';
import noteRoutes from './routes/notes.js';
import quotationRoutes from './routes/quotations.js';
import accountsRoutes from './routes/accounts.js';
import documentRoutes from './routes/documents.js';
import integrationRoutes from './routes/integrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const secureCookieSetting = String(process.env.SESSION_COOKIE_SECURE || '').trim().toLowerCase();
const secureSessionCookie = secureCookieSetting === 'true'
  || (secureCookieSetting !== 'false' && isProduction);
const configuredSessionHours = Number(process.env.SESSION_HOURS || 12);
const sessionMaxAge = Number.isFinite(configuredSessionHours) && configuredSessionHours > 0
  ? configuredSessionHours * 60 * 60 * 1000
  : 12 * 60 * 60 * 1000;

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && !sessionSecret) {
  console.error('SESSION_SECRET must be set before running in production. Refusing to start.');
  process.exit(1);
}

app.use(session({
  name: 'ang.sid',
  secret: sessionSecret || 'development-only-secret-do-not-use-in-production',
  store: new PgSessionStore({ pool, ttlMs: sessionMaxAge }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureSessionCookie,
    maxAge: sessionMaxAge,
  },
}));

app.get('/api/health', async (req, res) => {
  const db = await healthCheck();
  res.status(db.ok ? 200 : 503).json({
    ok: db.ok,
    version: '0.2.0',
    database: db,
    extraction_mode: process.env.EXTRACTION_MODE || 'off',
    ai_extraction: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api', masterRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api', quotationRoutes);
app.use('/api', accountsRoutes);
app.use('/api', documentRoutes);
app.use('/api/integrations', integrationRoutes);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: isProduction ? '1h' : 0,
}));

// Anything else that is not an API call gets the single-page app.
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use('/api', notFound);
app.use(errorHandler);

const server = app.listen(PORT, HOST, () => {
  const address = HOST === '0.0.0.0' ? `all network interfaces on port ${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Approval Note Generator v0.2 listening on ${address}`);
  healthCheck().then((db) => {
    if (db.ok) console.log(`Database connected: ${db.database}`);
    else console.error(`Database is not reachable: ${db.error}\nCheck DATABASE_URL and PostgreSQL availability. To create missing AppNote tables, run "npm run db:init"; do not use "npm run db:reset" on a database that contains data.`);
  });
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
