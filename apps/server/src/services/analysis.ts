import { and, eq } from 'drizzle-orm';
import {
  applyObservation,
  initialState,
  type EngineEvent,
  type EngineState,
  type ObservationStatus,
  type SensorOutputSpec,
  type SensorValue,
} from '@veyra/shared';
import { db, schema } from '../db/client';
import { errorMessage } from '../lib/errors';
import { enqueueAutomation } from '../queue';
import { estimateCostUsd, getVisionProvider } from '../vision';
import type { VisionAnalysisResult, VisionExample } from '../vision/provider';
import { contextImage, cropZone } from './crop';
import { createEvent } from './events';
import { examplesForVision } from './examples';
import { readFrame, type Frame } from './frames';

type Sensor = typeof schema.sensors.$inferSelect;
type Zone = typeof schema.zones.$inferSelect;
export type Observation = typeof schema.sensorObservations.$inferSelect;

export interface AnalyzeOptions {
  spec: SensorOutputSpec;
  instruction: string;
  sensorId: string;
  zone: Pick<Zone, 'name' | 'geometry'> | null;
  includeFullImageContext: boolean;
  /** Labeled reference images (already cropped to the zone). */
  examples?: VisionExample[];
}

/** Run the vision model on a frame without persisting anything. Never throws. */
export async function runVision(image: Buffer, opts: AnalyzeOptions): Promise<VisionAnalysisResult> {
  const started = Date.now();
  const provider = await getVisionProvider();
  try {
    const crop = await cropZone(image, opts.zone?.geometry ?? null);
    const ctx = opts.zone && opts.includeFullImageContext ? await contextImage(image) : undefined;
    return await provider.analyze({
      sensorId: opts.sensorId,
      instruction: opts.instruction,
      spec: opts.spec,
      image: crop,
      contextImage: ctx,
      zoneName: opts.zone?.name,
      examples: opts.examples,
    });
  } catch (err) {
    return {
      value: null,
      status: 'unavailable',
      reason: `Analysen misslyckades: ${errorMessage(err)}`.slice(0, 500),
      modelId: provider.name,
      simulated: provider.name === 'mock',
      durationMs: Date.now() - started,
    };
  }
}

/** Track real (non-simulated) model calls for usage and cost reporting. */
export async function recordUsage(organizationId: string, sensorId: string | null, result: VisionAnalysisResult) {
  if (result.simulated || result.modelId === 'none') return;
  await db.insert(schema.aiUsage).values({
    organizationId,
    sensorId,
    modelId: result.modelId,
    success: result.status !== 'unavailable',
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    estimatedCostUsd: estimateCostUsd(result.inputTokens, result.outputTokens),
  });
}

/** Analyze one sensor against one frame and feed the result into the state engine. Idempotent per (sensor, frame). */
export async function analyzeSensorFrame(
  sensorId: string,
  frameId: string,
  opts: { observedAt?: Date } = {},
): Promise<Observation | null> {
  const [row] = await db
    .select({ sensor: schema.sensors, zone: schema.zones })
    .from(schema.sensors)
    .leftJoin(schema.zones, eq(schema.zones.id, schema.sensors.zoneId))
    .where(eq(schema.sensors.id, sensorId));
  if (!row) return null;
  const { sensor, zone } = row;

  const [existing] = await db
    .select()
    .from(schema.sensorObservations)
    .where(and(eq(schema.sensorObservations.sensorId, sensorId), eq(schema.sensorObservations.frameId, frameId)));
  if (existing) return existing;

  const [frame] = await db.select().from(schema.cameraFrames).where(eq(schema.cameraFrames.id, frameId));
  if (!frame || frame.cameraId !== sensor.cameraId) return null;

  let result: VisionAnalysisResult;
  if (zone && !zone.enabled) {
    result = { value: null, status: 'unavailable', reason: 'Zonen är inaktiverad', modelId: 'none', simulated: false, durationMs: 0 };
  } else {
    const image = await readFrame(frame);
    result = await runVision(image, {
      spec: { outputType: sensor.outputType, outputConfig: sensor.outputConfig },
      instruction: sensor.instruction,
      sensorId: sensor.id,
      zone,
      includeFullImageContext: sensor.includeFullImageContext,
      examples: await examplesForVision(sensor, zone?.geometry ?? null, { excludeFrameIds: [frame.id] }),
    });
  }

  await recordUsage(sensor.organizationId, sensor.id, result);

  return recordObservation(sensor, {
    frame,
    value: result.value,
    status: result.status,
    reason: result.reason,
    simulated: result.simulated,
    modelId: result.modelId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    processingDurationMs: result.durationMs,
    observedAt: opts.observedAt ?? frame.capturedAt,
  });
}

