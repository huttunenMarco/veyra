import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actionConfigSchemas, deliveryStatuses, integrationInputSchema, integrationTypes } from '@veyra/shared';
import { config } from '../../config';
import { db, schema } from '../../db/client';
import { audit } from '../../lib/audit';
import { conflict } from '../../lib/errors';
import { formatTimestamp } from '../../services/context';
import { deliver } from '../../services/delivery';
import { connectionConfig, prepareConnectionConfig, publicConnection } from '../../services/integrations';
import { loadConnection } from '../loaders';
import { route, uuidParam } from '../route';

const sampleActions: Record<string, unknown> = {
  ntfy: { title: 'Test från Veyra', message: 'Det fungerar! Så här ser en notis ut när {{sensor.name}} ändras till {{sensor.valueLabel}}.', attachSnapshot: false },
  email: { subject: 'Test från Veyra', body: 'Det här är ett testmeddelande från Veyra.\nSensor: {{sensor.name}} = {{sensor.valueLabel}}\nTid: {{event.timestamp}}', attachSnapshot: false },
  sms: { body: 'Test från Veyra: {{sensor.name}} är {{sensor.valueLabel}} ({{event.timestamp}})' },
  webhook: {},
  slack: { message: 'Test från Veyra: {{sensor.name}} är {{sensor.valueLabel}}' },
  teams: { message: 'Test från Veyra: {{sensor.name}} är {{sensor.valueLabel}}' },
  discord: { message: 'Test från Veyra: {{sensor.name}} är {{sensor.valueLabel}}' },
  http: { method: 'POST', path: '', body: '{"test":true,"sensor":"{{sensor.name}}","value":"{{sensor.value}}"}' },
};

