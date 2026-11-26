import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** Create (if needed) and migrate the dedicated test database. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://veyra:veyra@localhost:5434/veyra_test';
  const name = new URL(url).pathname.slice(1);
  const admin = postgres(url.replace(/\/[^/]+$/, '/postgres'), { onnotice: () => {} });
  const exists = await admin`select 1 from pg_database where datname = ${name}`;
  if (exists.length === 0) await admin.unsafe(`create database "${name}"`);
  await admin.end();

  const client = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  await client.end();
}
