import { db, schema } from '../db/client';

export async function audit(
  organizationId: string,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(schema.auditLogs).values({ organizationId, action, resourceType, resourceId, metadata });
}
