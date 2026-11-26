import { describe, expect, it } from 'vitest';
import {
  eventMatchesRule, evaluateDuration, evaluateCameraOffline, inCooldown, triggerSchema,
  type RuleTarget, type TriggerEvent,
} from '../src/automation';

const rule = (trigger: unknown, sensorId = 's1'): RuleTarget => ({
  id: 'r1', sensorId, cameraId: null, trigger: triggerSchema.parse(trigger),
});
const changed = (previousValue: unknown, currentValue: unknown, sensorId = 's1'): TriggerEvent => ({
  type: 'state_changed', sensorId, cameraId: 'c1', previousValue: previousValue as never, currentValue: currentValue as never,
});

describe('rule matching', () => {
  it('matches a specific state transition', () => {
    const r = rule({ type: 'state_transition', from: 'occupied', to: 'available' });
    expect(eventMatchesRule(r, changed('occupied', 'available'))).toBe(true);
    expect(eventMatchesRule(r, changed('available', 'occupied'))).toBe(false);
    expect(eventMatchesRule(r, changed(null, 'available'))).toBe(false);
  });

  it('does not match events of another sensor', () => {
    const r = rule({ type: 'state_transition', from: null, to: 'available' });
    expect(eventMatchesRule(r, changed('occupied', 'available', 's2'))).toBe(false);
  });

  it('wildcard transition matches any change', () => {
    const r = rule({ type: 'state_transition' });
    expect(eventMatchesRule(r, changed(null, 'x'))).toBe(true);
  });

  it('value equals is edge-triggered on state_changed', () => {
    const r = rule({ type: 'value_equals', value: true });
    expect(eventMatchesRule(r, changed(false, true))).toBe(true);
    expect(eventMatchesRule(r, { ...changed(true, true), type: 'sensor_recovered' })).toBe(false);
  });

  it('numeric threshold fires only when crossing', () => {
    const r = rule({ type: 'numeric_threshold', operator: 'lt', threshold: 3 });
    expect(eventMatchesRule(r, changed(5, 2))).toBe(true);
    expect(eventMatchesRule(r, changed(2, 1))).toBe(false);
    expect(eventMatchesRule(r, changed(1, 4))).toBe(false);
    expect(eventMatchesRule(r, changed(null, 0))).toBe(true);
  });

  it('sensor unavailable matches unavailable events', () => {
    const r = rule({ type: 'sensor_unavailable' });
    expect(eventMatchesRule(r, { ...changed(null, null), type: 'sensor_unavailable' })).toBe(true);
    expect(eventMatchesRule(r, changed('a', 'b'))).toBe(false);
  });

  it('duration rules only match their own scheduler events', () => {
    const r = rule({ type: 'duration', value: true, durationSeconds: 300 });
    expect(eventMatchesRule(r, { ...changed(false, true), type: 'duration_reached', metadata: { ruleId: 'r1' } })).toBe(true);
    expect(eventMatchesRule(r, { ...changed(false, true), type: 'duration_reached', metadata: { ruleId: 'r2' } })).toBe(false);
    expect(eventMatchesRule(r, changed(false, true))).toBe(false);
  });
});

describe('time based triggers', () => {
  const since = new Date('2026-01-01T10:00:00Z');
  const trig = { type: 'duration' as const, value: true, durationSeconds: 300 };

  it('duration requires confirmed state for the whole period', () => {
    expect(evaluateDuration(trig, { value: true, status: 'confirmed', confirmedAt: since }, new Date('2026-01-01T10:04:59Z'))).toBeNull();
    expect(evaluateDuration(trig, { value: true, status: 'confirmed', confirmedAt: since }, new Date('2026-01-01T10:05:00Z'))).toEqual(since);
  });

  it('duration does not run through stale/uncertain periods', () => {
    const now = new Date('2026-01-01T11:00:00Z');
    expect(evaluateDuration(trig, { value: true, status: 'stale', confirmedAt: since }, now)).toBeNull();
    expect(evaluateDuration(trig, { value: true, status: 'uncertain', confirmedAt: since }, now)).toBeNull();
    expect(evaluateDuration(trig, { value: false, status: 'confirmed', confirmedAt: since }, now)).toBeNull();
  });

  it('camera offline respects duration', () => {
    const t = { type: 'camera_offline' as const, durationSeconds: 120 };
    expect(evaluateCameraOffline(t, { status: 'offline', offlineSince: since }, new Date('2026-01-01T10:01:00Z'))).toBeNull();
    expect(evaluateCameraOffline(t, { status: 'offline', offlineSince: since }, new Date('2026-01-01T10:02:00Z'))).toEqual(since);
    expect(evaluateCameraOffline(t, { status: 'online', offlineSince: null }, new Date())).toBeNull();
  });

  it('cooldown', () => {
    const now = new Date('2026-01-01T10:00:30Z');
    expect(inCooldown(since, 60, now)).toBe(true);
    expect(inCooldown(since, 10, now)).toBe(false);
    expect(inCooldown(null, 60, now)).toBe(false);
  });
});
