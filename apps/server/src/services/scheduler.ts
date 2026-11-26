import { and, desc, eq, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { checkStale, evaluateCameraOffline, evaluateDuration, initialState } from '@veyra/shared';
import { config } from '../config';
import { db, schema } from '../db/client';
import { errorMessage } from '../lib/errors';
import { storage } from '../lib/storage';
import { enqueueAnalysis, enqueueAutomation } from '../queue';
import { requestCapture } from './capture';
import { createEvent } from './events';
import { latestFrame, markCameraDown } from './frames';

type Camera = typeof schema.cameras.$inferSelect;
type Sensor = typeof schema.sensors.$inferSelect;

const log = (...args: unknown[]) => console.log('[scheduler]', ...args);

/** A frame younger than this is reused instead of capturing a new one. */
const FRAME_REUSE_MS = 10_000;

export function staleAfterMs(sensor: Pick<Sensor, 'intervalSeconds' | 'stabilization'>): number {
  return (sensor.stabilization.staleAfterSeconds ?? Math.max(sensor.intervalSeconds * 3, 180)) * 1000;
}

function offlineAfterMs(camera: Camera): number {
  return Math.max(camera.captureIntervalSeconds * 3, 120) * 1000;
}

export function isSensorDue(sensor: Sensor, lastObservationAt: Date | null, now: Date): boolean {
  const last = sensor.lastAnalysisRequestedAt;
  if (!last) return true;
  const since = now.getTime() - last.getTime();
  if (since < sensor.intervalSeconds * 1000) return false;
  // Don't stack requests while a previous analysis is still outstanding
  // (e.g. a slow model), unless it has clearly been lost.
  const outstanding = !lastObservationAt || lastObservationAt < last;
  return !outstanding || since > Math.max(sensor.intervalSeconds * 3, 120) * 1000;
}

export async function expireCaptureJobs(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.CAPTURE_JOB_TIMEOUT_SECONDS * 1000);
  const expired = await db
    .update(schema.captureJobs)
    .set({ status: 'expired', error: 'Ingen bild mottogs från kameraagenten inom tidsgränsen', completedAt: now })
    .where(and(inArray(schema.captureJobs.status, ['pending', 'claimed']), lt(schema.captureJobs.createdAt, cutoff)))
    .returning();
  for (const job of expired) {
    const [camera] = await db.select().from(schema.cameras).where(eq(schema.cameras.id, job.cameraId));
    if (camera?.enabled) {
      const msg = job.status === 'claimed' || job.claimedAt ? 'Agenten hämtade jobbet men levererade ingen bild' : 'Kameraagenten svarar inte';
      await markCameraDown(camera, 'error', msg);
    }
  }
}

export async function markAgentsOffline(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.AGENT_OFFLINE_AFTER_SECONDS * 1000);
  await db
    .update(schema.cameraAgents)
    .set({ status: 'offline' })
    .where(and(eq(schema.cameraAgents.status, 'online'), lt(schema.cameraAgents.lastHeartbeatAt, cutoff)));
}

export async function scheduleCaptures(now = new Date()) {
  const cameras = await db
    .select()
    .from(schema.cameras)
    .where(and(eq(schema.cameras.enabled, true), eq(schema.cameras.autoCapture, true), ne(schema.cameras.connectionType, 'manual')));
  if (cameras.length === 0) return;

  const sensors = await db
    .select({ sensor: schema.sensors, lastObservationAt: schema.sensorStates.lastObservationAt })
    .from(schema.sensors)
    .leftJoin(schema.sensorStates, eq(schema.sensorStates.sensorId, schema.sensors.id))
    .where(and(eq(schema.sensors.enabled, true), inArray(schema.sensors.cameraId, cameras.map((c) => c.id))));

  const agents = await db.select().from(schema.cameraAgents);
  const agentById = new Map(agents.map((a) => [a.id, a]));

  for (const camera of cameras) {
    try {
      const due = sensors
        .filter((s) => s.sensor.cameraId === camera.id && isSensorDue(s.sensor, s.lastObservationAt, now))
        .map((s) => s.sensor.id);
      const captureDue =
        !camera.lastCaptureRequestedAt ||
        now.getTime() - camera.lastCaptureRequestedAt.getTime() >= camera.captureIntervalSeconds * 1000;
      if (due.length === 0 && !captureDue) continue;

      // Cameras using a remote agent can only be captured while that agent is online.
      if (camera.connectionType !== 'demo' && camera.agentId) {
        const agent = agentById.get(camera.agentId);
        if (!agent || agent.status !== 'online') {
          const msg = !agent ? 'Fjärragenten finns inte längre' : agent.status === 'revoked' ? 'Fjärragenten är återkallad' : 'Fjärragenten är offline';
          await markCameraDown(camera, 'offline', msg);
          await db.update(schema.cameras).set({ lastCaptureRequestedAt: now }).where(eq(schema.cameras.id, camera.id));
          continue;
        }
      }

      if (due.length > 0) {
        await db.update(schema.sensors).set({ lastAnalysisRequestedAt: now }).where(inArray(schema.sensors.id, due));
      }

      // Reuse a very recent frame (e.g. from "Analysera nu") instead of capturing again.
      if (!captureDue && camera.lastFrameAt && now.getTime() - camera.lastFrameAt.getTime() < FRAME_REUSE_MS) {
        const frame = await latestFrame(camera.id);
        if (frame) {
          await Promise.all(due.map((id) => enqueueAnalysis(id, frame.id)));
          continue;
        }
      }
      await requestCapture(camera, 'scheduled', due);
    } catch (err) {
      log(`capture scheduling failed for camera ${camera.id}: ${errorMessage(err)}`);
    }
  }
}

