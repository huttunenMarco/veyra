import { assertAllowedTarget } from './allowlist';
import { captureFrame, redact, type CaptureJob } from '@veyra/capture';
import { AgentClient, ApiError, loadOrEnroll } from './client';
import { config, VERSION } from './config';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 1000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      // Client errors (except timeouts/rate limits) won't succeed on retry.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) throw err;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

export type AgentJob = CaptureJob & { jobId: string; cameraId: string; cameraName: string };

async function processJob(client: AgentClient, job: AgentJob) {
  const started = Date.now();
  const secrets = [job.password, job.username];
  try {
    await assertAllowedTarget(job.url);
    const jpeg = await captureFrame(job);
    await withRetry(() => client.uploadFrame(job.jobId, jpeg));
    log(`✓ ${job.cameraName}: ${Math.round(jpeg.length / 1024)} kB på ${Date.now() - started} ms`);
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), secrets);
    log(`✗ ${job.cameraName}: ${message}`);
    await withRetry(() => client.fail(job.jobId, message)).catch((e) => log(`kunde inte rapportera fel: ${e.message}`));
  }
}

async function main() {
  log(`Veyra camera agent ${VERSION} → ${config.apiUrl}`);
  const state = await loadOrEnroll();
  log(`Registrerad som "${state.name}" (${state.agentId})`);
  const client = new AgentClient(state.agentToken);

  let stopping = false;
  const stop = () => {
    stopping = true;
    log('Stänger av…');
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const heartbeat = async () => {
    try {
      await client.heartbeat();
    } catch (err) {
      log(`heartbeat misslyckades: ${(err as Error).message}`);
      if (err instanceof ApiError && err.status === 401) {
        log('Agentens nyckel är återkallad. Registrera om med en ny VEYRA_ENROLLMENT_TOKEN.');
        process.exit(1);
      }
    }
  };
  await heartbeat();
  setInterval(heartbeat, config.heartbeatMs).unref();

  const active = new Set<Promise<void>>();
  let backoff = 1000;
  while (!stopping) {
    try {
      while (active.size >= config.maxConcurrentJobs) await Promise.race(active);
      const jobs = await client.poll(20);
      backoff = 1000;
      for (const job of jobs) {
        const p = processJob(client, job).finally(() => active.delete(p));
        active.add(p);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        log('Agenten är inte längre behörig (återkallad?). Avslutar.');
        process.exit(1);
      }
      log(`kunde inte hämta jobb: ${(err as Error).message} — försöker igen om ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

main().catch((err) => {
  log(`Fel: ${err.message}`);
  process.exit(1);
});
