import 'dotenv/config';
import { close } from './db.js';
import { closeSourcePools } from './integrations/source-databases.js';
import { syncReqflow } from './integrations/sync-reqflow.js';

try {
  const counts = await syncReqflow();
  console.log(`Reqflow sync complete: ${counts.projects} projects, ${counts.sites} sites, ${counts.requisitions} requisitions, ${counts.items} items.`);
} catch (error) {
  console.error(`Reqflow sync failed: ${error.message || error.code || 'connection error'}`);
  process.exitCode = 1;
} finally {
  await closeSourcePools();
  await close();
}
