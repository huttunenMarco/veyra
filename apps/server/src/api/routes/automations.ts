import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { automationInputSchema, type AutomationInput } from '@veyra/shared';
import { db, schema } from '../../db/client';
import { audit } from '../../lib/audit';
import { badRequest } from '../../lib/errors';
import { enqueueAutomation } from '../../queue';
import { createEvent } from '../../services/events';
import { validateActionConfig } from '../../services/integrations';
import { loadCamera, loadConnection, loadRule, loadSensor } from '../loaders';
import { route, uuidParam } from '../route';

async function validateRule(orgId: string, input: AutomationInput) {
  const t = input.trigger.type;
  if (t === 'camera_offline') {
    if (!input.cameraId) throw badRequest('Välj en kamera för offline-regeln');
    await loadCamera(orgId, input.cameraId);
    input.sensorId = null;
  } else {
    if (!input.sensorId) throw badRequest('Välj en sensor');
    const sensor = await loadSensor(orgId, input.sensorId);
    input.cameraId = null;
    if (t === 'numeric_threshold' && sensor.outputType !== 'number') throw badRequest('Tröskelvärden kräver en numerisk sensor');
  }
  const actions = [];
  for (const [i, a] of input.actions.entries()) {
    const conn = await loadConnection(orgId, a.integrationConnectionId);
    actions.push({ ...a, actionType: conn.type, config: validateActionConfig(conn.type, a.config), ordering: i });
  }
  return actions;
}

async function withActions(rules: (typeof schema.automationRules.$inferSelect)[]) {
  if (rules.length === 0) return [];
  const actions = await db
    .select({ action: schema.automationActions, connectionName: schema.integrationConnections.name, connectionMode: schema.integrationConnections.mode })
    .from(schema.automationActions)
    .innerJoin(schema.integrationConnections, eq(schema.integrationConnections.id, schema.automationActions.integrationConnectionId))
    .where(inArray(schema.automationActions.ruleId, rules.map((r) => r.id)))
    .orderBy(schema.automationActions.ordering);
  return rules.map((r) => ({
    ...r,
    actions: actions.filter((a) => a.action.ruleId === r.id).map((a) => ({ ...a.action, connectionName: a.connectionName, connectionMode: a.connectionMode })),
  }));
}

async function saveActions(ruleId: string, actions: Awaited<ReturnType<typeof validateRule>>) {
  const existing = await db.select({ id: schema.automationActions.id }).from(schema.automationActions).where(eq(schema.automationActions.ruleId, ruleId));
  const keep = new Set(actions.map((a) => a.id).filter(Boolean));
  const remove = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (remove.length) await db.delete(schema.automationActions).where(inArray(schema.automationActions.id, remove));
  for (const a of actions) {
    const values = {
      ruleId,
      integrationConnectionId: a.integrationConnectionId,
      actionType: a.actionType,
      config: a.config,
      ordering: a.ordering,
      enabled: a.enabled,
    };
    if (a.id && existing.some((e) => e.id === a.id)) {
      await db.update(schema.automationActions).set(values).where(eq(schema.automationActions.id, a.id));
    } else {
      await db.insert(schema.automationActions).values(values);
    }
  }
}

