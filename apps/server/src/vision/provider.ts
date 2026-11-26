import type { ParsedObservation, SensorOutputSpec } from '@veyra/shared';

export interface VisionAnalysisInput {
  sensorId: string;
  instruction: string;
  spec: SensorOutputSpec;
  /** JPEG of the zone (or full frame when the sensor has no zone). */
  image: Buffer;
  /** Optional downscaled full frame for context. */
  contextImage?: Buffer;
  zoneName?: string;
  /** Optional user-labeled reference images of the same area (already cropped to the zone). */
  examples?: VisionExample[];
}

export interface VisionExample {
  image: Buffer;
  /** Raw value the user says this image shows, e.g. "open" or true. */
  value: string | number | boolean;
  /** Human label, e.g. "Öppen". */
  label: string;
  note?: string;
}

export interface VisionAnalysisResult extends ParsedObservation {
  modelId: string;
  simulated: boolean;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export interface VisionProvider {
  readonly name: string;
  analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult>;
}
