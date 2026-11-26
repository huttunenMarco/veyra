import { eq } from 'drizzle-orm';
import type { IntegrationType } from '@veyra/shared';
import { config } from '../config';
import { db, schema } from '../db/client';
import { errorMessage } from '../lib/errors';
import { providers } from '../integrations/providers';
import { DeliveryError, type EventContext } from '../integrations/types';
import { buildEventContext } from './context';
import { connectionConfig } from './integrations';

type Connection = typeof schema.integrationConnections.$inferSelect;

export interface DeliveryOutcome {
  ok: boolean;
  simulated: boolean;
  destination: string;
  preview: Record<string, unknown>;
  responseCode?: number;
  error?: string;
  retryable: boolean;
}

export function isSimulated(connection: Connection): boolean {
  return connection.mode === 'simulated' || config.NOTIFICATIONS_MODE === 'simulate';
}

/** Render and (unless simulated) send one action. Never throws. */
export async function deliver(
  connection: Connection,
  type: IntegrationType,
  actionConfig: unknown,
  ctx: EventContext,
): Promise<DeliveryOutcome> {
  const provider = providers[type];
  const simulated = isSimulated(connection);
  let destination = '';
  let preview: Record<string, unknown> = {};
  try {
    const conn = provider.validateConfig(connectionConfig(connection));
    const action = provider.validateAction(actionConfig);
    ({ destination, preview } = provider.render(conn, action, ctx));
    if (simulated) return { ok: true, simulated, destination, preview, retryable: false };
    const res = await provider.send(conn, action, ctx);
    return { ok: true, simulated, destination, preview, responseCode: res.responseCode, retryable: false };
  } catch (err) {
    const de = err instanceof DeliveryError ? err : new DeliveryError(errorMessage(err), true);
    return { ok: false, simulated, destination, preview, error: de.message.slice(0, 1000), responseCode: de.responseCode, retryable: de.retryable };
  }
}

/** Worker entry: execute an action execution row. Returns whether a retry should be attempted. */
export async function runExecution(executionId: string, attempt: number, maxAttempts: number): Promise<{ retry: boolean }> {
  const [row] = await db
    .select({ exec: schema.actionExecutions, action: schema.automationActions, connection: schema.integrationConnections, event: schema.events, rule: schema.automationRules })
    .from(schema.actionExecutions)
    .leftJoin(schema.automationActions, eq(schema.automationActions.id, schema.actionExecutions.actionId))
    .leftJoin(schema.integrationConnections, eq(schema.integrationConnections.id, schema.actionExecutions.integrationConnectionId))
    .leftJoin(schema.events, eq(schema.events.id, schema.actionExecutions.eventId))
    .leftJoin(schema.automationRules, eq(schema.automationRules.id, schema.actionExecutions.ruleId))
    .where(eq(schema.actionExecutions.id, executionId));
  if (!row || row.exec.status === 'delivered') return { retry: false };

  const fail = async (message: string) => {
    await db.update(schema.actionExecutions).set({ status: 'failed', errorMessage: message, completedAt: new Date() }).where(eq(schema.actionExecutions.id, executionId));
    return { retry: false };
  };
  if (!row.action || !row.connection || !row.event) return fail('Åtgärden, integrationen eller händelsen har tagits bort');

  await db
    .update(schema.actionExecutions)
    .set({ status: 'processing', attempts: attempt })
    .where(eq(schema.actionExecutions.id, executionId));

  const ctx = await buildEventContext(row.event, row.rule?.name);
  const outcome = await deliver(row.connection, row.connection.type, row.action.config, ctx);
  const willRetry = !outcome.ok && outcome.retryable && attempt < maxAttempts;

  await db
    .update(schema.actionExecutions)
    .set({
      status: outcome.ok ? 'delivered' : willRetry ? 'retrying' : 'failed',
      simulated: outcome.simulated,
      destination: outcome.destination,
      payloadPreview: outcome.preview,
      responseCode: outcome.responseCode ?? null,
      errorMessage: outcome.error ?? null,
      completedAt: outcome.ok || !willRetry ? new Date() : null,
    })
    .where(eq(schema.actionExecutions.id, executionId));

  return { retry: willRetry };
}
