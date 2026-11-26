import { describe, expect, it } from 'vitest';
import { buildModelResponseSchema, parseModelOutput, sensorInputSchema } from '../src/sensor';

const dock = { outputType: 'enum' as const, outputConfig: { allowedValues: ['occupied', 'available'] } };

describe('sensor output validation', () => {
  it('accepts valid enum output', () => {
    expect(parseModelOutput(dock, { value: 'available', status: 'confirmed', reason: 'tom' })).toEqual({
      value: 'available', status: 'confirmed', reason: 'tom',
    });
  });

  it('downgrades values outside the allowed set to unavailable', () => {
    expect(parseModelOutput(dock, { value: 'maybe', status: 'confirmed', reason: '' }).status).toBe('unavailable');
  });

  it('downgrades malformed output', () => {
    expect(parseModelOutput(dock, 'garbage').status).toBe('unavailable');
    expect(parseModelOutput(dock, { value: 'available' }).status).toBe('unavailable');
  });

  it('does not invent numbers', () => {
    const spec = { outputType: 'number' as const, outputConfig: { min: 0 } };
    expect(parseModelOutput(spec, { value: null, status: 'confirmed', reason: '' }).status).toBe('unavailable');
    expect(parseModelOutput(spec, { value: -1, status: 'confirmed', reason: '' }).status).toBe('unavailable');
    expect(parseModelOutput(spec, { value: 4, status: 'confirmed', reason: '' }).value).toBe(4);
  });

  it('keeps uncertain status even with a value', () => {
    const r = parseModelOutput(dock, { value: 'occupied', status: 'uncertain', reason: 'dimmigt' });
    expect(r.status).toBe('uncertain');
  });

  it('builds a strict schema with nullable value', () => {
    const s = buildModelResponseSchema(dock) as { properties: { value: { enum: unknown[] } } };
    expect(s.properties.value.enum).toEqual(['occupied', 'available', null]);
  });

  it('requires at least two enum values and rejects "unknown"', () => {
    const base = {
      cameraId: '6f7f4f62-4a8a-4f9e-9a44-2a8b1f0f0a11', name: 'x', instruction: 'Is it there?',
      outputType: 'enum', outputConfig: { allowedValues: ['a'] },
    };
    expect(sensorInputSchema.safeParse(base).success).toBe(false);
    expect(sensorInputSchema.safeParse({ ...base, outputConfig: { allowedValues: ['a', 'unknown'] } }).success).toBe(false);
    expect(sensorInputSchema.safeParse({ ...base, outputConfig: { allowedValues: ['a', 'b'] } }).success).toBe(true);
  });
});

import { zoneUpdateSchema, cameraUpdateSchema } from '../src/api';

describe('partial update schemas', () => {
  it('do not inject defaults for omitted fields', () => {
    expect(zoneUpdateSchema.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(cameraUpdateSchema.parse({ connection: { rtspUrl: 'rtsp://10.0.0.1/s' } }).connection).toEqual({ rtspUrl: 'rtsp://10.0.0.1/s' });
  });
});
