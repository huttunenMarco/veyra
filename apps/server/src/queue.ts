import { Queue, type ConnectionOptions } from 'bullmq';
import { config } from './config';

export const QUEUE = {
  analysis: 'veyra-analysis',
  automation: 'veyra-automation',
  delivery: 'veyra-delivery',
  scheduler: 'veyra-scheduler',
} as const;

export function redisConnection(): ConnectionOptions {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    username: url.username || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}

const queues = new Map<string, Queue>();
export function getQueue(name: (typeof QUEUE)[keyof typeof QUEUE]): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: redisConnection(),
      defaultJobOptions: { removeOnComplete: { count: 1000, age: 86400 }, removeOnFail: { count: 5000 } },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueueAnalysis(sensorId: string, frameId: string) {
  // jobId makes analysis of the same (sensor, frame) idempotent at the queue level.
  await getQueue(QUEUE.analysis).add(
    'analyze',
    { sensorId, frameId },
    { jobId: `a_${sensorId}_${frameId}`, attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
  );
}

export async function enqueueAutomation(eventId: string) {
  await getQueue(QUEUE.automation).add(
    'evaluate',
    { eventId },
    { jobId: `e_${eventId}`, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  );
}

export const DELIVERY_ATTEMPTS = 5;
export async function enqueueDelivery(executionId: string) {
  await getQueue(QUEUE.delivery).add(
    'deliver',
    { executionId },
    { jobId: `d_${executionId}`, attempts: DELIVERY_ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 } },
  );
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
}
