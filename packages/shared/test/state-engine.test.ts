import { describe, expect, it } from 'vitest';
import { applyObservation, checkStale, initialState, type EngineState } from '../src/state-engine';

const cfg = { requiredConsecutive: 3, unavailableAfter: 3, uncertainAfter: 2 };
let t = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++t));

function feed(state: EngineState, obs: Array<[string | null, 'confirmed' | 'uncertain' | 'unavailable']>) {
  const events = [];
  for (const [value, status] of obs) {
    const r = applyObservation(state, { value, status, observedAt: at() }, cfg);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

const occupied = (): EngineState => ({ ...initialState(), value: 'occupied', status: 'confirmed', confirmedAt: at(), lastObservationAt: at() });

describe('state engine', () => {
  it('requires N consecutive confirmations before changing state', () => {
    const s = occupied();
    let r = feed(s, [['available', 'confirmed'], ['available', 'confirmed']]);
    expect(r.state.value).toBe('occupied');
    expect(r.events).toHaveLength(0);
    r = feed(r.state, [['available', 'confirmed']]);
    expect(r.state.value).toBe('available');
    expect(r.events).toEqual([
      { type: 'state_changed', previousValue: 'occupied', currentValue: 'available', previousStatus: 'confirmed' },
    ]);
  });

  it('does not repeat events for a persistent value', () => {
    const r = feed(occupied(), [
      ['available', 'confirmed'], ['available', 'confirmed'], ['available', 'confirmed'],
      ['available', 'confirmed'], ['available', 'confirmed'],
    ]);
    expect(r.events.filter((e) => e.type === 'state_changed')).toHaveLength(1);
  });

  it('resets the streak when a different value interrupts', () => {
    const r = feed(occupied(), [
      ['available', 'confirmed'], ['available', 'confirmed'], ['occupied', 'confirmed'], ['available', 'confirmed'],
    ]);
    expect(r.state.value).toBe('occupied');
    expect(r.events).toHaveLength(0);
  });

  it('never treats uncertain observations as a business value', () => {
    const r = feed(occupied(), [
      ['available', 'uncertain'], ['available', 'uncertain'], ['available', 'uncertain'], ['available', 'uncertain'],
    ]);
    expect(r.state.value).toBe('occupied');
    expect(r.state.status).toBe('uncertain');
    expect(r.events).toHaveLength(0);
  });

  it('uncertain observations break a confirmation streak', () => {
    const r = feed(occupied(), [
      ['available', 'confirmed'], ['available', 'confirmed'], [null, 'uncertain'], ['available', 'confirmed'],
    ]);
    expect(r.state.value).toBe('occupied');
  });

  it('marks unavailable after repeated failures and emits one event', () => {
    const r = feed(occupied(), [[null, 'unavailable'], [null, 'unavailable'], [null, 'unavailable'], [null, 'unavailable']]);
    expect(r.state.status).toBe('unavailable');
    expect(r.state.value).toBe('occupied');
    expect(r.events).toEqual([{ type: 'sensor_unavailable', reason: 'failures', lastValue: 'occupied' }]);
  });

  it('recovers to the same value without a false state change', () => {
    let r = feed(occupied(), [[null, 'unavailable'], [null, 'unavailable'], [null, 'unavailable']]);
    r = feed(r.state, [['occupied', 'confirmed'], ['occupied', 'confirmed'], ['occupied', 'confirmed']]);
    expect(r.state.status).toBe('confirmed');
    expect(r.events.map((e) => e.type)).toEqual(['sensor_recovered']);
  });

  it('establishes initial state from unknown', () => {
    const r = feed(initialState(), [['available', 'confirmed'], ['available', 'confirmed'], ['available', 'confirmed']]);
    expect(r.state.status).toBe('confirmed');
    expect(r.events[0]).toMatchObject({ type: 'state_changed', previousValue: null, currentValue: 'available' });
  });

  it('ignores out-of-order observations', () => {
    const s = occupied();
    const r = applyObservation(s, { value: 'available', status: 'confirmed', observedAt: new Date(0) }, cfg);
    expect(r.applied).toBe(false);
    expect(r.state).toBe(s);
  });

  it('marks stale once and only once', () => {
    const s = occupied();
    const later = new Date(s.lastObservationAt!.getTime() + 10 * 60_000);
    const r1 = checkStale(s, later, 5 * 60_000, new Date(0));
    expect(r1.state.status).toBe('stale');
    expect(r1.events).toHaveLength(1);
    const r2 = checkStale(r1.state, later, 5 * 60_000, new Date(0));
    expect(r2.events).toHaveLength(0);
  });

  it('does not mark stale within the window', () => {
    const s = occupied();
    const r = checkStale(s, new Date(s.lastObservationAt!.getTime() + 1000), 60_000, new Date(0));
    expect(r.state.status).toBe('confirmed');
  });
});
