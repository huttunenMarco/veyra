import type { ObservationStatus, SensorStateStatus, SensorValue, StabilizationConfig } from './sensor';
import { valuesEqual } from './sensor';

/**
 * Deterministic sensor state engine.
 *
 * Observation = what the model reported for one frame.
 * State       = what Veyra considers the confirmed condition.
 * Events are produced only by this engine, never directly from model output.
 */
export interface EngineState {
  value: SensorValue | null;
  status: SensorStateStatus;
  /** When the current value/status combination became confirmed. Used by duration rules. */
  confirmedAt: Date | null;
  lastObservationAt: Date | null;
  candidateValue: SensorValue | null;
  candidateCount: number;
  consecutiveFailures: number;
  consecutiveUncertain: number;
}

export interface EngineObservation {
  value: SensorValue | null;
  status: ObservationStatus;
  observedAt: Date;
}

export type EngineEvent =
  | {
      type: 'state_changed';
      previousValue: SensorValue | null;
      currentValue: SensorValue;
      previousStatus: SensorStateStatus;
    }
  | { type: 'sensor_unavailable'; reason: 'failures' | 'stale'; lastValue: SensorValue | null }
  | { type: 'sensor_recovered'; value: SensorValue; previousStatus: SensorStateStatus };

export interface EngineResult {
  state: EngineState;
  events: EngineEvent[];
  /** False when the observation was older than the latest applied one and ignored. */
  applied: boolean;
}

export function initialState(): EngineState {
  return {
    value: null,
    status: 'unknown',
    confirmedAt: null,
    lastObservationAt: null,
    candidateValue: null,
    candidateCount: 0,
    consecutiveFailures: 0,
    consecutiveUncertain: 0,
  };
}

const DEGRADED: SensorStateStatus[] = ['unavailable', 'stale', 'uncertain'];

export function applyObservation(
  current: EngineState,
  obs: EngineObservation,
  config: Pick<StabilizationConfig, 'requiredConsecutive' | 'unavailableAfter' | 'uncertainAfter'>,
): EngineResult {
  if (current.lastObservationAt && obs.observedAt.getTime() <= current.lastObservationAt.getTime()) {
    // Out-of-order (or duplicate) observation: never let it rewind state.
    return { state: current, events: [], applied: false };
  }

  const state: EngineState = { ...current, lastObservationAt: obs.observedAt };
  const events: EngineEvent[] = [];

  if (obs.status === 'unavailable' || obs.value === null) {
    // Includes "uncertain with no value". Neither counts towards a new value.
    state.candidateValue = null;
    state.candidateCount = 0;
    if (obs.status === 'uncertain') {
      state.consecutiveUncertain += 1;
      state.consecutiveFailures = 0;
      if (state.status === 'confirmed' && state.consecutiveUncertain >= config.uncertainAfter) {
        state.status = 'uncertain';
      }
    } else {
      state.consecutiveFailures += 1;
      state.consecutiveUncertain = 0;
      if (state.status !== 'unavailable' && state.consecutiveFailures >= config.unavailableAfter) {
        state.status = 'unavailable';
        events.push({ type: 'sensor_unavailable', reason: 'failures', lastValue: state.value });
      }
    }
    return { state, events, applied: true };
  }

  if (obs.status === 'uncertain') {
    // A best guess is recorded on the observation but is never used for state.
    state.candidateValue = null;
    state.candidateCount = 0;
    state.consecutiveUncertain += 1;
    state.consecutiveFailures = 0;
    if (state.status === 'confirmed' && state.consecutiveUncertain >= config.uncertainAfter) {
      state.status = 'uncertain';
    }
    return { state, events, applied: true };
  }

  // Confirmed observation with a valid value.
  state.consecutiveFailures = 0;
  state.consecutiveUncertain = 0;

  if (state.status === 'confirmed' && valuesEqual(state.value, obs.value)) {
    state.candidateValue = null;
    state.candidateCount = 0;
    return { state, events, applied: true };
  }

  if (valuesEqual(state.candidateValue, obs.value) && state.candidateCount > 0) {
    state.candidateCount += 1;
  } else {
    state.candidateValue = obs.value;
    state.candidateCount = 1;
  }

  if (state.candidateCount < config.requiredConsecutive) {
    return { state, events, applied: true };
  }

  const previousValue = state.value;
  const previousStatus = state.status;
  state.value = obs.value;
  state.status = 'confirmed';
  // Duration timers restart whenever confirmation is (re)established, so they never
  // silently run through unknown/offline periods.
  state.confirmedAt = obs.observedAt;
  state.candidateValue = null;
  state.candidateCount = 0;

  if (!valuesEqual(previousValue, obs.value)) {
    events.push({ type: 'state_changed', previousValue, currentValue: obs.value, previousStatus });
  } else if (DEGRADED.includes(previousStatus)) {
    // Same value as before the outage: report recovery, not a (false) state change.
    events.push({ type: 'sensor_recovered', value: obs.value, previousStatus });
  }

  return { state, events, applied: true };
}

/** Mark the state stale if no observation arrived within `staleAfterMs`. */
export function checkStale(current: EngineState, now: Date, staleAfterMs: number, createdAt: Date): EngineResult {
  const reference = current.lastObservationAt ?? createdAt;
  if (current.status === 'stale' || current.status === 'unavailable') {
    return { state: current, events: [], applied: false };
  }
  if (now.getTime() - reference.getTime() < staleAfterMs) {
    return { state: current, events: [], applied: false };
  }
  const state: EngineState = { ...current, status: 'stale', candidateValue: null, candidateCount: 0 };
  return {
    state,
    events: [{ type: 'sensor_unavailable', reason: 'stale', lastValue: current.value }],
    applied: true,
  };
}
