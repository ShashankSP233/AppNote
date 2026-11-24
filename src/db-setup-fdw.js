import 'dotenv/config';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import { closeSourcePools } from './integrations/source-databases.js';

const { Pool } = pg;
const appSetupUrl = process.env.FDW_SETUP_DATABASE_URL || process.env.DATABASE_URL;
if (!appSetupUrl) throw new Error('Set FDW_SETUP_DATABASE_URL for one-time setup, or DATABASE_URL to an AppNote database administrator URL.');

// The setup connection is used only by this one-time command. The web server
// will use the restricted login created below after setup completes.
const pool = new Pool({ connectionString: appSetupUrl, max: 2, connectionTimeoutMillis: 5000 });

const ROLE = Object.freeze({
  runtime: process.env.APPNOTE_RUNTIME_DB_ROLE || 'approval_note_runtime',
  reqflow: 'approval_note_reqflow_ro',
  siteerp: 'approval_note_siteerp_ro',
  siteerpVendor: 'approval_note_siteerp_vendor_rw',
});
const ROLE_MARKER = 'Managed by Approval Note Generator';
const SOURCES = Object.freeze({
  reqflow: {
    setupEnv: 'REQFLOW_FDW_SETUP_URL',
    server: 'reqflow_fdw',
    schema: 'fdw_reqflow',
    role: ROLE.reqflow,
    secret: 'REQFLOW_FDW_PASSWORD',
    tables: ['projects', 'sites', 'requisitions', 'requisition_items'],
    requiredColumns: {
      projects: ['id', 'code', 'name', 'company_id'],
      sites: ['id', 'name'],
      requisitions: ['id', 'ref_number', 'status', 'project_id', 'site_id', 'site_name', 'raised_by_name',
        'requisition_date', 'priority', 'purpose', 'notes', 'submitted_at', 'approved_at', 'completed_at', 'updated_at', 'created_at'],
      requisition_items: ['id', 'requisition_id', 'sort_order', 'item_name', 'quantity', 'unit', 'reference_no',
        'expected_cost', 'expected_cost_is_unit', 'description', 'remark', 'asset_id', 'asset_name'],
    },
  },
  siteerp: {
    setupEnv: 'SITEERP_FDW_SETUP_URL',
    server: 'siteerp_fdw',
    schema: 'fdw_siteerp',
    role: ROLE.siteerp,
    secret: 'SITEERP_FDW_PASSWORD',
    tables: ['vendors'],
    requiredColumns: {
      vendors: ['id', 'vendor_code', 'name', 'address', 'gst_no', 'tax_identifier', 'contact_person', 'phone',
        'email', 'pan_no', 'udyam_id', 'bank_name', 'bank_account_no', 'ifsc_code', 'is_active'],
    },
  },
});

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function identifier(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function setupSourceUrl(source) {
  return process.env[source.setupEnv];
}

async function ensureSecret(key) {
  if (process.env[key]) return process.env[key];
  const secret = crypto.randomBytes(32).toString('base64url');
  await fs.appendFile('.env', `\n${key}=${secret}\n`, { encoding: 'utf8' });
  process.env[key] = secret;
  return secret;
}

async function ensureOwnedRole(name, password, purpose) {
  const safeName = identifier(name);
  const marker = `${ROLE_MARKER}: ${purpose}`;
  const found = await pool.query(
    `SELECT shobj_description(oid, 'pg_authid') AS comment
       FROM pg_authid WHERE rolname=$1`, [name],
  );
  if (found.rowCount && found.rows[0].comment !== marker) {
    throw new Error(`PostgreSQL role ${name} already exists and is not marked as AppNote-managed. No changes were made to that role.`);
  }

  const ddl = found.rowCount
    ? `ALTER ROLE ${safeName} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`
    : `CREATE ROLE ${safeName} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`;
  await pool.query(ddl);
  if (!found.rowCount) {
    await pool.query(`COMMENT ON ROLE ${safeName} IS ${literal(marker)}`);
  }
}

async function setMapping(server, appRole, remoteUser, password) {
  const role = identifier(appRole);
  const found = await pool.query(
    'SELECT 1 FROM pg_user_mappings WHERE srvname=$1 AND usename=$2', [server, appRole],
  );
  if (found.rowCount) {
    await pool.query(
      `ALTER USER MAPPING FOR ${role} SERVER ${identifier(server)}
       OPTIONS (SET user ${literal(remoteUser)}, SET password ${literal(password)})`,
    );
  } else {
    await pool.query(
      `CREATE USER MAPPING FOR ${role} SERVER ${identifier(server)}
       OPTIONS (user ${literal(remoteUser)}, password ${literal(password)})`,
    );
  }
}

async function setTemporarySetupMapping(server, remoteUser, password) {
  const found = await pool.query(
    'SELECT 1 FROM pg_user_mappings WHERE srvname=$1 AND usename=current_user', [server],
  );
  if (found.rowCount) return false;
  await pool.query(
    `CREATE USER MAPPING FOR CURRENT_USER SERVER ${identifier(server)}
     OPTIONS (user ${literal(remoteUser)}, password ${literal(password)})`,
  );
  return true;
}

async function dropTemporarySetupMapping(server) {
  const found = await pool.query(
    'SELECT 1 FROM pg_user_mappings WHERE srvname=$1 AND usename=current_user', [server],
  );
  if (found.rowCount) {
    await pool.query(`DROP USER MAPPING FOR CURRENT_USER SERVER ${identifier(server)}`);
  }
}

async function ensureServer(server, sourceUrl) {
  const url = new URL(sourceUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || !url.hostname) throw new Error(`${server} needs a PostgreSQL URL with host and database name`);
  const safeServer = identifier(server);
  const exists = await pool.query('SELECT 1 FROM pg_foreign_server WHERE srvname=$1', [server]);
  const options = `host ${literal(url.hostname)}, port ${literal(url.port || '5432')}, dbname ${literal(database)}`;
  if (exists.rowCount) {
    await pool.query(`ALTER SERVER ${safeServer} OPTIONS (SET host ${literal(url.hostname)}, SET port ${literal(url.port || '5432')}, SET dbname ${literal(database)})`);
  } else {
    await pool.query(`CREATE SERVER ${safeServer} FOREIGN DATA WRAPPER postgres_fdw OPTIONS (${options})`);
  }
}

async function grantReadOnly(sourceUrl, role, tables) {
  const url = new URL(sourceUrl);
  const remote = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await remote.query(`GRANT CONNECT ON DATABASE ${identifier(decodeURIComponent(url.pathname.slice(1)))} TO ${identifier(role)}`);
    await remote.query(`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
    await remote.query(`GRANT SELECT ON ${tables.map((table) => `public.${identifier(table)}`).join(', ')} TO ${identifier(role)}`);
    await remote.query(`ALTER ROLE ${identifier(role)} IN DATABASE ${identifier(decodeURIComponent(url.pathname.slice(1)))} SET default_transaction_read_only = on`);
  } finally {
    await remote.end();
  }
}

async function grantVendorInsert(sourceUrl, role) {
  const url = new URL(sourceUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  const remote = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await remote.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(role)}`);
    await remote.query('GRANT USAGE ON SCHEMA public TO ' + identifier(role));
    await remote.query(`GRANT SELECT (id, vendor_code, name, gst_no, tax_identifier, pan_no, is_active)
      ON TABLE public.vendors TO ${identifier(role)}`);
    await remote.query(`GRANT INSERT (vendor_code, name, gst_no, pan_no, is_active)
      ON TABLE public.vendors TO ${identifier(role)}`);
    const sequence = await remote.query("SELECT pg_get_serial_sequence('public.vendors', 'id') AS name");
    if (sequence.rows[0]?.name) {
      await remote.query(`GRANT USAGE, SELECT ON SEQUENCE ${sequence.rows[0].name} TO ${identifier(role)}`);
    }
    await remote.query(`ALTER ROLE ${identifier(role)} IN DATABASE ${identifier(database)} SET default_transaction_read_only = off`);
  } finally {
    await remote.end();
  }
}

