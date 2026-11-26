import { desc, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { formatSensorValue, type SensorValue, type ZoneGeometry } from '@veyra/shared';
import { db, schema } from '../db/client';
import { badRequest } from '../lib/errors';
import { storage } from '../lib/storage';
import type { VisionExample } from '../vision/provider';
import { cropZone } from './crop';
import { readFrame, type Frame } from './frames';

type Sensor = typeof schema.sensors.$inferSelect;
export type SensorExample = typeof schema.sensorExamples.$inferSelect;

/** Bounds on what is sent per analysis: keeps prompts (and cost) predictable. */
export const MAX_EXAMPLES_PER_VALUE = 3;
export const MAX_EXAMPLES_TOTAL = 8;
const EXAMPLE_MAX_SIDE = 512;

/** Store a labeled copy of a frame as a reference image for a sensor. */
export async function createExample(sensor: Sensor, frame: Frame, value: SensorValue, note = ''): Promise<SensorExample> {
  if (frame.cameraId !== sensor.cameraId) throw badRequest('Bilden kommer från en annan kamera');
  const existing = await db.select().from(schema.sensorExamples).where(eq(schema.sensorExamples.sensorId, sensor.id));
  if (existing.filter((e) => e.value === value).length >= MAX_EXAMPLES_PER_VALUE) {
    throw badRequest(`Max ${MAX_EXAMPLES_PER_VALUE} referensbilder per läge. Ta bort en först.`);
  }
  if (existing.some((e) => e.sourceFrameId === frame.id)) throw badRequest('Bilden används redan som referensbild');

  const data = await readFrame(frame);
  const id = crypto.randomUUID();
  const storageKey = `examples/${sensor.organizationId}/${sensor.id}/${id}.jpg`;
  await storage.put(storageKey, data);
  const [row] = await db
    .insert(schema.sensorExamples)
    .values({ id, sensorId: sensor.id, value, note, storageKey, width: frame.width, height: frame.height, sourceFrameId: frame.id, capturedAt: frame.capturedAt })
    .returning();
  return row!;
}

/** Balanced selection: newest first, at most N per value and M in total. */
export function selectExamples<T extends { value: SensorValue }>(rows: T[]): T[] {
  const perValue = new Map<string, number>();
  const out: T[] = [];
  for (const r of rows) {
    const k = JSON.stringify(r.value);
    const n = perValue.get(k) ?? 0;
    if (n >= MAX_EXAMPLES_PER_VALUE || out.length >= MAX_EXAMPLES_TOTAL) continue;
    perValue.set(k, n + 1);
    out.push(r);
  }
  return out;
}

/** Example image as the model sees it: cropped to the sensor's current zone, downscaled. */
export async function renderExample(example: SensorExample, geometry: ZoneGeometry | null): Promise<Buffer> {
  const full = await storage.get(example.storageKey);
  const crop = await cropZone(full, geometry);
  return sharp(crop).resize({ width: EXAMPLE_MAX_SIDE, height: EXAMPLE_MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

/** Reference images to send with an analysis. Empty when the sensor has none or has them turned off. */
export async function examplesForVision(
  sensor: Pick<Sensor, 'id' | 'outputType' | 'outputConfig'> & { useExamples: boolean },
  geometry: ZoneGeometry | null,
  opts: { excludeFrameIds?: string[]; force?: boolean } = {},
): Promise<VisionExample[]> {
  if (!sensor.useExamples && !opts.force) return [];
  const rows = await db
    .select()
    .from(schema.sensorExamples)
    .where(eq(schema.sensorExamples.sensorId, sensor.id))
    .orderBy(desc(schema.sensorExamples.createdAt));
  const usable = rows.filter((r) => !r.sourceFrameId || !opts.excludeFrameIds?.includes(r.sourceFrameId));
  const out: VisionExample[] = [];
  for (const r of selectExamples(usable)) {
    try {
      out.push({ image: await renderExample(r, geometry), value: r.value, label: formatSensorValue(sensor, r.value), note: r.note || undefined });
    } catch {
      // Missing file or zone no longer inside the image: skip rather than fail the analysis.
    }
  }
  return out;
}

/** Storage keys of examples about to be deleted via cascade (camera/zone/sensor deletion). */
export async function exampleKeysForSensors(sensorIds: string[]): Promise<string[]> {
  if (sensorIds.length === 0) return [];
  const rows = await db
    .select({ key: schema.sensorExamples.storageKey })
    .from(schema.sensorExamples)
    .where(inArray(schema.sensorExamples.sensorId, sensorIds));
  return rows.map((r) => r.key);
}

export async function deleteStoredFiles(keys: string[]) {
  await Promise.all(keys.map((k) => storage.delete(k).catch(() => {})));
}
