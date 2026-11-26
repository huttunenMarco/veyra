import { aliasedTable, and, desc, eq, gte, inArray, lt, lte, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eventTypes, formatSensorValue } from '@veyra/shared';
import { db, schema } from '../../db/client';
import { notFound } from '../../lib/errors';
import { route, uuidParam } from '../route';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime().optional(),
  cameraId: z.string().uuid().optional(),
  sensorId: z.string().uuid().optional(),
  zoneId: z.string().uuid().optional(),
  type: z.enum(eventTypes).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  deliveryStatus: z.enum(['delivered', 'failed', 'pending']).optional(),
});

async function listEvents(orgId: string, q: z.infer<typeof listQuery> & { id?: string }) {
  const where: SQL[] = [eq(schema.events.organizationId, orgId)];
  if (q.id) where.push(eq(schema.events.id, q.id));
  if (q.cursor) where.push(lt(schema.events.occurredAt, new Date(q.cursor)));
  if (q.cameraId) where.push(eq(schema.events.cameraId, q.cameraId));
  if (q.sensorId) where.push(eq(schema.events.sensorId, q.sensorId));
  if (q.zoneId) where.push(eq(schema.sensors.zoneId, q.zoneId));
  if (q.type) where.push(eq(schema.events.eventType, q.type));
  if (q.from) where.push(gte(schema.events.occurredAt, new Date(q.from)));
  if (q.to) where.push(lte(schema.events.occurredAt, new Date(q.to)));

  const camera = aliasedTable(schema.cameras, 'event_camera');
  const rows = await db
    .select({ event: schema.events, sensor: schema.sensors, zone: schema.zones, cameraName: camera.name })
    .from(schema.events)
    .leftJoin(schema.sensors, eq(schema.sensors.id, schema.events.sensorId))
    .leftJoin(schema.zones, eq(schema.zones.id, schema.sensors.zoneId))
    .leftJoin(camera, eq(camera.id, schema.events.cameraId))
    .where(and(...where))
    .orderBy(desc(schema.events.occurredAt))
    .limit(q.limit);

  const ids = rows.map((r) => r.event.id);
  const [execs, runs] = ids.length
    ? await Promise.all([
        db
          .select({ exec: schema.actionExecutions, connectionName: schema.integrationConnections.name })
          .from(schema.actionExecutions)
          .leftJoin(schema.integrationConnections, eq(schema.integrationConnections.id, schema.actionExecutions.integrationConnectionId))
          .where(inArray(schema.actionExecutions.eventId, ids)),
        db
          .select({ run: schema.automationRuns, ruleName: schema.automationRules.name })
          .from(schema.automationRuns)
          .innerJoin(schema.automationRules, eq(schema.automationRules.id, schema.automationRuns.ruleId))
          .where(inArray(schema.automationRuns.eventId, ids)),
      ])
    : [[], []];

  let data = rows.map(({ event, sensor, zone, cameraName }) => {
    const spec = sensor ? { outputType: sensor.outputType, outputConfig: sensor.outputConfig } : null;
    const deliveries = execs
      .filter((e) => e.exec.eventId === event.id)
      .map((e) => ({
        id: e.exec.id,
        integrationType: e.exec.integrationType,
        connectionName: e.connectionName,
        status: e.exec.status,
        simulated: e.exec.simulated,
        isTest: e.exec.isTest,
        destination: e.exec.destination,
        attempts: e.exec.attempts,
        responseCode: e.exec.responseCode,
        errorMessage: e.exec.errorMessage,
        payloadPreview: e.exec.payloadPreview,
        completedAt: e.exec.completedAt,
      }));
    return {
      ...event,
      cameraName,
      sensor: sensor ? { id: sensor.id, name: sensor.name, outputType: sensor.outputType } : null,
      zone: zone ? { id: zone.id, name: zone.name, color: zone.color } : null,
      previousLabel: spec ? formatSensorValue(spec, event.previousValue) : null,
      currentLabel: spec ? formatSensorValue(spec, event.currentValue) : null,
      automations: runs.filter((r) => r.run.eventId === event.id).map((r) => ({ ruleId: r.run.ruleId, name: r.ruleName, status: r.run.status })),
      deliveries,
    };
  });
  if (q.deliveryStatus) {
    data = data.filter((e) =>
      q.deliveryStatus === 'pending'
        ? e.deliveries.some((d) => ['pending', 'processing', 'retrying'].includes(d.status))
        : e.deliveries.some((d) => d.status === q.deliveryStatus),
    );
  }
  return { data, rawCount: rows.length };
}

export function eventRoutes(app: FastifyInstance) {
  route(app, { method: 'GET', url: '/api/v1/events', summary: 'Lista händelser', tag: 'Händelser', query: listQuery }, async ({ auth, query }) => {
    const { data, rawCount } = await listEvents(auth.organizationId, query);
    const last = data[data.length - 1];
    return { data, nextCursor: rawCount === query.limit && last ? last.occurredAt.toISOString() : null };
  });

  route(app, { method: 'GET', url: '/api/v1/events/:id', summary: 'Hämta händelse', tag: 'Händelser' }, async ({ auth, params }) => {
    const { data } = await listEvents(auth.organizationId, { id: uuidParam(params), limit: 1 });
    if (!data[0]) throw notFound('Händelsen');
    return data[0];
  });
}