async function importMissingTables(server, schema, tables) {
  const safeSchema = identifier(schema);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${safeSchema}`);
  const existing = await pool.query(
    'SELECT foreign_table_name FROM information_schema.foreign_tables WHERE foreign_table_schema=$1', [schema],
  );
  const present = new Set(existing.rows.map((row) => row.foreign_table_name));
  const missing = tables.filter((table) => !present.has(table));
  if (!missing.length) return;
  await pool.query(
    `IMPORT FOREIGN SCHEMA public LIMIT TO (${missing.map(identifier).join(', ')}) FROM SERVER ${identifier(server)} INTO ${safeSchema}`,
  );
}

async function grantRuntimeAccess(database) {
  const role = identifier(ROLE.runtime);
  const db = identifier(database);
  await pool.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

  for (const [schema, server] of [
    ['fdw_reqflow', 'reqflow_fdw'],
    ['fdw_siteerp', 'siteerp_fdw'],
    ['fdw_siteerp_write', 'siteerp_vendor_write_fdw'],
  ]) {
    await pool.query(`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${role}`);
    await pool.query(`GRANT USAGE ON FOREIGN SERVER ${identifier(server)} TO ${role}`);
  }
  await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA fdw_reqflow TO ' + role);
  await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA fdw_siteerp TO ' + role);
  await pool.query('GRANT SELECT ON fdw_siteerp_write.vendors TO ' + role);
  await pool.query(`GRANT INSERT (vendor_code, name, gst_no, pan_no, is_active)
    ON TABLE fdw_siteerp_write.vendors TO ${role}`);
}

async function storeRuntimeDatabaseUrl(runtimeUrl) {
  const envPath = '.env';
  let contents = '';
  try { contents = await fs.readFile(envPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const remove = new Set([
    'FDW_SETUP_DATABASE_URL', 'REQFLOW_FDW_SETUP_URL', 'SITEERP_FDW_SETUP_URL',
    'REQFLOW_DATABASE_URL', 'SITEERP_DATABASE_URL',
  ]);
  const lines = contents.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || (!remove.has(match[1]) && match[1] !== 'DATABASE_URL');
  });
  while (lines.length && !lines.at(-1)) lines.pop();
  lines.push(`DATABASE_URL=${runtimeUrl}`);
  await fs.writeFile(envPath, `${lines.join('\n')}\n`, { encoding: 'utf8' });
}

async function verifySourceDatabases(sourceUrls) {
  const appCluster = await pool.query('SELECT system_identifier::text FROM pg_control_system()');
  const expectedId = appCluster.rows[0]?.system_identifier;
  if (!expectedId) throw new Error('Could not identify the AppNote PostgreSQL cluster. Run setup with a PostgreSQL administrator account.');

  for (const [key, source] of Object.entries(SOURCES)) {
    const remote = new Pool({ connectionString: sourceUrls[key], max: 1, connectionTimeoutMillis: 5000 });
    try {
      const cluster = await remote.query('SELECT system_identifier::text FROM pg_control_system()');
      if (cluster.rows[0]?.system_identifier !== expectedId) {
        throw new Error(`${source.setupEnv} points to a different PostgreSQL cluster. Setup stopped before changing any source database.`);
      }
      const result = await remote.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name = ANY($1::text[])`,
        [source.tables],
      );
      const columns = new Map();
      for (const row of result.rows) {
        if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
        columns.get(row.table_name).add(row.column_name);
      }
      const missingTables = source.tables.filter((table) => !columns.has(table));
      if (missingTables.length) {
        throw new Error(`${source.setupEnv} is missing required public tables: ${missingTables.join(', ')}. Setup stopped before changing any source database.`);
      }
      for (const [table, needed] of Object.entries(source.requiredColumns)) {
        const missingColumns = needed.filter((column) => !columns.get(table)?.has(column));
        if (missingColumns.length) {
          throw new Error(`${source.setupEnv} public.${table} is missing required columns: ${missingColumns.join(', ')}. Setup stopped before changing any source database.`);
        }
      }
    } finally {
      await remote.end();
    }
  }
}