/** Cameras that stopped delivering frames are marked offline (emits camera_offline once). */
export async function detectOfflineCameras(now = new Date()) {
  const cameras = await db
    .select()
    .from(schema.cameras)
    // Manual-mode cameras get no scheduled frames, so silence is expected and not an outage.
    .where(
      and(
        eq(schema.cameras.enabled, true),
        eq(schema.cameras.autoCapture, true),
        ne(schema.cameras.connectionType, 'manual'),
        ne(schema.cameras.status, 'offline'),
      ),
    );
  for (const camera of cameras) {
    const reference = camera.lastFrameAt ?? camera.createdAt;
    if (now.getTime() - reference.getTime() > offlineAfterMs(camera)) {
      await markCameraDown(camera, 'offline', camera.statusMessage ?? 'Inga bilder mottagna på länge');
    }
  }
  // Errored cameras count as offline for offline rules after the same window.
  await db
    .update(schema.cameras)
    .set({ status: 'offline' })
    .where(
      and(
        eq(schema.cameras.status, 'error'),
        lt(schema.cameras.offlineSince, new Date(now.getTime() - 120_000)),
      ),
    );
}

/** Mark sensor states stale when no observation arrived in time. */
export async function detectStaleSensors(now = new Date()) {
  const rows = await db
    .select({ sensor: schema.sensors })
    .from(schema.sensors)
    .innerJoin(schema.cameras, eq(schema.cameras.id, schema.sensors.cameraId))
    .where(
      and(
        eq(schema.sensors.enabled, true),
        eq(schema.cameras.enabled, true),
        eq(schema.cameras.autoCapture, true),
        ne(schema.cameras.connectionType, 'manual'),
      ),
    );

  for (const { sensor } of rows) {
    const eventIds: string[] = [];
    await db.transaction(async (tx) => {
      await tx.insert(schema.sensorStates).values({ sensorId: sensor.id }).onConflictDoNothing();
      const [s] = await tx.select().from(schema.sensorStates).where(eq(schema.sensorStates.sensorId, sensor.id)).for('update');
      if (!s) return;
      const engine = {
        ...initialState(),
        value: s.value ?? null,
        status: s.status,
        confirmedAt: s.confirmedAt,
        lastObservationAt: s.lastObservationAt,
      };
      const r = checkStale(engine, now, staleAfterMs(sensor), sensor.createdAt);
      if (!r.applied) return;
      await tx
        .update(schema.sensorStates)
        .set({ status: 'stale', candidateValue: null, candidateCount: 0, updatedAt: now })
        .where(eq(schema.sensorStates.sensorId, sensor.id));
      const ev = await createEvent(
        {
          organizationId: sensor.organizationId,
          eventType: 'sensor_unavailable',
          dedupeKey: `stale:${sensor.id}:${(s.lastObservationAt ?? sensor.createdAt).toISOString()}`,
          cameraId: sensor.cameraId,
          sensorId: sensor.id,
          previousValue: s.value ?? null,
          metadata: { reason: 'stale' },
          occurredAt: now,
        },
        tx,
      );
      if (ev) eventIds.push(ev.id);
    });
    for (const id of eventIds) await enqueueAutomation(id);
  }
}

