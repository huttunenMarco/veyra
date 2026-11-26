import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatSensorValue, isValidValue, type SensorValue } from '@veyra/shared';
import { visionSettings } from '../../vision';
import { db, schema } from '../../db/client';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { recordUsage, runVision } from '../../services/analysis';
import { createExample, deleteStoredFiles, examplesForVision, renderExample } from '../../services/examples';
import { readFrame } from '../../services/frames';
import { loadFrame, loadSensor } from '../loaders';
import { route, uuidParam } from '../route';

type Sensor = typeof schema.sensors.$inferSelect;
const valueSchema = z.union([z.string(), z.number(), z.boolean()]);

async function zoneGeometry(sensor: Sensor) {
  if (!sensor.zoneId) return { zone: null, geometry: null };
  const [zone] = await db.select().from(schema.zones).where(eq(schema.zones.id, sensor.zoneId));
  return { zone: zone ?? null, geometry: zone?.geometry ?? null };
}

/**
 * The answer the user says is correct for a reviewed observation: the observed value when marked
 * correct, otherwise the corrected value, or the only other value for two-valued sensors.
 */
export function expectedValue(sensor: Pick<Sensor, 'outputType' | 'outputConfig'>, observed: SensorValue | null, correct: boolean, corrected: SensorValue | null): SensorValue | null {
  if (correct) return observed;
  if (corrected !== null) return corrected;
  if (observed === null) return null;
  if (sensor.outputType === 'boolean') return !observed;
  const values = sensor.outputConfig.allowedValues ?? [];
  if (sensor.outputType === 'enum' && values.length === 2) return values.find((v) => v !== observed) ?? null;
  return null;
}