const temporarySetupMappings = new Set();
try {
  const appDatabase = new URL(process.env.DATABASE_URL || appSetupUrl);
  const databaseName = decodeURIComponent(appDatabase.pathname.slice(1));
  if (!databaseName) throw new Error('The AppNote DATABASE_URL must include its database name.');

  const sourceUrls = Object.fromEntries(Object.entries(SOURCES).map(([key, source]) => [key, setupSourceUrl(source)]));
  for (const [key, source] of Object.entries(SOURCES)) {
    if (!sourceUrls[key]) throw new Error(`Set ${source.setupEnv} for one-time source permission setup.`);
  }
  await verifySourceDatabases(sourceUrls);

  const runtimePassword = await ensureSecret('APPNOTE_RUNTIME_DB_PASSWORD');
  const reqPassword = await ensureSecret(SOURCES.reqflow.secret);
  const erpPassword = await ensureSecret(SOURCES.siteerp.secret);
  const erpVendorWritePassword = await ensureSecret('SITEERP_VENDOR_FDW_PASSWORD');

  await pool.query('CREATE EXTENSION IF NOT EXISTS postgres_fdw');
  await ensureOwnedRole(ROLE.runtime, runtimePassword, 'AppNote web application login');
  await ensureOwnedRole(ROLE.reqflow, reqPassword, 'read-only Reqflow FDW login');
  await ensureOwnedRole(ROLE.siteerp, erpPassword, 'read-only SiteERP FDW login');
  await ensureOwnedRole(ROLE.siteerpVendor, erpVendorWritePassword, 'SiteERP vendor insert FDW login');

  await grantReadOnly(sourceUrls.reqflow, ROLE.reqflow, ['projects', 'sites', 'requisitions', 'requisition_items']);
  await grantReadOnly(sourceUrls.siteerp, ROLE.siteerp, ['vendors']);
  await grantVendorInsert(sourceUrls.siteerp, ROLE.siteerpVendor);

  await ensureServer(SOURCES.reqflow.server, sourceUrls.reqflow);
  await ensureServer(SOURCES.siteerp.server, sourceUrls.siteerp);
  await ensureServer('siteerp_vendor_write_fdw', sourceUrls.siteerp);
  await setMapping(SOURCES.reqflow.server, ROLE.runtime, ROLE.reqflow, reqPassword);
  await setMapping(SOURCES.siteerp.server, ROLE.runtime, ROLE.siteerp, erpPassword);
  await setMapping('siteerp_vendor_write_fdw', ROLE.runtime, ROLE.siteerpVendor, erpVendorWritePassword);

  if (ROLE.runtime === (await pool.query('SELECT current_user')).rows[0].current_user) {
    throw new Error('Run FDW setup as an administrator account, not as the restricted AppNote runtime role.');
  }
  for (const [server, remoteUser, password] of [
    [SOURCES.reqflow.server, ROLE.reqflow, reqPassword],
    [SOURCES.siteerp.server, ROLE.siteerp, erpPassword],
    ['siteerp_vendor_write_fdw', ROLE.siteerpVendor, erpVendorWritePassword],
  ]) {
    if (await setTemporarySetupMapping(server, remoteUser, password)) temporarySetupMappings.add(server);
  }

  await importMissingTables(SOURCES.reqflow.server, SOURCES.reqflow.schema, SOURCES.reqflow.tables);
  await importMissingTables(SOURCES.siteerp.server, SOURCES.siteerp.schema, SOURCES.siteerp.tables);
  await importMissingTables('siteerp_vendor_write_fdw', 'fdw_siteerp_write', ['vendors']);
  await grantRuntimeAccess(databaseName);

  const runtimeUrl = new URL(appDatabase);
  runtimeUrl.username = ROLE.runtime;
  runtimeUrl.password = runtimePassword;
  await storeRuntimeDatabaseUrl(runtimeUrl.toString());

  console.log(`FDW setup complete. AppNote runtime now uses the restricted role ${ROLE.runtime}.`);
  console.log('Source access: Reqflow SELECT on four required tables; SiteERP SELECT on vendors; SiteERP vendor role SELECT on approved columns and INSERT on vendors only.');
  console.log('Setup and direct-source URLs were removed from .env. Restart AppNote from a fresh process so it loads only the restricted runtime connection.');
} catch (error) {
  console.error(`FDW setup failed: ${error.message || error.code || 'database error'}`);
  process.exitCode = 1;
} finally {
  for (const server of temporarySetupMappings) {
    try { await dropTemporarySetupMapping(server); } catch (error) {
      console.error(`Could not remove temporary FDW mapping for ${server}: ${error.message}`);
    }
  }
  await closeSourcePools();
  await pool.end();
}
