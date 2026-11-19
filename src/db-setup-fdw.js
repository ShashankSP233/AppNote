import 'dotenv/config';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import { pool, close } from './db.js';
import { closeSourcePools } from './integrations/source-databases.js';

const { Pool } = pg;

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function ensureSecret(key) {
  if (process.env[key]) return process.env[key];
  const secret = crypto.randomBytes(32).toString('base64url');
  await fs.appendFile('.env', `\n${key}=${secret}\n`, { encoding: 'utf8' });
  process.env[key] = secret;
  return secret;
}

async function ensureRole(name, password) {
  const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name]);
  const ddl = role.rowCount
    ? `ALTER ROLE ${name} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
    : `CREATE ROLE ${name} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`;
  await pool.query(ddl);
}

async function setMapping(server, remoteUser, password) {
  const found = await pool.query(
    `SELECT 1 FROM pg_user_mappings WHERE srvname=$1 AND usename=current_user`, [server],
  );
  if (found.rowCount) {
    await pool.query(
      `ALTER USER MAPPING FOR CURRENT_USER SERVER ${server}
       OPTIONS (SET user ${literal(remoteUser)}, SET password ${literal(password)})`,
    );
  } else {
    await pool.query(
      `CREATE USER MAPPING FOR CURRENT_USER SERVER ${server}
       OPTIONS (user ${literal(remoteUser)}, password ${literal(password)})`,
    );
  }
}

async function ensureServer(server, envKey) {
  const configured = process.env[envKey];
  if (!configured) throw new Error(`${envKey} is not set in .env`);
  const url = new URL(configured);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || !url.hostname) throw new Error(`${envKey} must be a PostgreSQL URL with a database name`);
  const exists = await pool.query('SELECT 1 FROM pg_foreign_server WHERE srvname=$1', [server]);
  const options = `host ${literal(url.hostname)}, port ${literal(url.port || '5432')}, dbname ${literal(database)}`;
  if (exists.rowCount) {
    await pool.query(`ALTER SERVER ${server} OPTIONS (SET host ${literal(url.hostname)}, SET port ${literal(url.port || '5432')}, SET dbname ${literal(database)})`);
  } else {
    await pool.query(`CREATE SERVER ${server} FOREIGN DATA WRAPPER postgres_fdw OPTIONS (${options})`);
  }
}

async function grantReadOnly(sourceUrl, role, tables) {
  const url = new URL(sourceUrl);
  const remote = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000 });
  const ident = (name) => `"${name.replaceAll('"', '""')}"`;
  try {
    await remote.query(`GRANT CONNECT ON DATABASE ${ident(decodeURIComponent(url.pathname.slice(1)))} TO ${role}`);
    await remote.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await remote.query(`GRANT SELECT ON ${tables.map((table) => `public.${ident(table)}`).join(', ')} TO ${role}`);
    await remote.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  } finally {
    await remote.end();
  }
}

async function grantVendorWrite(sourceUrl, role) {
  const url = new URL(sourceUrl);
  const remote = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000 });
  const ident = (name) => `"${name.replaceAll('"', '""')}"`;
  try {
    await remote.query(`GRANT CONNECT ON DATABASE ${ident(decodeURIComponent(url.pathname.slice(1)))} TO ${role}`);
    await remote.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await remote.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await remote.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
    await remote.query(`GRANT SELECT (id, vendor_code, name, gst_no, tax_identifier, pan_no, is_active)
      ON TABLE public.vendors TO ${role}`);
    await remote.query(`GRANT INSERT (vendor_code, name, gst_no, pan_no, is_active)
      ON TABLE public.vendors TO ${role}`);
    await remote.query(`ALTER ROLE ${role} SET default_transaction_read_only = off`);
  } finally {
    await remote.end();
  }
}

async function importTables(server, schema, tables) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const existing = await pool.query(
    `SELECT count(*)::int AS count FROM information_schema.foreign_tables WHERE foreign_table_schema=$1`, [schema],
  );
  if (existing.rows[0].count) return;
  await pool.query(
    `IMPORT FOREIGN SCHEMA public LIMIT TO (${tables.join(', ')}) FROM SERVER ${server} INTO ${schema}`,
  );
}

try {
  await pool.query('CREATE EXTENSION IF NOT EXISTS postgres_fdw');
  const reqPassword = await ensureSecret('REQFLOW_FDW_PASSWORD');
  const erpPassword = await ensureSecret('SITEERP_FDW_PASSWORD');
  const erpVendorWritePassword = await ensureSecret('SITEERP_VENDOR_FDW_PASSWORD');
  await ensureRole('appnote_reqflow_ro', reqPassword);
  await ensureRole('appnote_siteerp_ro', erpPassword);
  await ensureRole('appnote_siteerp_vendor_rw', erpVendorWritePassword);

  await grantReadOnly(process.env.REQFLOW_DATABASE_URL, 'appnote_reqflow_ro',
    ['projects', 'sites', 'requisitions', 'requisition_items']);
  await grantReadOnly(process.env.SITEERP_DATABASE_URL, 'appnote_siteerp_ro', ['vendors']);
  await grantVendorWrite(process.env.SITEERP_DATABASE_URL, 'appnote_siteerp_vendor_rw');

  await ensureServer('reqflow_fdw', 'REQFLOW_DATABASE_URL');
  await ensureServer('siteerp_fdw', 'SITEERP_DATABASE_URL');
  await ensureServer('siteerp_vendor_write_fdw', 'SITEERP_DATABASE_URL');
  await setMapping('reqflow_fdw', 'appnote_reqflow_ro', reqPassword);
  await setMapping('siteerp_fdw', 'appnote_siteerp_ro', erpPassword);
  await setMapping('siteerp_vendor_write_fdw', 'appnote_siteerp_vendor_rw', erpVendorWritePassword);
  await importTables('reqflow_fdw', 'fdw_reqflow', ['projects', 'sites', 'requisitions', 'requisition_items']);
  await importTables('siteerp_fdw', 'fdw_siteerp', ['vendors']);
  await importTables('siteerp_vendor_write_fdw', 'fdw_siteerp_write', ['vendors']);

  console.log('FDW setup complete: Reqflow and SiteERP read schemas are live; SiteERP vendor writeback is scoped to SELECT and INSERT on public.vendors.');
} catch (error) {
  console.error(`FDW setup failed: ${error.message || error.code || 'database error'}`);
  process.exitCode = 1;
} finally {
  await closeSourcePools();
  await close();
}
