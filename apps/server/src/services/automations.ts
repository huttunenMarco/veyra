import { and, eq, or } from 'drizzle-orm';
import { eventMatchesRule, inCooldown, type TriggerEvent } from '@veyra/shared';
import { db, schema } from '../db/client';
import { enqueueDelivery } from '../queue';

type Event = typeof schema.events.$inferSelect;

/**
 * Evaluate all enabled rules against an event. Idempotent: (event, rule) runs and
 * (event, action) executions are unique, so re-processing never duplicates notifications.
 */
export async function processEvent(eventId: string): Promise<{ matched: number }> {
  const [event] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  if (!event) return { matched: 0 };

  const ruleIdFromMeta = typeof event.metadata.ruleId === 'string' ? event.metadata.ruleId : null;
  const scope = [];
  if (event.sensorId) scope.push(eq(schema.automationRules.sensorId, event.sensorId));
  if (event.cameraId) scope.push(eq(schema.automationRules.cameraId, event.cameraId));
  if (ruleIdFromMeta) scope.push(eq(schema.automationRules.id, ruleIdFromMeta));
  if (scope.length === 0) return { matched: 0 };

  const rules = await db
    .select()
    .from(schema.automationRules)
    .where(and(eq(schema.automationRules.organizationId, event.organizationId), eq(schema.automationRules.enabled, true), or(...scope)));

  const trigger: TriggerEvent = {
    type: event.eventType,
    sensorId: event.sensorId,
    cameraId: event.cameraId,
    previousValue: event.previousValue ?? null,
    currentValue: event.currentValue ?? null,
    metadata: event.metadata,
  };

  let matched = 0;
  for (const rule of rules) {
    const isTestForRule = event.eventType === 'test' && ruleIdFromMeta === rule.id;
    if (!isTestForRule && !eventMatchesRule({ id: rule.id, sensorId: rule.sensorId, cameraId: rule.cameraId, trigger: rule.trigger }, trigger)) {
      continue;
    }
    matched++;
    await runRule(rule, event, isTestForRule);
  }
  return { matched };
}

async function runRule(rule: typeof schema.automationRules.$inferSelect, event: Event, isTest: boolean) {
  const now = new Date();
  const cooling = !isTest && inCooldown(rule.lastFiredAt, rule.cooldownSeconds, now);

  const [run] = await db
    .insert(schema.automationRuns)
    .values({ eventId: event.id, ruleId: rule.id, status: cooling ? 'skipped_cooldown' : 'executed' })
    .onConflictDoNothing()
    .returning();
  if (!run || cooling) return;

  if (!isTest) await db.update(schema.automationRules).set({ lastFiredAt: now }).where(eq(schema.automationRules.id, rule.id));

  const actions = await db
    .select({ action: schema.automationActions, connection: schema.integrationConnections })
    .from(schema.automationActions)
    .innerJoin(schema.integrationConnections, eq(schema.integrationConnections.id, schema.automationActions.integrationConnectionId))
    .where(and(eq(schema.automationActions.ruleId, rule.id), eq(schema.automationActions.enabled, true)))
    .orderBy(schema.automationActions.ordering);

  for (const { action, connection } of actions) {
    const [exec] = await db
      .insert(schema.actionExecutions)
      .values({
        organizationId: rule.organizationId,
        eventId: event.id,
        ruleId: rule.id,
        actionId: action.id,
        integrationConnectionId: connection.id,
        integrationType: connection.type,
        isTest,
        status: connection.enabled ? 'pending' : 'failed',
        errorMessage: connection.enabled ? null : 'Integrationen är inaktiverad',
      })
      .onConflictDoNothing()
      .returning();
    if (exec && connection.enabled) await enqueueDelivery(exec.id);
  }
}
