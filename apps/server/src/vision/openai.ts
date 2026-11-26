import { buildModelResponseSchema, parseModelOutput } from '@veyra/shared';
import { config } from '../config';
import type { VisionAnalysisInput, VisionAnalysisResult, VisionProvider } from './provider';
import { EXAMPLES_INTRO, SYSTEM_PROMPT, buildUserPrompt, exampleCaption } from './prompt';

interface ResponsesApiOutput {
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | null;
  status?: string;
  incomplete_details?: { reason?: string } | null;
}

export class VisionProviderError extends Error {}

/** OpenAI Responses API with strict JSON-schema structured output. Model is configurable. */
export class OpenAIVisionProvider implements VisionProvider {
  readonly name = 'openai';

  constructor(
    private apiKey: string,
    private model: string,
    private reasoningEffort: string | null = null,
  ) {}

  async analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult> {
    const started = Date.now();
    const toDataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;
    const content: unknown[] = [];
    if (input.examples?.length) {
      content.push({ type: 'input_text', text: EXAMPLES_INTRO });
      input.examples.forEach((ex, i) => {
        content.push({ type: 'input_text', text: exampleCaption(i + 1, ex.value, ex.label, ex.note) });
        content.push({ type: 'input_image', image_url: toDataUrl(ex.image), detail: 'auto' });
      });
      content.push({ type: 'input_text', text: 'NEW image to evaluate:' });
    }
    content.push(
      { type: 'input_text', text: buildUserPrompt(input.instruction, input.spec, input.zoneName, !!input.contextImage) },
      { type: 'input_image', image_url: toDataUrl(input.image), detail: 'high' },
    );
    if (input.contextImage) content.push({ type: 'input_image', image_url: toDataUrl(input.contextImage), detail: 'low' });

    const body: Record<string, unknown> = {
      model: this.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PROMPT }] },
        { role: 'user', content },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'sensor_observation',
          strict: true,
          schema: buildModelResponseSchema(input.spec),
        },
      },
      store: false,
    };
    if (this.reasoningEffort) body.reasoning = { effort: this.reasoningEffort };

    const res = await fetch(`${config.OPENAI_BASE_URL}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as ResponsesApiOutput;
    if (!res.ok) {
      throw new VisionProviderError(`OpenAI ${res.status}: ${json.error?.message ?? 'okänt fel'}`);
    }

    const usage = { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens };
    const parts = (json.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
    const refusal = parts.find((p) => p.type === 'refusal');
    const text = parts.find((p) => p.type === 'output_text')?.text;
    const durationMs = Date.now() - started;

    if (refusal || !text) {
      const reason = refusal?.refusal ?? (json.incomplete_details?.reason ? `Ofullständigt svar (${json.incomplete_details.reason})` : 'Tomt svar');
      return { value: null, status: 'unavailable', reason: `AI-modellen svarade inte: ${reason}`, modelId: this.model, simulated: false, durationMs, ...usage };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    return { ...parseModelOutput(input.spec, raw), modelId: this.model, simulated: false, durationMs, ...usage };
  }
}

/** Cheap check that a key works and the model exists. */
export async function verifyOpenAIKey(apiKey: string, model: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${config.OPENAI_BASE_URL}/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (res.status === 401) return { ok: false, error: 'Nyckeln godkändes inte av OpenAI (401).' };
    if (res.status === 404) return { ok: false, error: `Modellen "${model}" finns inte eller är inte tillgänglig för nyckeln.` };
    return { ok: false, error: `OpenAI svarade ${res.status}: ${body.error?.message ?? 'okänt fel'}` };
  } catch (err) {
    return { ok: false, error: `Kunde inte nå OpenAI: ${(err as Error).message}` };
  }
}
