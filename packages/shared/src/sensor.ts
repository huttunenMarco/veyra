import { z } from 'zod';

export const outputTypes = ['boolean', 'enum', 'number'] as const;
export type OutputType = (typeof outputTypes)[number];

export const observationStatuses = ['confirmed', 'uncertain', 'unavailable'] as const;
export type ObservationStatus = (typeof observationStatuses)[number];

/** Sensor state status. `unknown` = no confirmed state yet; `stale` = no fresh observations. */
export const sensorStateStatuses = ['unknown', 'confirmed', 'uncertain', 'unavailable', 'stale'] as const;
export type SensorStateStatus = (typeof sensorStateStatuses)[number];

export type SensorValue = string | number | boolean;

const enumValue = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Endast a-z, 0-9, _ och -');

export const outputConfigSchema = z
  .object({
    allowedValues: z.array(enumValue).max(12).optional(),
    /** Human-readable labels (Swedish UI) for raw values, e.g. { occupied: "Upptagen" }. */
    valueLabels: z.record(z.string(), z.string().max(60)).optional(),
    unit: z.string().max(20).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .default({});
export type OutputConfig = z.infer<typeof outputConfigSchema>;

export const stabilizationSchema = z
  .object({
    /** Consecutive confirmed observations of a new value required before the state changes. */
    requiredConsecutive: z.number().int().min(1).max(20).default(2),
    /** Consecutive failed/unavailable observations before the sensor is marked unavailable. */
    unavailableAfter: z.number().int().min(1).max(50).default(3),
    /** Consecutive uncertain observations before the state is marked uncertain. */
    uncertainAfter: z.number().int().min(1).max(50).default(3),
    /** Seconds without observations before the state is stale. Defaults to 3x the interval. */
    staleAfterSeconds: z.number().int().min(30).max(86400).optional(),
  })
  .default({ requiredConsecutive: 2, unavailableAfter: 3, uncertainAfter: 3 });
export type StabilizationConfig = z.infer<typeof stabilizationSchema>;

export const sensorInputSchema = z
  .object({
    cameraId: z.string().uuid(),
    zoneId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().default(''),
    instruction: z.string().trim().min(5).max(4000),
    outputType: z.enum(outputTypes),
    outputConfig: outputConfigSchema,
    intervalSeconds: z.number().int().min(15).max(86400).default(60),
    includeFullImageContext: z.boolean().default(false),
    /** Use the sensor's labeled reference images, if any exist. */
    useExamples: z.boolean().default(true),
    enabled: z.boolean().default(true),
    stabilization: stabilizationSchema,
  })
  .superRefine((v, ctx) => {
    if (v.outputType === 'enum') {
      const values = v.outputConfig.allowedValues ?? [];
      if (values.length < 2) {
        ctx.addIssue({ code: 'custom', path: ['outputConfig', 'allowedValues'], message: 'Ange minst två värden' });
      }
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: 'custom', path: ['outputConfig', 'allowedValues'], message: 'Värden måste vara unika' });
      }
      if (values.some((x) => x === 'unknown')) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputConfig', 'allowedValues'],
          message: '"unknown" hanteras separat och kan inte vara ett affärsvärde',
        });
      }
    }
  });
export type SensorInput = z.infer<typeof sensorInputSchema>;

export interface SensorOutputSpec {
  outputType: OutputType;
  outputConfig: OutputConfig;
}

/**
 * JSON schema sent to the vision model (OpenAI structured outputs, strict mode).
 * The value is nullable: a model that cannot tell must return null + status uncertain/unavailable
 * rather than guessing a business value.
 */
export function buildModelResponseSchema(spec: SensorOutputSpec): Record<string, unknown> {
  let valueSchema: Record<string, unknown>;
  switch (spec.outputType) {
    case 'boolean':
      valueSchema = { type: ['boolean', 'null'] };
      break;
    case 'number':
      valueSchema = { type: ['number', 'null'] };
      break;
    case 'enum':
      valueSchema = { type: ['string', 'null'], enum: [...(spec.outputConfig.allowedValues ?? []), null] };
      break;
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'status', 'reason'],
    properties: {
      value: valueSchema,
      status: { type: 'string', enum: [...observationStatuses] },
      reason: { type: 'string', description: 'Short explanation of what is visible, max 2 sentences.' },
    },
  };
}

export interface ParsedObservation {
  value: SensorValue | null;
  status: ObservationStatus;
  reason: string;
}

/**
 * Validate raw model output against the sensor's output spec. Anything that does not
 * fit is downgraded to `unavailable` — never coerced into a business value.
 */
export function parseModelOutput(spec: SensorOutputSpec, raw: unknown): ParsedObservation {
  const base = z
    .object({
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      status: z.enum(observationStatuses),
      reason: z.string().max(2000).default(''),
    })
    .safeParse(raw);
  if (!base.success) {
    return { value: null, status: 'unavailable', reason: 'Ogiltigt svar från AI-modellen' };
  }
  const { value, status, reason } = base.data;

  if (status !== 'confirmed') {
    // Uncertain answers may carry a best guess, but it is never treated as confirmed.
    return { value: isValidValue(spec, value) ? value : null, status, reason };
  }
  if (value === null || !isValidValue(spec, value)) {
    return { value: null, status: 'unavailable', reason: `Ogiltigt värde från AI-modellen: ${JSON.stringify(value)}` };
  }
  return { value, status, reason };
}

export function isValidValue(spec: SensorOutputSpec, value: unknown): value is SensorValue {
  switch (spec.outputType) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const { min, max } = spec.outputConfig;
      if (min !== undefined && value < min) return false;
      if (max !== undefined && value > max) return false;
      return true;
    }
    case 'enum':
      return typeof value === 'string' && (spec.outputConfig.allowedValues ?? []).includes(value);
  }
}

/** Display label for a value, using configured labels and Swedish defaults for booleans. */
export function formatSensorValue(
  spec: { outputType: OutputType; outputConfig?: OutputConfig | null },
  value: SensorValue | null | undefined,
): string {
  if (value === null || value === undefined) return 'Okänd';
  const labels = spec.outputConfig?.valueLabels ?? {};
  const key = String(value);
  if (labels[key]) return labels[key];
  if (spec.outputType === 'boolean') return value ? 'Ja' : 'Nej';
  if (spec.outputType === 'number' && spec.outputConfig?.unit) return `${value} ${spec.outputConfig.unit}`;
  return key;
}

export function valuesEqual(a: SensorValue | null | undefined, b: SensorValue | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}