export function exampleRoutes(app: FastifyInstance) {
  route(app, { method: 'GET', url: '/api/v1/sensors/:id/examples', summary: 'Lista referensbilder', tag: 'Sensorer' }, async ({ auth, params }) => {
    const sensor = await loadSensor(auth.organizationId, uuidParam(params));
    const rows = await db
      .select()
      .from(schema.sensorExamples)
      .where(eq(schema.sensorExamples.sensorId, sensor.id))
      .orderBy(desc(schema.sensorExamples.createdAt));
    return {
      data: rows.map(({ storageKey: _k, ...r }) => ({ ...r, valueLabel: formatSensorValue(sensor, r.value) })),
      useExamples: sensor.useExamples,
    };
  });

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/sensors/:id/examples',
      summary: 'Spara en bild som referensbild för ett läge',
      tag: 'Sensorer',
      body: z.object({ frameId: z.string().uuid(), value: valueSchema, note: z.string().trim().max(300).default('') }),
    },
    async ({ auth, params, body }) => {
      const sensor = await loadSensor(auth.organizationId, uuidParam(params));
      if (!isValidValue(sensor, body.value)) throw badRequest('Värdet är inte giltigt för sensorn');
      const frame = await loadFrame(auth.organizationId, body.frameId);
      const { storageKey: _k, ...example } = await createExample(sensor, frame, body.value, body.note);
      await audit(auth.organizationId, 'sensor_example.create', 'sensor', sensor.id, { value: body.value });
      return { ...example, valueLabel: formatSensorValue(sensor, example.value) };
    },
  );

  route(app, { method: 'DELETE', url: '/api/v1/sensors/:id/examples/:exampleId', summary: 'Ta bort referensbild', tag: 'Sensorer' }, async ({ auth, params }) => {
    const sensor = await loadSensor(auth.organizationId, uuidParam(params));
    const [row] = await db
      .delete(schema.sensorExamples)
      .where(and(eq(schema.sensorExamples.id, uuidParam(params, 'exampleId')), eq(schema.sensorExamples.sensorId, sensor.id)))
      .returning();
    if (!row) throw notFound('Referensbilden');
    await deleteStoredFiles([row.storageKey]);
  });

  route(
    app,
    { method: 'GET', url: '/api/v1/sensors/:id/examples/:exampleId/image', summary: 'Referensbild (utsnitt av zonen)', tag: 'Sensorer' },
    async ({ auth, params, reply }) => {
      const sensor = await loadSensor(auth.organizationId, uuidParam(params));
      const [row] = await db
        .select()
        .from(schema.sensorExamples)
        .where(and(eq(schema.sensorExamples.id, uuidParam(params, 'exampleId')), eq(schema.sensorExamples.sensorId, sensor.id)));
      if (!row) throw notFound('Referensbilden');
      const { geometry } = await zoneGeometry(sensor);
      const image = await renderExample(row, geometry).catch(() => null);
      if (!image) throw notFound('Bilden');
      reply.header('Cache-Control', 'private, max-age=60').type('image/jpeg').send(image);
    },
  );

  route(
    app,
    {
      method: 'POST',
      url: '/api/v1/sensors/:id/evaluate',
      summary: 'Testa en instruktion mot bedömda observationer (👍/👎)',
      tag: 'Sensorer',
      body: z.object({
        instruction: z.string().trim().min(5).max(4000).optional(),
        useExamples: z.boolean().default(true),
        limit: z.number().int().min(1).max(20).default(10),
      }),
    },
    async ({ auth, params, body }) => {
      const sensor = await loadSensor(auth.organizationId, uuidParam(params));
      const reviewed = await db
        .select({ obs: schema.sensorObservations, fb: schema.sensorFeedback, frame: schema.cameraFrames })
        .from(schema.sensorFeedback)
        .innerJoin(schema.sensorObservations, eq(schema.sensorObservations.id, schema.sensorFeedback.observationId))
        .innerJoin(schema.cameraFrames, eq(schema.cameraFrames.id, schema.sensorObservations.frameId))
        .where(and(eq(schema.sensorObservations.sensorId, sensor.id), isNull(schema.cameraFrames.deletedAt)))
        .orderBy(desc(schema.sensorObservations.observedAt))
        .limit(body.limit * 2);

      const exampleFrameIds = (
        await db.select({ f: schema.sensorExamples.sourceFrameId }).from(schema.sensorExamples).where(eq(schema.sensorExamples.sensorId, sensor.id))
      ).map((r) => r.f);
      // Frames that are themselves reference images would make the test trivially easy.
      const cases = reviewed
        .filter((r) => !exampleFrameIds.includes(r.frame.id))
        .map((r) => ({ ...r, expected: expectedValue(sensor, r.obs.value, r.fb.correct, r.fb.correctedValue ?? null) }))
        .filter((r) => r.expected !== null)
        .slice(0, body.limit);
      if (cases.length === 0) {
        throw badRequest('Inga bedömda bilder att testa mot. Markera några observationer med 👍 eller 👎 först.');
      }

      const { zone, geometry } = await zoneGeometry(sensor);
      const examples = body.useExamples ? await examplesForVision(sensor, geometry, { force: true }) : [];
      const instruction = body.instruction ?? sensor.instruction;

      const results = [];
      for (const c of cases) {
        const r = await runVision(await readFrame(c.frame), {
          spec: { outputType: sensor.outputType, outputConfig: sensor.outputConfig },
          instruction,
          sensorId: sensor.id,
          zone,
          includeFullImageContext: sensor.includeFullImageContext,
          examples,
        });
        await recordUsage(sensor.organizationId, sensor.id, r);
        results.push({
          observationId: c.obs.id,
          frameId: c.frame.id,
          observedAt: c.obs.observedAt,
          expected: c.expected,
          expectedLabel: formatSensorValue(sensor, c.expected),
          got: r.value,
          gotLabel: r.value === null ? 'Okänd' : formatSensorValue(sensor, r.value),
          status: r.status,
          reason: r.reason,
          correct: r.status === 'confirmed' && r.value === c.expected,
        });
      }
      const correct = results.filter((r) => r.correct).length;
      return {
        provider: (await visionSettings()).provider,
        instruction,
        examplesUsed: examples.length,
        total: results.length,
        correct,
        accuracy: correct / results.length,
        results,
      };
    },
  );
}
