import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  formatSensorValue,
  isValidValue,
  observationStatuses,
  outputConfigSchema,
  outputTypes,
  sensorInputSchema,
} from '@veyra/shared';
import { visionSettings } from '../../vision';
import { db, schema } from '../../db/client';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { analyzeSensorFrame, recordObservation, recordUsage, runVision } from '../../services/analysis';
import { deleteStoredFiles, exampleKeysForSensors, examplesForVision } from '../../services/examples';
import { captureNow } from '../../services/capture';
import { duplicateFrame, latestFrame, readFrame } from '../../services/frames';
import { staleAfterMs } from '../../services/scheduler';
import { loadCamera, loadSensor, loadZone } from '../loaders';
import { route, uuidParam } from '../route';

type Sensor = typeof schema.sensors.$inferSelect;
type State = typeof schema.sensorStates.$inferSelect;

export function publicState(sensor: Sensor, state: State | null) {
  const spec = { outputType: sensor.outputType, outputConfig: sensor.outputConfig };
  const value = state?.value ?? null;
  const status = state?.status ?? 'unknown';
  return {
    sensorId: sensor.id,
    value,
    valueLabel: status === 'unknown' ? 'Okänd' : formatSensorValue(spec, value),
    status,
    confirmedAt: state?.confirmedAt ?? null,
    lastObservationAt: state?.lastObservationAt ?? null,
    lastChangedAt: state?.lastChangedAt ?? null,
    pendingValue: state?.candidateValue ?? null,
    pendingCount: state?.candidateCount ?? 0,
    staleAfterSeconds: Math.round(staleAfterMs(sensor) / 1000),
  };
}

export async function sensorsWithState(orgId: string, filter: { cameraId?: string } = {}) {
  const where: SQL[] = [eq(schema.sensors.organizationId, orgId)];
  if (filter.cameraId) where.push(eq(schema.sensors.cameraId, filter.cameraId));
  const rows = await db
    .select({ sensor: schema.sensors, state: schema.sensorStates, zone: schema.zones, cameraName: schema.cameras.name })
    .from(schema.sensors)
    .innerJoin(schema.cameras, eq(schema.cameras.id, schema.sensors.cameraId))
    .leftJoin(schema.sensorStates, eq(schema.sensorStates.sensorId, schema.sensors.id))
    .leftJoin(schema.zones, eq(schema.zones.id, schema.sensors.zoneId))
    .where(and(...where))
    .orderBy(schema.sensors.createdAt);
  return rows.map(({ sensor, state, zone, cameraName }) => ({
    ...sensor,
    cameraName,
    zone: zone ? { id: zone.id, name: zone.name, color: zone.color } : null,
    state: publicState(sensor, state),
  }));
}

async function validateTarget(orgId: string, cameraId: string, zoneId: string | null | undefined) {
  await loadCamera(orgId, cameraId);
  if (zoneId) {
    const zone = await loadZone(orgId, zoneId);
    if (zone.cameraId !== cameraId) throw badRequest('Zonen tillhör en annan kamera');
  }
}

