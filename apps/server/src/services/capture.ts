import { and, eq, inArray, sql } from 'drizzle-orm';
import { captureFrame } from '@veyra/capture';
import { db, schema } from '../db/client';
import { renderDemoFrame } from '../lib/demo-frames';
import { config } from '../config';
import { AppError, badRequest, errorMessage } from '../lib/errors';
import { enqueueAnalysis } from '../queue';
import { getConnection } from './cameras';
import { ingestFrame, latestFrame, markCameraDown, type Frame } from './frames';

type Camera = typeof schema.cameras.$inferSelect;
type CaptureJob = typeof schema.captureJobs.$inferSelect;

export type CaptureResult = { kind: 'frame'; frame: Frame } | { kind: 'job'; job: CaptureJob };

/**
 * Request a fresh frame for a camera and (optionally) analysis of the given sensors.
 * - demo: rendered immediately
 * - manual: reuses the latest uploaded image
 * - rtsp / http_snapshot: creates a capture job, run by this server (built-in) or, for cameras
 *   on another network, by a remote camera agent
 * At most one active capture job exists per camera; concurrent requests merge their sensors.
 */
export async function requestCapture(
  camera: Camera,
  reason: CaptureJob['reason'],
  sensorIds: string[] = [],
): Promise<CaptureResult> {
  await db.update(schema.cameras).set({ lastCaptureRequestedAt: new Date() }).where(eq(schema.cameras.id, camera.id));

  if (camera.connectionType === 'demo') {
    const scene = getConnection(camera).demoScene ?? 'warehouse';
    const frame = await ingestFrame(camera, await renderDemoFrame(scene), 'demo');
    await Promise.all(sensorIds.map((id) => enqueueAnalysis(id, frame.id)));
    return { kind: 'frame', frame };
  }

  if (camera.connectionType === 'manual') {
    const frame = await latestFrame(camera.id);
    if (!frame) throw badRequest('Ingen bild har laddats upp för den här kameran ännu');
    await Promise.all(sensorIds.map((id) => enqueueAnalysis(id, frame.id)));
    return { kind: 'frame', frame };
  }

  if (!camera.agentId) return requestBuiltinCapture(camera, reason, sensorIds);

  const [agent] = await db.select().from(schema.cameraAgents).where(eq(schema.cameraAgents.id, camera.agentId));
  if (!agent || agent.status === 'revoked') {
    await markCameraDown(camera, 'error', 'Kameraagenten är återkallad eller saknas');
    throw new AppError(409, 'agent_unavailable', 'Kameraagenten är återkallad eller saknas');
  }

  const inserted = await db
    .insert(schema.captureJobs)
    .values({ cameraId: camera.id, agentId: camera.agentId, reason, sensorIds })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { kind: 'job', job: inserted[0] };

  // An active job exists: merge the requested sensors into it instead of capturing twice.
  const existing = await mergeIntoActiveJob(camera.id, sensorIds);
  if (existing) return { kind: 'job', job: existing };
  // Raced with completion; try once more.
  return requestCapture(camera, reason, sensorIds);
}

/** Merge sensors into the camera's active job (used when a capture is already in progress). */
async function mergeIntoActiveJob(cameraId: string, sensorIds: string[]) {
  const [existing] = await db
    .update(schema.captureJobs)
    .set({
      sensorIds: sql`(select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(${schema.captureJobs.sensorIds} || ${JSON.stringify(sensorIds)}::jsonb) as x)`,
    })
    .where(and(eq(schema.captureJobs.cameraId, cameraId), inArray(schema.captureJobs.status, ['pending', 'claimed'])))
    .returning();
  return existing ?? null;
}

