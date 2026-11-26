import { and, count, desc, eq, gte, sql, sum } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { settingsUpdateSchema } from '@veyra/shared';
import { config } from '../../config';
import { db, schema } from '../../db/client';
import { audit } from '../../lib/audit';
import { encryptJson } from '../../lib/crypto';
import { badRequest } from '../../lib/errors';
import { getInstance } from '../../services/instance';
import { resetVisionProvider, visionSettings } from '../../vision';
import { verifyOpenAIKey } from '../../vision/openai';
import { storage } from '../../lib/storage';
import { getQueue, QUEUE } from '../../queue';
import { route } from '../route';

async function aiInfo() {
  const s = await visionSettings();
  return {
    provider: s.provider,
    model: s.model,
    reasoningEffort: s.reasoningEffort,
    configured: !!s.apiKey,
    keySource: s.keySource,
    /** Settings fixed by environment variables can't be changed in the UI. */
    lockedByEnv: { apiKey: !!config.OPENAI_API_KEY, model: !!config.OPENAI_MODEL, reasoningEffort: config.OPENAI_REASONING_EFFORT !== undefined },
    inputCostPerMTok: config.OPENAI_INPUT_COST_PER_MTOK,
    outputCostPerMTok: config.OPENAI_OUTPUT_COST_PER_MTOK,
  };
}

function publicSettings(inst: typeof schema.organizations.$inferSelect) {
  const { openaiApiKeyEncrypted: _k, ...rest } = inst;
  return rest;
}

const aiUpdateSchema = z.object({
  /** Write-only. Empty string or null removes the saved key. */
  openaiApiKey: z.string().trim().max(500).nullable().optional(),
  openaiModel: z.string().trim().min(1).max(100).optional(),
  openaiReasoningEffort: z.enum(['', 'minimal', 'low', 'medium', 'high']).optional(),
});

