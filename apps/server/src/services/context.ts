import { eq } from 'drizzle-orm';
import { formatSensorValue, type TemplateContext } from '@veyra/shared';
import { config } from '../config';
import { db, schema } from '../db/client';
import type { EventContext } from '../integrations/types';
import { storage } from '../lib/storage';

type Event = typeof schema.events.$inferSelect;

export const eventTypeLabels: Record<string, string> = {
  state_changed: 'Statusändring',
  sensor_unavailable: 'Sensor otillgänglig',
  sensor_recovered: 'Sensor återställd',
  camera_offline: 'Kamera offline',
  camera_online: 'Kamera online',
  duration_reached: 'Varaktighet uppnådd',
  test: 'Test',
};

export function formatTimestamp(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(d);
}

/** Build the allowlisted template context and webhook payload for an event. */
export async function buildEventContext(event: Event, ruleName?: string): Promise<EventContext> {
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, event.organizationId));
  const sensorRow = event.sensorId
    ? (
        await db
          .select({ sensor: schema.sensors, zone: schema.zones })
          .from(schema.sensors)
          .leftJoin(schema.zones, eq(schema.zones.id, schema.sensors.zoneId))
          .where(eq(schema.sensors.id, event.sensorId))
      )[0]
    : undefined;
  const cameraId = event.cameraId ?? sensorRow?.sensor.cameraId ?? null;
  const camera = cameraId ? (await db.select().from(schema.cameras).where(eq(schema.cameras.id, cameraId)))[0] : undefined;
  const frame = event.frameId
    ? (await db.select().from(schema.cameraFrames).where(eq(schema.cameraFrames.id, event.frameId)))[0]
    : undefined;

  const sensor = sensorRow?.sensor;
  const spec = sensor ? { outputType: sensor.outputType, outputConfig: sensor.outputConfig } : { outputType: 'enum' as const };
  const tz = org?.timezone ?? 'Europe/Stockholm';

  const template: TemplateContext = {
    'camera.name': camera?.name ?? '',
    'zone.name': sensorRow?.zone?.name ?? '',
    'sensor.name': sensor?.name ?? '',
    'sensor.value': event.currentValue === null ? 'unknown' : String(event.currentValue),
    'sensor.valueLabel': formatSensorValue(spec, event.currentValue),
    'sensor.previousValue': event.previousValue === null ? 'unknown' : String(event.previousValue),
    'sensor.previousValueLabel': formatSensorValue(spec, event.previousValue),
    'event.id': event.id,
    'event.type': eventTypeLabels[event.eventType] ?? event.eventType,
    'event.timestamp': formatTimestamp(event.occurredAt, tz),
    'rule.name': ruleName ?? '',
    'snapshot.url': frame ? `${config.PUBLIC_URL}/events/${event.id}` : '',
  };

  let snapshot: Buffer | undefined;
  if (frame && !frame.deletedAt) snapshot = await storage.get(frame.storageKey).catch(() => undefined);

  return {
    template,
    snapshot,
    payload: {
      event: {
        id: event.id,
        type: event.eventType,
        occurredAt: event.occurredAt.toISOString(),
        previousValue: event.previousValue,
        currentValue: event.currentValue,
        simulated: event.simulated,
        test: event.eventType === 'test',
      },
      camera: camera ? { id: camera.id, name: camera.name } : null,
      zone: sensorRow?.zone ? { id: sensorRow.zone.id, name: sensorRow.zone.name } : null,
      sensor: sensor ? { id: sensor.id, name: sensor.name } : null,
      rule: ruleName ? { name: ruleName } : null,
    },
  };
}
