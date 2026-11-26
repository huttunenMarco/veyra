import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './client';

const folder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Apply pending migrations. Runs automatically on startup. */
export async function runMigrations() {
  await migrate(db, { migrationsFolder: folder });
}

// CLI: `pnpm db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runMigrations();
  console.log('Migrations applied');
  await sqlClient.end();
}
