import 'dotenv/config';
import { close } from './db.js';
import { closeSourcePools } from './integrations/source-databases.js';
import { syncSiteErpVendors } from './integrations/sync-siteerp.js';

try {
  const counts = await syncSiteErpVendors();
  console.log(`SiteERP vendor sync complete: ${counts.vendors} vendors (${counts.active} active).`);
} catch (error) {
  console.error(`SiteERP vendor sync failed: ${error.message || error.code || 'connection error'}`);
  process.exitCode = 1;
} finally {
  await closeSourcePools();
  await close();
}
