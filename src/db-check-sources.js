import 'dotenv/config';
import { closeSourcePools, inspectSource } from './integrations/source-databases.js';

let failed = false;

try {
  for (const name of ['reqflow', 'siteerp']) {
    try {
      const result = await inspectSource(name);
      if (!result.configured) {
        console.log(`${result.name}: not configured yet.`);
        continue;
      }

      console.log(`${result.name}: connected to ${result.database}.`);
      for (const table of result.tables) {
        const columns = table.columns.map((column) => column.name).join(', ');
        console.log(`  ${table.name}: ${table.present ? columns : 'table not found'}`);
        if (!table.present) failed = true;
      }
    } catch (error) {
      failed = true;
      console.error(`${name}: ${error.message}`);
    }
  }
} finally {
  await closeSourcePools();
}

if (failed) process.exitCode = 1;
