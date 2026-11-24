// Schema creation and demo data.
//
//   npm run db:init     create the schema
//   npm run db:seed     create the schema and add demo users and masters
//   npm run db:reset    drop everything first, then do both

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, query, one, close } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'ChangeMe123!';

function safeDatabaseTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.username ? `${url.username}@` : ''}${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return '(configured database URL; details hidden)';
  }
}

const TABLES = [
  'app_sessions',
  'vendor_reviews',
  'source_vendors', 'source_requisition_items', 'source_requisitions', 'source_sites', 'source_projects',
  'audit_log', 'workflow_steps', 'accounts_review', 'payment_milestones',
  'note_items', 'comparison_values', 'comparison_criteria', 'quotation_files',
  'quotation_items', 'quotations', 'approval_notes', 'requisition_items',
  'requisitions', 'vendors', 'projects', 'users',
];

const DEMO_USERS = [
  { username: 'jaswinder', full_name: 'Jaswinder Singh', designation: 'Manager-Purchase', role: 'preparer' },
  { username: 'mansi', full_name: 'Mansi Shinde', designation: 'Asst. Manager-Purchase', role: 'preparer' },
  { username: 'saurabh', full_name: 'Saurabh Patki', designation: 'Checker', role: 'checker' },
  { username: 'abhishek', full_name: 'Abhishek Agarwal', designation: 'Checker', role: 'checker' },
  { username: 'vipul', full_name: 'Vipul Save', designation: 'Verifier', role: 'verifier' },
  { username: 'harshada', full_name: 'Harshada Save', designation: 'Verifier', role: 'verifier' },
  { username: 'accounts', full_name: 'Accounts Department', designation: 'Accounts', role: 'accounts' },
  { username: 'md', full_name: 'Managing Director', designation: 'Managing Director', role: 'approver' },
  { username: 'chairman', full_name: 'Hon. Chairman', designation: 'Chairman', role: 'approver' },
  { username: 'admin', full_name: 'System Administrator', designation: 'IT', role: 'admin' },
];

const DEMO_PROJECTS = [
  { code: 'JOG', name: 'Jogighopa / Dhubri, Assam', location: 'Jogighopa, Assam', state_code: '18' },
  { code: 'GOA', name: 'GSL Vasco-da-Gama, Goa', location: 'Vasco-da-Gama, Goa', state_code: '30' },
  { code: 'NW1', name: 'NW-1 Ganga, Bihar', location: 'Patna, Bihar', state_code: '10' },
  { code: 'MUM', name: 'Indira Dock, Mumbai Port', location: 'Mumbai, Maharashtra', state_code: '27' },
];

const DEMO_VENDORS = [
  {
    name: 'Rainbow Marine Engineering Services', short_name: 'Rainbow Marine',
    city: 'Mumbai', state_code: '27', gstin: '27CLLPV6143B1ZW',
    vendor_constitution: 'firm',
  },
  {
    name: 'D K Enterprises', short_name: 'DK Enterprises',
    city: 'Kolkata', state_code: '19', gstin: '19AISPB5151D1ZC',
    vendor_constitution: 'individual_huf',
  },
  {
    name: 'Jogighopa Filling Station', short_name: 'Jogighopa Filling',
    city: 'Jogighopa', state_code: '18',
    vendor_constitution: 'firm',
  },
];

async function dropAll() {
  console.log('Dropping existing tables…');
  await query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
}

async function createSchema() {
  const sql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Creating schema…');
  await query(sql);
  console.log('Schema is in place.');
}

async function seed() {
  console.log('Seeding demo data…');

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  for (const user of DEMO_USERS) {
    await query(
      `INSERT INTO users (username, password_hash, full_name, designation, email, role)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (username) DO UPDATE
         SET full_name = EXCLUDED.full_name, designation = EXCLUDED.designation,
             role = EXCLUDED.role`,
      [user.username, hash, user.full_name, user.designation,
        `${user.username}@example.invalid`, user.role],
    );
  }
  console.log(`  ${DEMO_USERS.length} users`);

  for (const project of DEMO_PROJECTS) {
    const existing = await one('SELECT id FROM projects WHERE code = $1', [project.code]);
    if (existing) continue;
    await query(
      'INSERT INTO projects (code, name, location, state_code) VALUES ($1,$2,$3,$4)',
      [project.code, project.name, project.location, project.state_code],
    );
  }
  console.log(`  ${DEMO_PROJECTS.length} projects`);

  for (const vendor of DEMO_VENDORS) {
    const existing = await one('SELECT id FROM vendors WHERE lower(name) = lower($1)', [vendor.name]);
    if (existing) continue;
    await query(
      `INSERT INTO vendors (name, short_name, city, state_code, gstin, pan, vendor_constitution)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [vendor.name, vendor.short_name, vendor.city, vendor.state_code,
        vendor.gstin || null,
        vendor.gstin ? vendor.gstin.slice(2, 12) : null,
        vendor.vendor_constitution],
    );
  }
  console.log(`  ${DEMO_VENDORS.length} vendors`);

  console.log('');
  console.log('Sign in with any of these usernames:');
  for (const user of DEMO_USERS) {
    console.log(`  ${user.username.padEnd(12)} ${user.role.padEnd(10)} ${user.full_name}`);
  }
  console.log(`\nThe password for all of them is: ${DEMO_PASSWORD}`);
  console.log('Change it before anyone else uses this.');
}

async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.includes('--reset')) await dropAll();
    await createSchema();
    if (args.includes('--demo') || args.includes('--seed')) await seed();
    console.log('\nDone.');
  } catch (error) {
    console.error('\nSetup failed:', error.message);
    if (error.message.includes('ECONNREFUSED')) {
      console.error('\nPostgreSQL does not appear to be running, or DATABASE_URL points somewhere else.');
      console.error(`Database target: ${safeDatabaseTarget(process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/approval_notes')}`);
    }
    process.exitCode = 1;
  } finally {
    await close();
  }
}

main();
