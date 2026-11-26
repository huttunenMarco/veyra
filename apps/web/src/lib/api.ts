const BASE = '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: Blob | File } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const method = init.method ?? (init.body !== undefined || init.raw ? 'POST' : 'GET');
  if (method !== 'GET') headers['x-veyra-csrf'] = '1';
  let body: BodyInit | undefined;
  if (init.raw) {
    headers['content-type'] = init.raw.type || 'application/octet-stream';
    body = init.raw;
  } else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body, credentials: 'include' });
  } catch {
    throw new ApiError(0, 'network', 'Kunde inte nå servern. Kontrollera att API:t körs.');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? {};
    const detail = Array.isArray(err.details) && err.details.length ? `: ${err.details.map((d: { path: string; message: string }) => `${d.path} – ${d.message}`).join(', ')}` : '';
    throw new ApiError(res.status, err.code ?? 'error', (err.message ?? `HTTP ${res.status}`) + detail, err.details);
  }
  return json as T;
}

export const frameUrl = (frameId: string) => `${BASE}/api/v1/frames/${frameId}/image`;
