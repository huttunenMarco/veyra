import { config, DEFAULT_OPENAI_MODEL, DEFAULT_REASONING_EFFORT } from '../config';
import { decryptJson } from '../lib/crypto';
import { getInstance } from '../services/instance';
import { MockVisionProvider } from './mock';
import { OpenAIVisionProvider } from './openai';
import type { VisionProvider } from './provider';

export interface VisionSettings {
  provider: 'openai' | 'mock';
  model: string;
  reasoningEffort: string | null;
  /** Where the API key comes from. */
  keySource: 'env' | 'ui' | null;
  apiKey: string | null;
}

/** Effective AI settings: environment variables win over values saved in the UI. */
export async function visionSettings(): Promise<VisionSettings> {
  const inst = await getInstance();
  const uiKey = inst.openaiApiKeyEncrypted ? decryptJson<string>(inst.openaiApiKeyEncrypted) : null;
  const apiKey = config.OPENAI_API_KEY || uiKey;
  const keySource = config.OPENAI_API_KEY ? 'env' : uiKey ? 'ui' : null;
  const provider = config.VISION_PROVIDER === 'auto' ? (apiKey ? 'openai' : 'mock') : config.VISION_PROVIDER;
  const effort = config.OPENAI_REASONING_EFFORT ?? inst.openaiReasoningEffort ?? DEFAULT_REASONING_EFFORT;
  return {
    provider,
    model: config.OPENAI_MODEL || inst.openaiModel || DEFAULT_OPENAI_MODEL,
    reasoningEffort: effort || null,
    keySource,
    apiKey,
  };
}

let cached: { at: number; provider: VisionProvider } | null = null;

/** Provider for the current settings (cached briefly; reset when settings change). */
export async function getVisionProvider(): Promise<VisionProvider> {
  if (cached && Date.now() - cached.at < 10_000) return cached.provider;
  const s = await visionSettings();
  const provider =
    s.provider === 'openai' && s.apiKey ? new OpenAIVisionProvider(s.apiKey, s.model, s.reasoningEffort) : new MockVisionProvider();
  cached = { at: Date.now(), provider };
  return provider;
}

export function resetVisionProvider() {
  cached = null;
}

export function estimateCostUsd(inputTokens = 0, outputTokens = 0): number {
  return (inputTokens * config.OPENAI_INPUT_COST_PER_MTOK + outputTokens * config.OPENAI_OUTPUT_COST_PER_MTOK) / 1_000_000;
}

export type { VisionProvider } from './provider';
