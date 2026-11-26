import { safeFetch, OutboundBlockedError } from '../lib/outbound';
import { DeliveryError } from './types';

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return send(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
}

export async function send(url: string, init: { method: string; body?: string | Buffer; headers: Record<string, string> }) {
  let res;
  try {
    const body = typeof init.body === 'string' || init.body === undefined ? init.body : new Uint8Array(init.body);
    res = await safeFetch(url, { method: init.method, body, headers: { 'User-Agent': 'Veyra/0.1', ...init.headers } });
  } catch (err) {
    if (err instanceof OutboundBlockedError) throw new DeliveryError(err.message, false);
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof OutboundBlockedError) throw new DeliveryError(cause.message, false);
    throw new DeliveryError(`Nätverksfel: ${(err as Error).message}`, true);
  }
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new DeliveryError(`HTTP ${res.status}: ${res.body.slice(0, 300)}`, retryable, res.status);
  }
  return { responseCode: res.status };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'ogiltig URL';
  }
}

export function maskPhone(p: string): string {
  return p.length > 6 ? `${p.slice(0, 5)}…${p.slice(-2)}` : p;
}
