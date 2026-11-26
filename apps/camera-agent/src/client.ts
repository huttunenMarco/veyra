import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { config, VERSION } from './config';

interface AgentState {
  apiUrl: string;
  agentId: string;
  agentToken: string;
  name: string;
  /** Hash of the enrollment code this credential came from. */
  enrolledWith?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const info = () => ({ version: VERSION, hostname: config.hostname, platform: config.platform });

async function request(path: string, init: RequestInit & { token?: string; timeoutMs?: number } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  headers.set('User-Agent', `veyra-camera-agent/${VERSION}`);
  const res = await fetch(`${config.apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(res.status, body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<unknown>;
}

export async function loadOrEnroll(): Promise<AgentState> {
  const tokenHash = config.enrollmentToken ? createHash('sha256').update(config.enrollmentToken).digest('hex') : null;
  try {
    const state = JSON.parse(await readFile(config.stateFile, 'utf8')) as AgentState;
    // Re-enroll only when a *new* enrollment code is supplied (e.g. after a revoke);
    // leaving the old code in the environment must not break restarts.
    if (state.apiUrl === config.apiUrl && state.agentToken && (!tokenHash || state.enrolledWith === tokenHash)) return state;
  } catch {
    /* not enrolled yet */
  }
  if (!config.enrollmentToken) {
    throw new Error(
      'Agenten är inte registrerad. Skapa en agent i Veyra (Inställningar → Kameraagenter) och starta med VEYRA_ENROLLMENT_TOKEN=<kod>.',
    );
  }
  const res = (await request('/agent/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollmentToken: config.enrollmentToken, ...info() }),
  })) as { agentId: string; agentToken: string; name: string };
  const state: AgentState = { apiUrl: config.apiUrl, ...res, enrolledWith: tokenHash ?? undefined };
  await writeFile(config.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(config.stateFile, 0o600).catch(() => {});
  return state;
}

export class AgentClient {
  constructor(private token: string) {}

  heartbeat() {
    return request('/agent/v1/heartbeat', {
      method: 'POST',
      token: this.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(info()),
    });
  }

  async poll(waitSeconds = 20) {
    const res = (await request(`/agent/v1/jobs?wait=${waitSeconds}`, { token: this.token, timeoutMs: (waitSeconds + 15) * 1000 })) as {
      jobs: import('./index').AgentJob[];
    };
    return res.jobs;
  }

  uploadFrame(jobId: string, jpeg: Buffer) {
    return request(`/agent/v1/jobs/${jobId}/frame`, {
      method: 'POST',
      token: this.token,
      headers: { 'Content-Type': 'image/jpeg' },
      body: new Uint8Array(jpeg),
      timeoutMs: 60_000,
    });
  }

  fail(jobId: string, error: string) {
    return request(`/agent/v1/jobs/${jobId}/fail`, {
      method: 'POST',
      token: this.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    });
  }
}
