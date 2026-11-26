import type { EventType, SensorValue } from '@veyra/shared';
import { db, schema, type Tx } from '../db/client';

export interface NewEvent {
  organizationId: string;
  eventType: EventType;
  dedupeKey: string;
  cameraId?: string | null;
  sensorId?: string | null;
  observationId?: string | null;
  frameId?: string | null;
  previousValue?: SensorValue | null;
  currentValue?: SensorValue | null;
  simulated?: boolean;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Insert an event; returns null if an event with the same dedupe key already exists. */
export async function createEvent(e: NewEvent, tx: Tx | typeof db = db) {
  const [row] = await tx
    .insert(schema.events)
    .values({
      organizationId: e.organizationId,
      eventType: e.eventType,
      dedupeKey: e.dedupeKey,
      cameraId: e.cameraId ?? null,
      sensorId: e.sensorId ?? null,
      observationId: e.observationId ?? null,
      frameId: e.frameId ?? null,
      previousValue: e.previousValue ?? null,
      currentValue: e.currentValue ?? null,
      simulated: e.simulated ?? false,
      metadata: e.metadata ?? {},
      occurredAt: e.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}
