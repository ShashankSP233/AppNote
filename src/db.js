// PostgreSQL access.
//
// pg returns NUMERIC as a string to protect precision. Every money column here
// fits comfortably in a double, and strings leaking into arithmetic is a
// reliable source of bugs, so NUMERIC and BIGINT are parsed to Number. DATE is
// deliberately left as a string so a date never shifts by a timezone.

import pg from 'pg';

const { Pool, types } = pg;

types.setTypeParser(1700, (value) => (value === null ? null : Number(value))); // NUMERIC
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));   // INT8
types.setTypeParser(1082, (value) => value);                                   // DATE as text

const connectionString = process.env.APPNOTE_DB_URL
  || 'postgresql://postgres:postgres@localhost:5432/approval_notes';

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (error) => {
  console.error('[db] idle client error:', error.message);
});

// A transaction context so repository functions can join an open transaction
// without every caller threading a client through its signature.
import { AsyncLocalStorage } from 'node:async_hooks';

const txStorage = new AsyncLocalStorage();

function activeClient() {
  return txStorage.getStore()?.client || null;
}

export async function query(text, params = []) {
  const client = activeClient();
  if (client) return client.query(text, params);
  return pool.query(text, params);
}

/** One row or null. */
export async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

/** All rows. */
export async function many(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

/** Runs fn inside a transaction, joining one already in progress. */
export async function tx(fn) {
  const existing = activeClient();
  if (existing) return fn(existing);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStorage.run({ client }, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection already lost */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck() {
  try {
    const row = await one('SELECT now() AS now, current_database() AS db');
    return { ok: true, now: row.now, database: row.db };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function close() {
  await pool.end();
}
