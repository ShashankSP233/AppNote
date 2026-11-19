// Read-only connections to the restored Reqflow and SiteERP databases.
// All source queries run inside a PostgreSQL READ ONLY transaction so this
// app cannot accidentally write back into either application database.

import pg from 'pg';

const { Pool } = pg;
const SOURCES = {
  reqflow: { label: 'Reqflow', env: 'REQFLOW_DATABASE_URL', tables: ['projects', 'sites', 'requisitions', 'requisition_items'] },
  siteerp: { label: 'SiteERP', env: 'SITEERP_DATABASE_URL', tables: ['vendors'] },
};

const pools = new Map();

function sourceConfig(name) {
  const config = SOURCES[name];
  if (!config) throw new Error(`Unknown source database: ${name}`);
  const connectionString = process.env[config.env];
  if (!connectionString) return { config, pool: null };

  if (!pools.has(name)) {
    pools.set(name, new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      ssl: process.env.SOURCE_PGSSL === 'require'
        ? { rejectUnauthorized: true }
        : undefined,
    }));
  }

  return { config, pool: pools.get(name) };
}

export async function withReadOnlySource(name, work) {
  const { config, pool } = sourceConfig(name);
  if (!pool) {
    throw new Error(`${config.env} is not configured. Restore the source database and set a read-only connection URL in .env.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be lost */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reports source connectivity and public-schema columns without reading rows. */
export async function inspectSource(name) {
  const { config, pool } = sourceConfig(name);
  if (!pool) return { name: config.label, configured: false, tables: [] };

  return withReadOnlySource(name, async (client) => {
    const identity = await client.query('SELECT current_database() AS database');
    const columns = await client.query(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [config.tables],
    );

    const byTable = new Map();
    for (const row of columns.rows) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
      byTable.get(row.table_name).push({ name: row.column_name, type: row.data_type });
    }

    return {
      name: config.label,
      configured: true,
      database: identity.rows[0].database,
      tables: config.tables.map((table) => ({ name: table, present: byTable.has(table), columns: byTable.get(table) || [] })),
    };
  });
}

export async function closeSourcePools() {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
