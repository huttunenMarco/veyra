import { asc } from 'drizzle-orm';
import { db, schema } from '../db/client';

export type Instance = typeof schema.organizations.$inferSelect;

let cachedId: string | null = null;

/**
 * Veyra runs as a single installation. Its settings live in one row (created on first start);
 * an existing database from the multi-user prototype keeps its first organization and data.
 */
export async function getInstance(): Promise<Instance> {
  const [row] = await db.select().from(schema.organizations).orderBy(asc(schema.organizations.createdAt)).limit(1);
  if (row) {
    cachedId = row.id;
    return row;
  }
  const [created] = await db.insert(schema.organizations).values({ name: 'Veyra' }).returning();
  cachedId = created!.id;
  return created!;
}

export async function instanceId(): Promise<string> {
  return cachedId ?? (await getInstance()).id;
}
