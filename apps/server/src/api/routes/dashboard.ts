import { and, count, eq, gte, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/client';
import { route } from '../route';

export function dashboardRoutes(app: FastifyInstance) {
  route(app, { method: 'GET', url: '/api/v1/dashboard', summary: 'Översiktsstatistik', tag: 'Översikt' }, async ({ auth }) => {
    const org = auth.organizationId;
    const since = new Date(Date.now() - 86_400_000);
    const [cameraStats] = await db
      .select({
        total: count(),
        online: sql<number>`count(*) filter (where ${schema.cameras.status} = 'online')`.mapWith(Number),
        offline: sql<number>`count(*) filter (where ${schema.cameras.status} in ('offline','error'))`.mapWith(Number),
      })
      .from(schema.cameras)
      .where(eq(schema.cameras.organizationId, org));
    const [sensorStats] = await db
      .select({
        active: sql<number>`count(*) filter (where ${schema.sensors.enabled})`.mapWith(Number),
        unknown: sql<number>`count(*) filter (where ${schema.sensors.enabled} and coalesce(${schema.sensorStates.status}, 'unknown') <> 'confirmed')`.mapWith(Number),
      })
      .from(schema.sensors)
      .leftJoin(schema.sensorStates, eq(schema.sensorStates.sensorId, schema.sensors.id))
      .where(eq(schema.sensors.organizationId, org));
    const [eventStats] = await db
      .select({ last24h: count() })
      .from(schema.events)
      .where(and(eq(schema.events.organizationId, org), gte(schema.events.occurredAt, since)));
    const [analysisStats] = await db
      .select({
        total: count(),
        failures: sql<number>`count(*) filter (where ${schema.sensorObservations.status} = 'unavailable')`.mapWith(Number),
      })
      .from(schema.sensorObservations)
      .innerJoin(schema.sensors, eq(schema.sensors.id, schema.sensorObservations.sensorId))
      .where(eq(schema.sensors.organizationId, org));
    const [deliveryStats] = await db
      .select({
        failed24h: sql<number>`count(*) filter (where ${schema.actionExecutions.status} = 'failed')`.mapWith(Number),
      })
      .from(schema.actionExecutions)
      .where(and(eq(schema.actionExecutions.organizationId, org), gte(schema.actionExecutions.createdAt, since)));
    // Times a rule actually fired in the last 24h (real events only: no tests, no cooldown skips).
    const [triggered] = await db
      .select({ n: count() })
      .from(schema.automationRuns)
      .innerJoin(schema.events, eq(schema.events.id, schema.automationRuns.eventId))
      .where(
        and(
          eq(schema.events.organizationId, org),
          gte(schema.events.occurredAt, since),
          eq(schema.automationRuns.status, 'executed'),
          ne(schema.events.eventType, 'test'),
        ),
      );
    return {
      cameras: cameraStats,
      sensors: sensorStats,
      events: eventStats,
      analyses: analysisStats,
      deliveries: deliveryStats,
      automationsTriggered24h: triggered?.n ?? 0,
    };
  });
}