function parseSensor(input: unknown) {
  const r = sensorInputSchema.safeParse(input);
  if (!r.success) {
    throw badRequest('Valideringen misslyckades', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

const testAnalysisSchema = z.object({
  cameraId: z.string().uuid(),
  zoneId: z.string().uuid().nullable().optional(),
  instruction: z.string().trim().min(5).max(4000),
  outputType: z.enum(outputTypes),
  outputConfig: outputConfigSchema,
  includeFullImageContext: z.boolean().default(false),
  /** When editing an existing sensor: include its reference images. */
  sensorId: z.string().uuid().optional(),
  useExamples: z.boolean().default(true),
  /** Capture a new frame instead of using the latest one. */
  fresh: z.boolean().default(false),
});

export function sensorRoutes(app: FastifyInstance) {
  route(
    app,
    { method: 'GET', url: '/api/v1/sensors', summary: 'Lista sensorer med aktuellt tillstånd', tag: 'Sensorer', query: z.object({ cameraId: z.string().uuid().optional() }) },
    async ({ auth, query }) => ({ data: await sensorsWithState(auth.organizationId, query) }),
  );

  route(app, { method: 'POST', url: '/api/v1/sensors', summary: 'Skapa sensor', tag: 'Sensorer', body: z.record(z.string(), z.unknown()) }, async ({ auth, body }) => {
    const input = parseSensor(body);
    await validateTarget(auth.organizationId, input.cameraId, input.zoneId);
    const [sensor] = await db
      .insert(schema.sensors)
      .values({ ...input, zoneId: input.zoneId ?? null, organizationId: auth.organizationId })
      .returning();
    await db.insert(schema.sensorStates).values({ sensorId: sensor!.id }).onConflictDoNothing();
    await audit(auth.organizationId, 'sensor.create', 'sensor', sensor!.id, { name: sensor!.name });
    return sensor;
  });

  route(app, { method: 'GET', url: '/api/v1/sensors/:id', summary: 'Hämta sensor', tag: 'Sensorer' }, async ({ auth, params }) => {
    const sensor = await loadSensor(auth.organizationId, uuidParam(params));
    const [list] = (await sensorsWithState(auth.organizationId, { cameraId: sensor.cameraId })).filter((s) => s.id === sensor.id);
    return list;
  });

  route(
    app,
    { method: 'PATCH', url: '/api/v1/sensors/:id', summary: 'Uppdatera sensor (delvis)', tag: 'Sensorer', body: z.record(z.string(), z.unknown()) },
    async ({ auth, params, body }) => {
      const sensor = await loadSensor(auth.organizationId, uuidParam(params));
      const merged = parseSensor({
        cameraId: sensor.cameraId,
        zoneId: sensor.zoneId,
        name: sensor.name,
        description: sensor.description,
        instruction: sensor.instruction,
        outputType: sensor.outputType,
        outputConfig: sensor.outputConfig,
        intervalSeconds: sensor.intervalSeconds,
        includeFullImageContext: sensor.includeFullImageContext,
        useExamples: sensor.useExamples,
        enabled: sensor.enabled,
        stabilization: sensor.stabilization,
        ...body,
      });
      await validateTarget(auth.organizationId, merged.cameraId, merged.zoneId);
      const outputChanged =
        merged.outputType !== sensor.outputType ||
        JSON.stringify(merged.outputConfig.allowedValues ?? []) !== JSON.stringify(sensor.outputConfig.allowedValues ?? []);
      const [updated] = await db
        .update(schema.sensors)
        .set({ ...merged, zoneId: merged.zoneId ?? null })
        .where(eq(schema.sensors.id, sensor.id))
        .returning();
      if (outputChanged) {
        // Old state values are meaningless under a new output definition.
        await db
          .update(schema.sensorStates)
          .set({ value: null, status: 'unknown', confirmedAt: null, candidateValue: null, candidateCount: 0, updatedAt: new Date() })
          .where(eq(schema.sensorStates.sensorId, sensor.id));
      }
      return updated;
    },
  );

  route(app, { method: 'DELETE', url: '/api/v1/sensors/:id', summary: 'Ta bort sensor', tag: 'Sensorer' }, async ({ auth, params }) => {
    const sensor = await loadSensor(auth.organizationId, uuidParam(params));
    const files = await exampleKeysForSensors([sensor.id]);
    await db.delete(schema.sensors).where(eq(schema.sensors.id, sensor.id));
    await deleteStoredFiles(files);
    await audit(auth.organizationId, 'sensor.delete', 'sensor', sensor.id, { name: sensor.name });
  });

  route(app, { method: 'POST', url: '/api/v1/sensors/:id/analyze', summary: 'Analysera nu (ny bild)', tag: 'Sensorer' }, async ({ auth, params }) => {
    const sensor = await loadSensor(auth.organizationId, uuidParam(params));
    const camera = await loadCamera(auth.organizationId, sensor.cameraId);
    const frame = await captureNow(camera, 'manual');
    await db.update(schema.sensors).set({ lastAnalysisRequestedAt: new Date() }).where(eq(schema.sensors.id, sensor.id));
    const observation = await analyzeSensorFrame(sensor.id, frame.id);
    const [state] = await db.select().from(schema.sensorStates).where(eq(schema.sensorStates.sensorId, sensor.id));
    return { observation, state: publicState(sensor, state ?? null), frameId: frame.id };
  });

  route(app, { method: 'GET', url: '/api/v1/sensors/:id/state', summary: 'Aktuellt bekräftat tillstånd', tag: 'Sensorer' }, async ({ auth, params }) => {
    const sensor = await loadSensor(auth.organizationId, uuidParam(params));
    const [state] = await db.select().from(schema.sensorStates).where(eq(schema.sensorStates.sensorId, sensor.id));
    return { ...publicState(sensor, state ?? null), sensorName: sensor.name };
  });

  route(
    app,
    {
      method: 'GET',
      url: '/api/v1/sensors/:id/history',
      summary: 'Observationshistorik',
      tag: 'Sensorer',
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().datetime().optional() }),
    },
    async ({ auth, params, query }) => {
      const sensor = await loadSensor(auth.organizationId, uuidParam(params));
      const where: SQL[] = [eq(schema.sensorObservations.sensorId, sensor.id)];
      if (query.cursor) where.push(lt(schema.sensorObservations.observedAt, new Date(query.cursor)));
      const rows = await db
        .select({ obs: schema.sensorObservations, feedback: schema.sensorFeedback, frameDeleted: schema.cameraFrames.deletedAt })
        .from(schema.sensorObservations)
        .leftJoin(schema.sensorFeedback, eq(schema.sensorFeedback.observationId, schema.sensorObservations.id))
        .leftJoin(schema.cameraFrames, eq(schema.cameraFrames.id, schema.sensorObservations.frameId))
        .where(and(...where))
        .orderBy(desc(schema.sensorObservations.observedAt))
        .limit(query.limit);
      const data = rows.map(({ obs, feedback, frameDeleted }) => ({
        ...obs,
        snapshotAvailable: !!obs.frameId && !frameDeleted,
        feedback: feedback ? { correct: feedback.correct, correctedValue: feedback.correctedValue } : null,
      }));
      const last = data[data.length - 1];
      return { data, nextCursor: data.length === query.limit && last ? last.observedAt.toISOString() : null };
    },
  );

  route(
    app,
    { method: 'POST', url: '/api/v1/sensors/test-analysis', summary: 'Testa en instruktion utan att spara', tag: 'Sensorer', body: testAnalysisSchema },
    async ({ auth, body }) => {
      const camera = await loadCamera(auth.organizationId, body.cameraId);
      const zone = body.zoneId ? await loadZone(auth.organizationId, body.zoneId) : null;
      if (zone && zone.cameraId !== camera.id) throw badRequest('Zonen tillhör en annan kamera');
      if (body.outputType === 'enum' && (body.outputConfig.allowedValues?.length ?? 0) < 2) throw badRequest('Ange minst två möjliga värden');
      const frame = body.fresh ? await captureNow(camera, 'manual') : ((await latestFrame(camera.id)) ?? (await captureNow(camera, 'manual')));
      const existing = body.sensorId ? await loadSensor(auth.organizationId, body.sensorId) : null;
      const examples =
        existing && body.useExamples
          ? await examplesForVision({ ...existing, outputType: body.outputType, outputConfig: body.outputConfig }, zone?.geometry ?? null, { force: true })
          : [];
      const result = await runVision(await readFrame(frame), {
        spec: { outputType: body.outputType, outputConfig: body.outputConfig },
        instruction: body.instruction,
        sensorId: existing?.id ?? 'test',
        zone,
        includeFullImageContext: body.includeFullImageContext,
        examples,
      });
      await recordUsage(auth.organizationId, existing?.id ?? null, result);
      return { ...result, frameId: frame.id, provider: (await visionSettings()).provider, examplesUsed: examples.length };
    },
  );

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/sensors/:id/simulate',
      summary: 'Injicera en simulerad observation (för test av regler)',
      tag: 'Sensorer',
      body: z.object({
        value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
        status: z.enum(observationStatuses).default('confirmed'),
        reason: z.string().max(500).default('Simulerad observation'),
      }),
    },
    async ({ auth, params, body }) => {
      const sensor = await loadSensor(auth.organizationId, uuidParam(params));
      const spec = { outputType: sensor.outputType, outputConfig: sensor.outputConfig };
      if (body.value !== null && !isValidValue(spec, body.value)) throw badRequest('Värdet är inte giltigt för sensorn');
      const observation = await recordObservation(sensor, {
        frame: null,
        value: body.value,
        status: body.value === null && body.status === 'confirmed' ? 'unavailable' : body.status,
        reason: body.reason,
        simulated: true,
        modelId: 'simulated',
        observedAt: new Date(),
      });
      const [state] = await db.select().from(schema.sensorStates).where(eq(schema.sensorStates.sensorId, sensor.id));
      return { observation, state: publicState(sensor, state ?? null) };
    },
  );

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/observations/:id/reanalyze',
      summary: 'Kör AI-analysen igen på en observations bild, som om bilden togs nu',
      tag: 'Sensorer',
    },
    async ({ params }) => {
      const id = uuidParam(params);
      const [row] = await db
        .select({ obs: schema.sensorObservations, frame: schema.cameraFrames })
        .from(schema.sensorObservations)
        .leftJoin(schema.cameraFrames, eq(schema.cameraFrames.id, schema.sensorObservations.frameId))
        .where(eq(schema.sensorObservations.id, id));
      if (!row) throw notFound('Observationen');
      if (!row.frame || row.frame.deletedAt) throw badRequest('Bilden till observationen finns inte längre kvar');
      const copy = await duplicateFrame(row.frame);
      const observation = await analyzeSensorFrame(row.obs.sensorId, copy.id);
      const [state] = await db.select().from(schema.sensorStates).where(eq(schema.sensorStates.sensorId, row.obs.sensorId));
      const [sensor] = await db.select().from(schema.sensors).where(eq(schema.sensors.id, row.obs.sensorId));
      return { observation, state: publicState(sensor!, state ?? null) };
    },
  );

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/observations/:id/feedback',
      summary: 'Markera observation som korrekt/felaktig',
      tag: 'Sensorer',
      body: z.object({ correct: z.boolean(), correctedValue: z.union([z.string(), z.number(), z.boolean()]).nullable().default(null) }),
    },
    async ({ auth, params, body }) => {
      const id = uuidParam(params);
      const [row] = await db
        .select({ obs: schema.sensorObservations, sensor: schema.sensors })
        .from(schema.sensorObservations)
        .innerJoin(schema.sensors, eq(schema.sensors.id, schema.sensorObservations.sensorId))
        .where(and(eq(schema.sensorObservations.id, id), eq(schema.sensors.organizationId, auth.organizationId)));
      if (!row) throw badRequest('Observationen hittades inte');
      if (body.correctedValue !== null && !isValidValue(row.sensor, body.correctedValue)) {
        throw badRequest('Det rätta värdet är inte giltigt för sensorn');
      }
      const [fb] = await db
        .insert(schema.sensorFeedback)
        .values({ observationId: id, correct: body.correct, correctedValue: body.correctedValue })
        .onConflictDoUpdate({
          target: schema.sensorFeedback.observationId,
          set: { correct: body.correct, correctedValue: body.correctedValue, createdAt: new Date() },
        })
        .returning();
      return fb;
    },
  );
}