/** Duration and camera-offline rules are evaluated against current state, once per occurrence. */
export async function evaluateTimeBasedRules(now = new Date()) {
  const rules = await db
    .select()
    .from(schema.automationRules)
    .where(and(eq(schema.automationRules.enabled, true), inArray(schema.automationRules.triggerType, ['duration', 'camera_offline'])));

  for (const rule of rules) {
    let since: Date | null = null;
    let cameraId: string | null = rule.cameraId;
    let currentValue = null;
    const t = rule.trigger;
    if (t.type === 'duration' && rule.sensorId) {
      const [row] = await db
        .select({ state: schema.sensorStates, cameraId: schema.sensors.cameraId })
        .from(schema.sensorStates)
        .innerJoin(schema.sensors, eq(schema.sensors.id, schema.sensorStates.sensorId))
        .where(eq(schema.sensorStates.sensorId, rule.sensorId));
      if (!row) continue;
      since = evaluateDuration(t, row.state, now);
      cameraId = row.cameraId;
      currentValue = row.state.value;
    } else if (t.type === 'camera_offline' && rule.cameraId) {
      const [camera] = await db.select().from(schema.cameras).where(eq(schema.cameras.id, rule.cameraId));
      if (!camera || !camera.enabled) continue;
      since = evaluateCameraOffline(t, { status: camera.status === 'error' ? 'offline' : camera.status, offlineSince: camera.offlineSince }, now);
    }
    if (!since) continue;

    const ev = await createEvent({
      organizationId: rule.organizationId,
      eventType: t.type === 'duration' ? 'duration_reached' : 'camera_offline',
      dedupeKey: `rule:${rule.id}:${since.toISOString()}`,
      cameraId,
      sensorId: rule.sensorId,
      currentValue,
      metadata: { ruleId: rule.id, since: since.toISOString(), durationSeconds: 'durationSeconds' in t ? t.durationSeconds : null },
      occurredAt: now,
    });
    if (ev) await enqueueAutomation(ev.id);
  }
}

/** Retention: delete expired snapshots (keeping each camera's latest), old observations and events. */
export async function cleanup(now = new Date()) {
  const latestPerCamera = db
    .selectDistinctOn([schema.cameraFrames.cameraId], { id: schema.cameraFrames.id })
    .from(schema.cameraFrames)
    .where(isNull(schema.cameraFrames.deletedAt))
    .orderBy(schema.cameraFrames.cameraId, desc(schema.cameraFrames.capturedAt));

  const expired = await db
    .select()
    .from(schema.cameraFrames)
    .where(
      and(
        isNull(schema.cameraFrames.deletedAt),
        lt(schema.cameraFrames.expiresAt, now),
        notInArray(schema.cameraFrames.id, latestPerCamera),
      ),
    )
    .limit(500);
  for (const f of expired) {
    await storage.delete(f.storageKey).catch(() => {});
    await db.update(schema.cameraFrames).set({ deletedAt: now }).where(eq(schema.cameraFrames.id, f.id));
  }

  const orgs = await db.select().from(schema.organizations);
  for (const org of orgs) {
    const obsCutoff = new Date(now.getTime() - org.observationRetentionDays * 86_400_000);
    const evCutoff = new Date(now.getTime() - org.eventRetentionDays * 86_400_000);
    await db.execute(sql`
      delete from sensor_observations o using sensors s
      where o.sensor_id = s.id and s.organization_id = ${org.id} and o.observed_at < ${obsCutoff.toISOString()}::timestamptz
        and not exists (select 1 from sensor_states st where st.last_observation_id = o.id)`);
    await db.delete(schema.events).where(and(eq(schema.events.organizationId, org.id), lt(schema.events.occurredAt, evCutoff)));
  }
  await db
    .delete(schema.captureJobs)
    .where(and(notInArray(schema.captureJobs.status, ['pending', 'claimed']), lt(schema.captureJobs.createdAt, new Date(now.getTime() - 86_400_000))));
  if (expired.length) log(`cleanup removed ${expired.length} snapshots`);
}

let lastCleanup = 0;
export async function tick() {
  const now = new Date();
  const steps: Array<[string, () => Promise<void>]> = [
    ['expireCaptureJobs', () => expireCaptureJobs(now)],
    ['markAgentsOffline', () => markAgentsOffline(now)],
    ['scheduleCaptures', () => scheduleCaptures(now)],
    ['detectOfflineCameras', () => detectOfflineCameras(now)],
    ['detectStaleSensors', () => detectStaleSensors(now)],
    ['evaluateTimeBasedRules', () => evaluateTimeBasedRules(now)],
  ];
  if (Date.now() - lastCleanup > 3_600_000) {
    lastCleanup = Date.now();
    steps.push(['cleanup', () => cleanup(now)]);
  }
  // Each step is isolated so one failure doesn't block the rest.
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      log(`${name} failed: ${errorMessage(err)}`);
    }
  }
}