// Built-in capture: the server reaches the camera directly (it's on the same network).
const MAX_PARALLEL_CAPTURES = 3;
let running = 0;
const waiting: Array<() => void> = [];
async function withCaptureSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_CAPTURES) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function requestBuiltinCapture(camera: Camera, reason: CaptureJob['reason'], sensorIds: string[]): Promise<CaptureResult> {
  const [job] = await db
    .insert(schema.captureJobs)
    .values({ cameraId: camera.id, agentId: null, reason, sensorIds, status: 'claimed', claimedAt: new Date(), attempts: 1 })
    .onConflictDoNothing()
    .returning();
  if (!job) {
    const existing = await mergeIntoActiveJob(camera.id, sensorIds);
    return existing ? { kind: 'job', job: existing } : requestCapture(camera, reason, sensorIds);
  }
  void runBuiltinCapture(job, camera);
  return { kind: 'job', job };
}

async function runBuiltinCapture(job: CaptureJob, camera: Camera) {
  try {
    const conn = getConnection(camera);
    const url = camera.connectionType === 'rtsp' ? conn.rtspUrl : conn.httpUrl;
    if (!url) throw new Error('Kameran saknar adress');
    const jpeg = await withCaptureSlot(() =>
      captureFrame({
        type: camera.connectionType === 'rtsp' ? 'rtsp' : 'http_snapshot',
        url,
        username: conn.username ?? null,
        password: conn.password ?? null,
        rtspTransport: conn.rtspTransport,
      }),
    );
    const frame = await ingestFrame(camera, jpeg, 'agent');
    // Re-read: other requests may have merged more sensors into the job meanwhile.
    const [current] = await db.select().from(schema.captureJobs).where(eq(schema.captureJobs.id, job.id));
    await completeCaptureJob(current ?? job, frame);
  } catch (err) {
    await failCaptureJob(job, errorMessage(err)).catch(() => {});
  }
}

/** Wait until a capture job finishes (or times out). */
export async function waitForJob(jobId: string, timeoutMs: number): Promise<CaptureJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [job] = await db.select().from(schema.captureJobs).where(eq(schema.captureJobs.id, jobId));
    if (!job) throw new Error('Capture job disappeared');
    if (!['pending', 'claimed'].includes(job.status) || Date.now() > deadline) return job;
    await new Promise((r) => setTimeout(r, 400));
  }
}

export async function completeCaptureJob(job: CaptureJob, frame: Frame) {
  await db
    .update(schema.captureJobs)
    .set({ status: 'completed', frameId: frame.id, completedAt: new Date() })
    .where(eq(schema.captureJobs.id, job.id));
  await Promise.all(job.sensorIds.map((id) => enqueueAnalysis(id, frame.id)));
}

export async function failCaptureJob(job: CaptureJob, error: string) {
  await db
    .update(schema.captureJobs)
    .set({ status: 'failed', error: error.slice(0, 1000), completedAt: new Date() })
    .where(eq(schema.captureJobs.id, job.id));
  const [camera] = await db.select().from(schema.cameras).where(eq(schema.cameras.id, job.cameraId));
  if (camera) await markCameraDown(camera, 'error', error.slice(0, 500));
}

/** Fetch a fresh frame (waits for the agent when needed). */
export async function captureNow(camera: Camera, reason: 'manual' | 'test'): Promise<Frame> {
  const res = await requestCapture(camera, reason, []);
  if (res.kind === 'frame') return res.frame;
  const job = await waitForJob(res.job.id, config.CAPTURE_JOB_TIMEOUT_SECONDS * 1000);
  if (job.status === 'completed' && job.frameId) {
    const [frame] = await db.select().from(schema.cameraFrames).where(eq(schema.cameraFrames.id, job.frameId));
    if (frame) return frame;
  }
  if (job.status === 'pending') {
    throw new AppError(504, 'capture_timeout', 'Fjärragenten hämtade inte jobbet i tid. Kontrollera att agenten körs.');
  }
  if (job.status === 'claimed') {
    throw new AppError(504, 'capture_timeout', 'Ingen bild kom från kameran i tid. Kontrollera RTSP-adressen och nätverket.');
  }
  throw new AppError(502, 'capture_failed', job.error ?? 'Bildtagningen misslyckades');
}

