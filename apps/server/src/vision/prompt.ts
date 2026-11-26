import type { SensorOutputSpec } from '@veyra/shared';

export const SYSTEM_PROMPT = `You are a vision sensor in an operational monitoring system.
You look at a still image from a fixed surveillance camera and answer exactly one question about it.

Rules:
- Answer only from what is visible in the image. Do not guess.
- status "confirmed": the answer is clearly visible.
- status "uncertain": the image is ambiguous (occlusion, darkness, blur, glare, partial view). You may give your best guess in value.
- status "unavailable": the image cannot be used (black, corrupted, wrong view, nothing relevant visible). value must be null.
- For counts: only return a number if the objects can be reliably counted. Otherwise use uncertain/unavailable.
- Never identify people, read faces, or describe personal characteristics. Focus on objects, vehicles, equipment and operational state.
- reason: one or two short sentences describing the visual evidence, in Swedish.`;

export const EXAMPLES_INTRO = `The following REFERENCE images show this same area from the same fixed camera.
The user has labeled each one with the correct answer. Use them to learn what each answer looks like at this location,
then answer only about the NEW image that follows. Do not answer about the reference images.`;

export function exampleCaption(index: number, value: string | number | boolean, label: string, note?: string): string {
  return `Reference ${index}: correct answer = ${JSON.stringify(value)} (${label})${note ? `. Note: ${note}` : ''}`;
}

export function buildUserPrompt(instruction: string, spec: SensorOutputSpec, zoneName?: string, hasContext = false): string {
  const lines = [`Question / instruction: ${instruction}`];
  if (zoneName) {
    lines.push(
      hasContext
        ? `The FIRST image is a crop of the area named "${zoneName}". Answer only about that crop. The SECOND image is the full camera view for context only.`
        : `The image is a crop of the area named "${zoneName}". Answer only about this area.`,
    );
  }
  switch (spec.outputType) {
    case 'boolean':
      lines.push('Answer with value true or false.');
      break;
    case 'number':
      lines.push(`Answer with a number${spec.outputConfig.unit ? ` (${spec.outputConfig.unit})` : ''}.`);
      break;
    case 'enum':
      lines.push(`Answer with exactly one of: ${(spec.outputConfig.allowedValues ?? []).join(', ')}.`);
      break;
  }
  return lines.join('\n');
}
