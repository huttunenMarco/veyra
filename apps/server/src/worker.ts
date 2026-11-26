import { Worker } from 'bullmq';
import { config } from './config';
import { errorMessage } from './lib/errors';
import { DELIVERY_ATTEMPTS, getQueue, QUEUE, redisConnection } from './queue';
import { analyzeSensorFrame } from './services/analysis';
import { processEvent } from './services/automations';
import { runExecution } from './services/delivery';
import { tick } from './services/scheduler';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Start background processing: analyses, automations, deliveries and the scheduler tick. */
export async function startWorker(): Promise<{ close: () => Promise<void> }> {
  const connection = redisConnection();
  // Bounded concurrency per queue. Each analysis job is independent, so a failing
  // sensor never blocks unrelated sensors.
  const workers = [
    new Worker(
      QUEUE.analysis,
      async (job) => {
        const obs = await analyzeSensorFrame(job.data.sensorId, job.data.frameId);
        return obs ? { observationId: obs.id, status: obs.status } : null;
      },
      { connection, concurrency: 4 },
    ),
    new Worker(QUEUE.automation, async (job) => processEvent(job.data.eventId), { connection, concurrency: 5 }),
    new Worker(
      QUEUE.delivery,
      async (job) => {
        const { retry } = await runExecution(job.data.executionId, job.attemptsMade + 1, job.opts.attempts ?? DELIVERY_ATTEMPTS);
        if (retry) throw new Error('Leveransen misslyckades, försöker igen');
        return { ok: true };
      },
      { connection, concurrency: 5, limiter: { max: 20, duration: 1000 } },
    ),
    new Worker(QUEUE.scheduler, async () => tick(), { connection, concurrency: 1 }),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => log(`[${w.name}] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${errorMessage(err)}`));
    w.on('error', (err) => log(`[${w.name}] error: ${errorMessage(err)}`));
  }

  // Single repeatable scheduler job (BullMQ dedupes the scheduler across processes).
  await getQueue(QUEUE.scheduler).upsertJobScheduler(
    'tick',
    { every: config.SCHEDULER_TICK_SECONDS * 1000 },
    { name: 'tick', opts: { removeOnComplete: true, removeOnFail: 100 } },
  );

  return { close: async () => void (await Promise.all(workers.map((w) => w.close()))) };
}
