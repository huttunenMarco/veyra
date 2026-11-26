import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { notFound } from '../lib/errors';

/** All loaders scope by organization: a resource of another tenant is indistinguishable from a missing one. */
export async function loadCamera(orgId: string, id: string) {
  const [c] = await db.select().from(schema.cameras).where(and(eq(schema.cameras.id, id), eq(schema.cameras.organizationId, orgId)));
  if (!c) throw notFound('Kameran');
  return c;
}

export async function loadZone(orgId: string, id: string) {
  const [row] = await db
    .select({ zone: schema.zones })
    .from(schema.zones)
    .innerJoin(schema.cameras, eq(schema.cameras.id, schema.zones.cameraId))
    .where(and(eq(schema.zones.id, id), eq(schema.cameras.organizationId, orgId)));
  if (!row) throw notFound('Zonen');
  return row.zone;
}

export async function loadSensor(orgId: string, id: string) {
  const [s] = await db.select().from(schema.sensors).where(and(eq(schema.sensors.id, id), eq(schema.sensors.organizationId, orgId)));
  if (!s) throw notFound('Sensorn');
  return s;
}

export async function loadRule(orgId: string, id: string) {
  const [r] = await db
    .select()
    .from(schema.automationRules)
    .where(and(eq(schema.automationRules.id, id), eq(schema.automationRules.organizationId, orgId)));
  if (!r) throw notFound('Automatiseringen');
  return r;
}

export async function loadConnection(orgId: string, id: string) {
  const [c] = await db
    .select()
    .from(schema.integrationConnections)
    .where(and(eq(schema.integrationConnections.id, id), eq(schema.integrationConnections.organizationId, orgId)));
  if (!c) throw notFound('Integrationen');
  return c;
}

export async function loadAgent(orgId: string, id: string) {
  const [a] = await db
    .select()
    .from(schema.cameraAgents)
    .where(and(eq(schema.cameraAgents.id, id), eq(schema.cameraAgents.organizationId, orgId)));
  if (!a) throw notFound('Kameraagenten');
  return a;
}

export async function loadFrame(orgId: string, id: string) {
  const [row] = await db
    .select({ frame: schema.cameraFrames })
    .from(schema.cameraFrames)
    .innerJoin(schema.cameras, eq(schema.cameras.id, schema.cameraFrames.cameraId))
    .where(and(eq(schema.cameraFrames.id, id), eq(schema.cameras.organizationId, orgId)));
  if (!row || row.frame.deletedAt) throw notFound('Bilden');
  return row.frame;
}
