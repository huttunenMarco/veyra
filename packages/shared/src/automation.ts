import { z } from 'zod';
import type { SensorStateStatus, SensorValue } from './sensor';
import { valuesEqual } from './sensor';

const sensorValueSchema = z.union([z.string().min(1).max(60), z.number(), z.boolean()]);

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state_transition'),
    /** null = any previous value */
    from: sensorValueSchema.nullable().default(null),
    /** null = any new value */
    to: sensorValueSchema.nullable().default(null),
  }),
  z.object({ type: z.literal('value_equals'), value: sensorValueSchema }),
  z.object({
    type: z.literal('numeric_threshold'),
    operator: z.enum(['lt', 'lte', 'gt', 'gte', 'eq']),
    threshold: z.number(),
  }),
  z.object({
    type: z.literal('duration'),
    value: sensorValueSchema,
    durationSeconds: z.number().int().min(30).max(7 * 86400),
  }),
  z.object({ type: z.literal('camera_offline'), durationSeconds: z.number().int().min(0).max(7 * 86400) }),
  z.object({ type: z.literal('sensor_unavailable') }),
]);
export type Trigger = z.infer<typeof triggerSchema>;
export type TriggerType = Trigger['type'];

export const triggerTypes: TriggerType[] = [
  'state_transition',
  'value_equals',
  'numeric_threshold',
  'duration',
  'camera_offline',
  'sensor_unavailable',
];

/** Triggers evaluated periodically against current state instead of against events. */
export const timeBasedTriggerTypes: TriggerType[] = ['duration', 'camera_offline'];

export const eventTypes = [
  'state_changed',
  'sensor_unavailable',
  'sensor_recovered',
  'camera_offline',
  'camera_online',
  'duration_reached',
  'test',
] as const;
export type EventType = (typeof eventTypes)[number];

export interface TriggerEvent {
  type: EventType;
  sensorId: string | null;
  cameraId: string | null;
  previousValue: SensorValue | null;
  currentValue: SensorValue | null;
  metadata?: Record<string, unknown>;
}

export interface RuleTarget {
  id: string;
  sensorId: string | null;
  cameraId: string | null;
  trigger: Trigger;
}

export function compareNumber(op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq', value: number, threshold: number): boolean {
  switch (op) {
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'eq':
      return value === threshold;
  }
}

/**
 * Decide whether an event matches an event-driven rule. Rules are edge-triggered:
 * a persisting condition does not match again until the state has changed.
 */
export function eventMatchesRule(rule: RuleTarget, event: TriggerEvent): boolean {
  const t = rule.trigger;

  if (t.type === 'duration' || t.type === 'camera_offline') {
    // Time-based events are created per rule by the scheduler.
    const expected = t.type === 'duration' ? 'duration_reached' : 'camera_offline';
    return event.type === expected && event.metadata?.ruleId === rule.id;
  }

  if (!rule.sensorId || event.sensorId !== rule.sensorId) return false;

  switch (t.type) {
    case 'sensor_unavailable':
      return event.type === 'sensor_unavailable';
    case 'state_transition':
      return (
        event.type === 'state_changed' &&
        (t.from === null || valuesEqual(event.previousValue, t.from)) &&
        (t.to === null || valuesEqual(event.currentValue, t.to))
      );
    case 'value_equals':
      return event.type === 'state_changed' && valuesEqual(event.currentValue, t.value);
    case 'numeric_threshold': {
      if (event.type !== 'state_changed' || typeof event.currentValue !== 'number') return false;
      const now = compareNumber(t.operator, event.currentValue, t.threshold);
      const before =
        typeof event.previousValue === 'number' && compareNumber(t.operator, event.previousValue, t.threshold);
      return now && !before;
    }
  }
}

export interface DurationCheckInput {
  value: SensorValue | null;
  status: SensorStateStatus;
  confirmedAt: Date | null;
}

/**
 * Duration rule: the confirmed state has held `value` for at least `durationSeconds`.
 * Returns the `since` timestamp used as the dedupe key, or null if not satisfied.
 * Non-confirmed (uncertain/stale/unavailable) states never satisfy a duration rule.
 */
export function evaluateDuration(
  trigger: Extract<Trigger, { type: 'duration' }>,
  state: DurationCheckInput,
  now: Date,
): Date | null {
  if (state.status !== 'confirmed' || !state.confirmedAt) return null;
  if (!valuesEqual(state.value, trigger.value)) return null;
  if (now.getTime() - state.confirmedAt.getTime() < trigger.durationSeconds * 1000) return null;
  return state.confirmedAt;
}

export function evaluateCameraOffline(
  trigger: Extract<Trigger, { type: 'camera_offline' }>,
  camera: { status: string; offlineSince: Date | null },
  now: Date,
): Date | null {
  if (camera.status !== 'offline' || !camera.offlineSince) return null;
  if (now.getTime() - camera.offlineSince.getTime() < trigger.durationSeconds * 1000) return null;
  return camera.offlineSince;
}

/** True if the rule is still within its cooldown window. */
export function inCooldown(lastFiredAt: Date | null, cooldownSeconds: number, now: Date): boolean {
  if (!lastFiredAt || cooldownSeconds <= 0) return false;
  return now.getTime() - lastFiredAt.getTime() < cooldownSeconds * 1000;
}