export function integrationRoutes(app: FastifyInstance) {
  route(app, { method: 'GET', url: '/api/v1/integrations', summary: 'Lista integrationer', tag: 'Integrationer' }, async ({ auth }) => {
    const rows = await db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.organizationId, auth.organizationId))
      .orderBy(schema.integrationConnections.createdAt);
    return { data: rows.map(publicConnection), notificationsMode: config.NOTIFICATIONS_MODE };
  });

  route(app, { method: 'POST', url: '/api/v1/integrations', summary: 'Skapa integration', tag: 'Integrationer', body: integrationInputSchema }, async ({ auth, body }) => {
    const [row] = await db
      .insert(schema.integrationConnections)
      .values({
        organizationId: auth.organizationId,
        type: body.type,
        name: body.name,
        mode: body.mode,
        enabled: body.enabled,
        encryptedConfig: prepareConnectionConfig(body.type, body.config),
      })
      .returning();
    await audit(auth.organizationId, 'integration.create', 'integration', row!.id, { type: body.type });
    return publicConnection(row!);
  });

  route(
    app,
    {
      method: 'PATCH',
      url: '/api/v1/integrations/:id',
      summary: 'Uppdatera integration (tomma hemliga fält behåller sparat värde)',
      tag: 'Integrationer',
      body: integrationInputSchema.omit({ type: true }).partial(),
    },
    async ({ auth, params, body, req }) => {
      const conn = await loadConnection(auth.organizationId, uuidParam(params));
      const sent = new Set(Object.keys((req.body as object) ?? {}));
      const patch: Partial<typeof schema.integrationConnections.$inferInsert> = {};
      if (sent.has('name') && body.name !== undefined) patch.name = body.name;
      if (sent.has('mode') && body.mode !== undefined) patch.mode = body.mode;
      if (sent.has('enabled') && body.enabled !== undefined) patch.enabled = body.enabled;
      if (sent.has('config') && body.config) patch.encryptedConfig = prepareConnectionConfig(conn.type, body.config, connectionConfig(conn));
      const [row] = await db.update(schema.integrationConnections).set(patch).where(eq(schema.integrationConnections.id, conn.id)).returning();
      await audit(auth.organizationId, 'integration.update', 'integration', conn.id, { fields: Object.keys(body) });
      return publicConnection(row!);
    },
  );

  route(app, { method: 'DELETE', url: '/api/v1/integrations/:id', summary: 'Ta bort integration', tag: 'Integrationer' }, async ({ auth, params }) => {
    const conn = await loadConnection(auth.organizationId, uuidParam(params));
    const [used] = await db.select({ id: schema.automationActions.id }).from(schema.automationActions).where(eq(schema.automationActions.integrationConnectionId, conn.id)).limit(1);
    if (used) throw conflict('Integrationen används av en automatisering. Ta bort åtgärden först.');
    await db.delete(schema.integrationConnections).where(eq(schema.integrationConnections.id, conn.id));
    await audit(auth.organizationId, 'integration.delete', 'integration', conn.id, { type: conn.type });
  });

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/integrations/:id/test',
      summary: 'Skicka test',
      tag: 'Integrationer',
      body: z.object({ action: z.record(z.string(), z.unknown()).default({}) }),
    },
    async ({ auth, params, body }) => {
      const conn = await loadConnection(auth.organizationId, uuidParam(params));
      const actionConfig = { ...(sampleActions[conn.type] as object), ...body.action };
      const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, auth.organizationId));
      const now = new Date();
      const ctx = {
        template: {
          'camera.name': 'Testkamera',
          'zone.name': 'Testzon',
          'sensor.name': 'Testsensor',
          'sensor.value': 'available',
          'sensor.valueLabel': 'Ledig',
          'sensor.previousValue': 'occupied',
          'sensor.previousValueLabel': 'Upptagen',
          'event.id': 'test',
          'event.type': 'Test',
          'event.timestamp': formatTimestamp(now, org?.timezone ?? 'Europe/Stockholm'),
          'rule.name': 'Test',
        },
        payload: { event: { id: 'test', type: 'test', test: true, occurredAt: now.toISOString(), previousValue: 'occupied', currentValue: 'available' } },
      };
      const parsed = actionConfigSchemas[conn.type].safeParse(actionConfig);
      const outcome = parsed.success
        ? await deliver(conn, conn.type, parsed.data, ctx)
        : { ok: false, simulated: false, destination: '', preview: {}, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), retryable: false };
      await db.insert(schema.actionExecutions).values({
        organizationId: auth.organizationId,
        integrationConnectionId: conn.id,
        integrationType: conn.type,
        isTest: true,
        simulated: outcome.simulated,
        status: outcome.ok ? 'delivered' : 'failed',
        attempts: 1,
        destination: outcome.destination,
        payloadPreview: outcome.preview,
        responseCode: 'responseCode' in outcome ? (outcome.responseCode ?? null) : null,
        errorMessage: outcome.error ?? null,
        completedAt: new Date(),
      });
      return outcome;
    },
  );

  route(
    app,
    {
      method: 'GET',
      url: '/api/v1/deliveries',
      summary: 'Leveranshistorik',
      tag: 'Integrationer',
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().datetime().optional(),
        status: z.enum(deliveryStatuses).optional(),
        type: z.enum(integrationTypes).optional(),
        eventId: z.string().uuid().optional(),
      }),
    },
    async ({ auth, query }) => {
      const where: SQL[] = [eq(schema.actionExecutions.organizationId, auth.organizationId)];
      if (query.cursor) where.push(lt(schema.actionExecutions.createdAt, new Date(query.cursor)));
      if (query.status) where.push(eq(schema.actionExecutions.status, query.status));
      if (query.type) where.push(eq(schema.actionExecutions.integrationType, query.type));
      if (query.eventId) where.push(eq(schema.actionExecutions.eventId, query.eventId));
      const rows = await db
        .select({ exec: schema.actionExecutions, connectionName: schema.integrationConnections.name, ruleName: schema.automationRules.name })
        .from(schema.actionExecutions)
        .leftJoin(schema.integrationConnections, eq(schema.integrationConnections.id, schema.actionExecutions.integrationConnectionId))
        .leftJoin(schema.automationRules, eq(schema.automationRules.id, schema.actionExecutions.ruleId))
        .where(and(...where))
        .orderBy(desc(schema.actionExecutions.createdAt))
        .limit(query.limit);
      const data = rows.map((r) => ({ ...r.exec, connectionName: r.connectionName, ruleName: r.ruleName }));
      const last = data[data.length - 1];
      return { data, nextCursor: data.length === query.limit && last ? last.createdAt.toISOString() : null };
    },
  );
}