export function settingsRoutes(app: FastifyInstance) {
  route(app, { method: 'GET', url: '/api/v1/instance', summary: 'Namn och status för installationen', tag: 'Inställningar' }, async () => {
    const inst = await getInstance();
    const [cams] = await db.select({ n: count() }).from(schema.cameras);
    return { name: inst.name, timezone: inst.timezone, aiConfigured: (await aiInfo()).configured, cameraCount: cams?.n ?? 0 };
  });

  route(app, { method: 'GET', url: '/api/v1/settings', summary: 'Inställningar', tag: 'Inställningar' }, async () => {
    return { organization: publicSettings(await getInstance()), ai: await aiInfo(), notificationsMode: config.NOTIFICATIONS_MODE };
  });

  route(app, { method: 'PATCH', url: '/api/v1/settings', summary: 'Uppdatera inställningar', tag: 'Inställningar', body: settingsUpdateSchema }, async ({ auth, body, req }) => {
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('sv-SE', { timeZone: body.timezone });
      } catch {
        throw badRequest('Okänd tidszon');
      }
    }
    // Only fields the client actually sent (the schema has no defaults, but be explicit).
    const sent = new Set(Object.keys((req.body as object) ?? {}));
    const patch = Object.fromEntries(Object.entries(body).filter(([k, v]) => sent.has(k) && v !== undefined));
    const [org] = await db.update(schema.organizations).set(patch).where(eq(schema.organizations.id, auth.organizationId)).returning();
    await audit(auth.organizationId, 'settings.update', 'organization', auth.organizationId, { fields: Object.keys(patch) });
    return publicSettings(org!);
  });

  route(app, { method: 'PATCH', url: '/api/v1/settings/ai', summary: 'Uppdatera AI-inställningar (OpenAI-nyckel, modell)', tag: 'Inställningar', body: aiUpdateSchema }, async ({ auth, body }) => {
    const patch: Partial<typeof schema.organizations.$inferInsert> = {};
    if (body.openaiApiKey !== undefined) {
      const key = body.openaiApiKey?.trim();
      if (key && !/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) throw badRequest('Det ser inte ut som en OpenAI-nyckel (ska börja med sk-)');
      patch.openaiApiKeyEncrypted = key ? encryptJson(key) : null;
    }
    if (body.openaiModel !== undefined) patch.openaiModel = body.openaiModel;
    if (body.openaiReasoningEffort !== undefined) patch.openaiReasoningEffort = body.openaiReasoningEffort;
    if (Object.keys(patch).length) {
      await db.update(schema.organizations).set(patch).where(eq(schema.organizations.id, auth.organizationId));
    }
    resetVisionProvider();
    await audit(auth.organizationId, 'settings.ai_update', 'organization', auth.organizationId, {
      fields: Object.keys(body),
      keyChanged: body.openaiApiKey !== undefined,
    });
    return aiInfo();
  });

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/settings/ai/test',
      summary: 'Testa OpenAI-nyckel och modell',
      tag: 'Inställningar',
      body: z.object({ openaiApiKey: z.string().trim().max(500).optional(), openaiModel: z.string().trim().max(100).optional() }),
    },
    async ({ body }) => {
      const s = await visionSettings();
      const key = body.openaiApiKey || s.apiKey;
      if (!key) return { ok: false, error: 'Ingen nyckel angiven' };
      return verifyOpenAIKey(key, body.openaiModel || s.model);
    },
  );

  route(
    app,
    { method: 'GET', url: '/api/v1/settings/usage', summary: 'AI-användning', tag: 'Inställningar', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) },
    async ({ auth, query }) => {
      const since = new Date(Date.now() - query.days * 86_400_000);
      const where = and(eq(schema.aiUsage.organizationId, auth.organizationId), gte(schema.aiUsage.createdAt, since));
      const [totals] = await db
        .select({
          requests: count(),
          failures: sql<number>`count(*) filter (where not ${schema.aiUsage.success})`.mapWith(Number),
          inputTokens: sum(schema.aiUsage.inputTokens).mapWith(Number),
          outputTokens: sum(schema.aiUsage.outputTokens).mapWith(Number),
          cost: sum(schema.aiUsage.estimatedCostUsd).mapWith(Number),
        })
        .from(schema.aiUsage)
        .where(where);
      const daily = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${schema.aiUsage.createdAt}), 'YYYY-MM-DD')`,
          requests: count(),
          cost: sum(schema.aiUsage.estimatedCostUsd).mapWith(Number),
        })
        .from(schema.aiUsage)
        .where(where)
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      return { days: query.days, totals, daily };
    },
  );

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/settings/purge',
      summary: 'Radera lagrad data',
      tag: 'Inställningar',
      body: z.object({ target: z.enum(['snapshots', 'observations', 'events']) }),
    },
    async ({ auth, body }) => {
      let removed = 0;
      if (body.target === 'snapshots') {
        const frames = await db
          .select({ id: schema.cameraFrames.id, key: schema.cameraFrames.storageKey })
          .from(schema.cameraFrames)
          .innerJoin(schema.cameras, eq(schema.cameras.id, schema.cameraFrames.cameraId))
          .where(and(eq(schema.cameras.organizationId, auth.organizationId), sql`${schema.cameraFrames.deletedAt} is null`));
        for (const f of frames) {
          await storage.delete(f.key).catch(() => {});
          await db.update(schema.cameraFrames).set({ deletedAt: new Date() }).where(eq(schema.cameraFrames.id, f.id));
        }
        removed = frames.length;
      } else if (body.target === 'observations') {
        const r = await db.execute(sql`delete from sensor_observations o using sensors s where o.sensor_id = s.id and s.organization_id = ${auth.organizationId}`);
        removed = r.count ?? 0;
      } else {
        const r = await db.delete(schema.events).where(eq(schema.events.organizationId, auth.organizationId)).returning({ id: schema.events.id });
        removed = r.length;
      }
      await audit(auth.organizationId, 'data.purge', body.target, null, { removed });
      return { removed };
    },
  );

  route(app, { method: 'GET', url: '/api/v1/settings/audit', summary: 'Granskningslogg', tag: 'Inställningar' }, async ({ auth }) => {
    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, auth.organizationId))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(100);
    return { data: rows };
  });

  route(app, { method: 'GET', url: '/api/v1/system/queues', summary: 'Kö-status och misslyckade jobb', tag: 'Inställningar' }, async () => {
    const result: Record<string, unknown> = {};
    for (const name of Object.values(QUEUE)) {
      const q = getQueue(name);
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      const failed = await q.getFailed(0, 9);
      result[name] = {
        counts,
        failed: failed.map((j) => ({ id: j.id, name: j.name, failedReason: j.failedReason, attemptsMade: j.attemptsMade, timestamp: j.timestamp })),
      };
    }
    return result;
  });
}