export function automationRoutes(app: FastifyInstance) {
  route(app, { method: 'GET', url: '/api/v1/automations', summary: 'Lista automatiseringar', tag: 'Automatiseringar' }, async ({ auth }) => {
    const rules = await db
      .select()
      .from(schema.automationRules)
      .where(eq(schema.automationRules.organizationId, auth.organizationId))
      .orderBy(schema.automationRules.createdAt);
    return { data: await withActions(rules) };
  });

  route(app, { method: 'GET', url: '/api/v1/automations/:id', summary: 'Hämta automatisering', tag: 'Automatiseringar' }, async ({ auth, params }) => {
    const rule = await loadRule(auth.organizationId, uuidParam(params));
    const [full] = await withActions([rule]);
    return full;
  });

  route(app, { method: 'POST', url: '/api/v1/automations', summary: 'Skapa automatisering', tag: 'Automatiseringar', body: automationInputSchema }, async ({ auth, body }) => {
    const actions = await validateRule(auth.organizationId, body);
    const [rule] = await db
      .insert(schema.automationRules)
      .values({
        organizationId: auth.organizationId,
        name: body.name,
        description: body.description,
        sensorId: body.sensorId,
        cameraId: body.cameraId,
        triggerType: body.trigger.type,
        trigger: body.trigger,
        cooldownSeconds: body.cooldownSeconds,
        enabled: body.enabled,
      })
      .returning();
    await saveActions(rule!.id, actions);
    await audit(auth.organizationId, 'automation.create', 'automation', rule!.id, { name: rule!.name });
    return (await withActions([rule!]))[0];
  });

  route(
    app,
    { method: 'PATCH', url: '/api/v1/automations/:id', summary: 'Uppdatera automatisering', tag: 'Automatiseringar', body: automationInputSchema.partial() },
    async ({ auth, params, body, req }) => {
      const rule = await loadRule(auth.organizationId, uuidParam(params));
      const [current] = await withActions([rule]);
      // Zod fills defaults for omitted fields; only merge keys the client actually sent.
      const sent = new Set(Object.keys((req.body as object) ?? {}));
      const merged = automationInputSchema.parse({
        name: rule.name,
        description: rule.description,
        sensorId: rule.sensorId,
        cameraId: rule.cameraId,
        trigger: rule.trigger,
        cooldownSeconds: rule.cooldownSeconds,
        enabled: rule.enabled,
        actions: current!.actions.map((a) => ({ id: a.id, integrationConnectionId: a.integrationConnectionId, config: a.config, enabled: a.enabled })),
        ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && sent.has(k))),
      });
      const actions = await validateRule(auth.organizationId, merged);
      const [updated] = await db
        .update(schema.automationRules)
        .set({
          name: merged.name,
          description: merged.description,
          sensorId: merged.sensorId,
          cameraId: merged.cameraId,
          triggerType: merged.trigger.type,
          trigger: merged.trigger,
          cooldownSeconds: merged.cooldownSeconds,
          enabled: merged.enabled,
        })
        .where(eq(schema.automationRules.id, rule.id))
        .returning();
      if (sent.has('actions')) await saveActions(rule.id, actions);
      await audit(auth.organizationId, 'automation.update', 'automation', rule.id, {});
      return (await withActions([updated!]))[0];
    },
  );

  route(app, { method: 'DELETE', url: '/api/v1/automations/:id', summary: 'Ta bort automatisering', tag: 'Automatiseringar' }, async ({ auth, params }) => {
    const rule = await loadRule(auth.organizationId, uuidParam(params));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
    await audit(auth.organizationId, 'automation.delete', 'automation', rule.id, { name: rule.name });
  });

  route(app, { method: 'POST', url: '/api/v1/automations/:id/test', summary: 'Kör automatiseringens åtgärder som test', tag: 'Automatiseringar' }, async ({ auth, params }) => {
    const rule = await loadRule(auth.organizationId, uuidParam(params));
    const [state] = rule.sensorId ? await db.select().from(schema.sensorStates).where(eq(schema.sensorStates.sensorId, rule.sensorId)) : [];
    const t = rule.trigger;
    const event = await createEvent({
      organizationId: auth.organizationId,
      eventType: 'test',
      dedupeKey: `test:${rule.id}:${crypto.randomUUID()}`,
      sensorId: rule.sensorId,
      cameraId: rule.cameraId,
      // Wildcards ("any value") fall back to the sensor's current state so the test message reads naturally.
      previousValue: t.type === 'state_transition' ? (t.from ?? null) : (state?.value ?? null),
      currentValue: t.type === 'state_transition' ? (t.to ?? state?.value ?? null) : 'value' in t ? t.value : (state?.value ?? null),
      metadata: { ruleId: rule.id, test: true },
    });
    await enqueueAutomation(event!.id);
    return { eventId: event!.id };
  });

  route(app, { method: 'GET', url: '/api/v1/automations/:id/executions', summary: 'Körhistorik', tag: 'Automatiseringar' }, async ({ auth, params }) => {
    const rule = await loadRule(auth.organizationId, uuidParam(params));
    const data = await db
      .select()
      .from(schema.actionExecutions)
      .where(and(eq(schema.actionExecutions.ruleId, rule.id), eq(schema.actionExecutions.organizationId, auth.organizationId)))
      .orderBy(desc(schema.actionExecutions.createdAt))
      .limit(100);
    return { data };
  });
}
