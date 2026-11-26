import { createHash } from 'node:crypto';
import type { SensorValue } from '@veyra/shared';
import type { VisionAnalysisInput, VisionAnalysisResult, VisionProvider } from './provider';

/**
 * Explicit simulation provider used when no OpenAI key is configured.
 * It does NOT look at the image. Values are pseudo-random but sticky (change every
 * few minutes) so state transitions and automations can be exercised.
 * Every result is flagged simulated=true and shown as simulated in the UI.
 */
export class MockVisionProvider implements VisionProvider {
  readonly name = 'mock';

  async analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult> {
    const started = Date.now();
    const bucket = Math.floor(Date.now() / 180_000);
    const h = createHash('sha256').update(`${input.sensorId}:${bucket}`).digest();
    const roll = h[0]! / 255;
    const pick = h[1]!;
    let value: SensorValue;
    switch (input.spec.outputType) {
      case 'boolean':
        value = pick % 2 === 0;
        break;
      case 'number':
        value = pick % 8;
        break;
      case 'enum': {
        const values = input.spec.outputConfig.allowedValues ?? ['a'];
        value = values[pick % values.length]!;
        break;
      }
    }
    const uncertain = roll < 0.08;
    return {
      value: uncertain ? null : value,
      status: uncertain ? 'uncertain' : 'confirmed',
      reason: uncertain ? 'Simulerat osäkert resultat' : 'Simulerat resultat (ingen AI-analys utförd)',
      modelId: 'mock',
      simulated: true,
      durationMs: Date.now() - started,
    };
  }
}