export interface ObservationInput {
  frame: Frame | null;
  value: SensorValue | null;
  status: ObservationStatus;
  reason: string;
  simulated: boolean;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  processingDurationMs?: number;
  observedAt: Date;
}

function toEngine(s: typeof schema.sensorStates.$inferSelect): EngineState {
  return {
    value: s.value ?? null,
    status: s.status,
    confirmedAt: s.confirmedAt,
    lastObservationAt: s.lastObservationAt,
    candidateValue: s.candidateValue ?? null,
    candidateCount: s.candidateCount,
    consecutiveFailures: s.consecutiveFailures,
    consecutiveUncertain: s.consecutiveUncertain,
  };
}

function eventValues(e: EngineEvent): { previousValue: SensorValue | null; currentValue: SensorValue | null } {
  switch (e.type) {
    case 'state_changed':
      return { previousValue: e.previousValue, currentValue: e.currentValue };
    case 'sensor_unavailable':
      return { previousValue: e.lastValue, currentValue: null };
    case 'sensor_recovered':
      return { previousValue: null, currentValue: e.value };
  }
}

/**
 * Persist an observation and apply it to the sensor state in one transaction.
 * The state row is locked (SELECT … FOR UPDATE) so concurrent analyses of the same
 * sensor serialize; events use deterministic dedupe keys.
 */
export async function recordObservation(sensor: Sensor, input: ObservationInput): Promise<Observation> {
  const createdEventIds: string[] = [];

  const observation = await db.transaction(async (tx) => {
    const [obs] = await tx
      .insert(schema.sensorObservations)
      .values({
        sensorId: sensor.id,
        frameId: input.frame?.id ?? null,
        value: input.value,
        status: input.status,
        reason: input.reason,
        simulated: input.simulated,
        modelId: input.modelId ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        processingDurationMs: input.processingDurationMs ?? null,
        observedAt: input.observedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!obs) {
      const [dup] = await tx
        .select()
        .from(schema.sensorObservations)
        .where(and(eq(schema.sensorObservations.sensorId, sensor.id), eq(schema.sensorObservations.frameId, input.frame!.id)));
      return dup!;
    }

    await tx.insert(schema.sensorStates).values({ sensorId: sensor.id }).onConflictDoNothing();
    const [stateRow] = await tx
      .select()
      .from(schema.sensorStates)
      .where(eq(schema.sensorStates.sensorId, sensor.id))
      .for('update');
    const current = stateRow ? toEngine(stateRow) : initialState();
    const result = applyObservation(current, { value: input.value, status: input.status, observedAt: input.observedAt }, sensor.stabilization);

    if (!result.applied) return obs;

    const changed = result.events.some((e) => e.type === 'state_changed');
    await tx
      .update(schema.sensorStates)
      .set({
        value: result.state.value,
        status: result.state.status,
        confirmedAt: result.state.confirmedAt,
        lastObservationAt: result.state.lastObservationAt,
        lastObservationId: obs.id,
        candidateValue: result.state.candidateValue,
        candidateCount: result.state.candidateCount,
        consecutiveFailures: result.state.consecutiveFailures,
        consecutiveUncertain: result.state.consecutiveUncertain,
        ...(changed ? { lastChangedAt: input.observedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.sensorStates.sensorId, sensor.id));

    const [updated] = await tx
      .update(schema.sensorObservations)
      .set({ stateValue: result.state.value, stateStatus: result.state.status, causedTransition: changed })
      .where(eq(schema.sensorObservations.id, obs.id))
      .returning();

    for (const e of result.events) {
      const ev = await createEvent(
        {
          organizationId: sensor.organizationId,
          eventType: e.type,
          dedupeKey: `obs:${obs.id}:${e.type}`,
          cameraId: sensor.cameraId,
          sensorId: sensor.id,
          observationId: obs.id,
          frameId: input.frame?.id ?? null,
          simulated: input.simulated,
          occurredAt: input.observedAt,
          metadata: e.type === 'sensor_unavailable' ? { reason: e.reason } : e.type === 'sensor_recovered' ? { previousStatus: e.previousStatus } : {},
          ...eventValues(e),
        },
        tx,
      );
      if (ev) createdEventIds.push(ev.id);
    }
    return updated ?? obs;
  });

  // Enqueue only after commit so the automation worker always sees the event.
  for (const id of createdEventIds) await enqueueAutomation(id);
  return observation;
}

/** Ensure every sensor has a state row (used when listing). */
export async function ensureStates(sensorIds: string[]) {
  if (sensorIds.length === 0) return;
  await db
    .insert(schema.sensorStates)
    .values(sensorIds.map((sensorId) => ({ sensorId })))
    .onConflictDoNothing();
}

export { cropZone } from './crop';
