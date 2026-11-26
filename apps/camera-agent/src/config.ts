import os from 'node:os';

export const VERSION = '0.1.0';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  apiUrl: (process.env.VEYRA_API_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
  enrollmentToken: process.env.VEYRA_ENROLLMENT_TOKEN?.trim() || null,
  stateFile: process.env.VEYRA_STATE_FILE ?? '.veyra-agent.json',
  allowedHosts: (process.env.VEYRA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  maxConcurrentJobs: Math.max(1, num(process.env.MAX_CONCURRENT_JOBS, 2)),
  heartbeatMs: 20_000,
  hostname: os.hostname(),
  platform: `${os.platform()}-${os.arch()} node${process.versions.node}`,
};
