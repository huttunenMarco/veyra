import { and, count, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cameraCreateSchema,
  cameraUpdateSchema,
  zoneCreateSchema,
  zoneUpdateSchema,
  type CameraConnection,
} from '@veyra/shared';
import { config } from '../../config';
import { db, schema } from '../../db/client';
import { audit } from '../../lib/audit';
import { AppError, badRequest } from '../../lib/errors';
import { storage } from '../../lib/storage';
import { analyzeSensorFrame } from '../../services/analysis';
import { deleteStoredFiles, exampleKeysForSensors } from '../../services/examples';
import { encryptConnection, getConnection, publicCamera, splitUrlCredentials } from '../../services/cameras';
import { captureNow } from '../../services/capture';
import { ingestFrame, latestFrame, type Frame } from '../../services/frames';
import { loadAgent, loadCamera, loadFrame, loadZone } from '../loaders';
import { route, uuidParam } from '../route';
import { sensorsWithState } from './sensors';

const frameMeta = (f: Frame | null) =>
  f && { id: f.id, width: f.width, height: f.height, capturedAt: f.capturedAt, source: f.source };

/** Move credentials embedded in the URL into separate (encrypted) fields. */
function normalizeConnection(conn: CameraConnection): CameraConnection {
  const out = { ...conn };
  for (const key of ['rtspUrl', 'httpUrl'] as const) {
    const raw = out[key];
    if (!raw) continue;
    const split = splitUrlCredentials(raw);
    out[key] = split.url;
    if (split.username && !out.username) out.username = split.username;
    if (split.password && !out.password) out.password = split.password;
  }
  return out;
}

export function cameraRoutes(app: FastifyInstance) {
  route(app, { method: 'GET', url: '/api/v1/cameras', summary: 'Lista kameror', tag: 'Kameror' }, async ({ auth }) => {
    const cams = await db
      .select()
      .from(schema.cameras)
      .where(eq(schema.cameras.organizationId, auth.organizationId))
      .orderBy(schema.cameras.createdAt);
    const ids = cams.map((c) => c.id);
    if (ids.length === 0) return { data: [] };

    const [zoneCounts, sensorCounts, lastAnalysis, frames] = await Promise.all([
      db.select({ cameraId: schema.zones.cameraId, n: count() }).from(schema.zones).where(and(inArray(schema.zones.cameraId, ids), eq(schema.zones.enabled, true))).groupBy(schema.zones.cameraId),
      db.select({ cameraId: schema.sensors.cameraId, n: count() }).from(schema.sensors).where(inArray(schema.sensors.cameraId, ids)).groupBy(schema.sensors.cameraId),
      db
        .select({ cameraId: schema.sensors.cameraId, at: max(schema.sensorStates.lastObservationAt) })
        .from(schema.sensorStates)
        .innerJoin(schema.sensors, eq(schema.sensors.id, schema.sensorStates.sensorId))
        .where(inArray(schema.sensors.cameraId, ids))
        .groupBy(schema.sensors.cameraId),
      db
        .selectDistinctOn([schema.cameraFrames.cameraId])
        .from(schema.cameraFrames)
        .where(and(inArray(schema.cameraFrames.cameraId, ids), isNull(schema.cameraFrames.deletedAt)))
        .orderBy(schema.cameraFrames.cameraId, desc(schema.cameraFrames.capturedAt)),
    ]);
    const by = <T extends { cameraId: string }>(rows: T[]) => new Map(rows.map((r) => [r.cameraId, r]));
    const z = by(zoneCounts);
    const s = by(sensorCounts);
    const a = by(lastAnalysis);
    const f = by(frames);
    return {
      data: cams.map((c) => ({
        ...publicCamera(c),
        zoneCount: z.get(c.id)?.n ?? 0,
        sensorCount: s.get(c.id)?.n ?? 0,
        lastAnalysisAt: a.get(c.id)?.at ?? null,
        latestFrame: frameMeta(f.get(c.id) ?? null),
      })),
    };
  });

  route(app, { method: 'POST', url: '/api/v1/cameras', summary: 'Skapa kamera', tag: 'Kameror', body: cameraCreateSchema }, async ({ auth, body }) => {
    if (body.agentId) await loadAgent(auth.organizationId, body.agentId);
    const needsAgent = body.connectionType === 'rtsp' || body.connectionType === 'http_snapshot';
    const connection = normalizeConnection({
      ...body.connection,
      demoScene: body.connectionType === 'demo' ? (body.connection.demoScene ?? 'warehouse') : undefined,
    });
    const [camera] = await db
      .insert(schema.cameras)
      .values({
        organizationId: auth.organizationId,
        agentId: needsAgent ? body.agentId : null,
        name: body.name,
        description: body.description,
        location: body.location,
        connectionType: body.connectionType,
        encryptedConnectionConfig: encryptConnection(connection),
        captureIntervalSeconds: body.captureIntervalSeconds,
        autoCapture: body.autoCapture,
        enabled: body.enabled,
        status: body.enabled ? 'connecting' : 'disabled',
      })
      .returning();
    await audit(auth.organizationId, 'camera.create', 'camera', camera!.id, { connectionType: body.connectionType });
    return publicCamera(camera!);
  });

  route(app, { method: 'GET', url: '/api/v1/cameras/:id', summary: 'Hämta kamera med zoner och sensorer', tag: 'Kameror' }, async ({ auth, params }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    const [zones, sensors, frame, agent] = await Promise.all([
      db.select().from(schema.zones).where(eq(schema.zones.cameraId, camera.id)).orderBy(schema.zones.createdAt),
      sensorsWithState(auth.organizationId, { cameraId: camera.id }),
      latestFrame(camera.id),
      camera.agentId ? db.select().from(schema.cameraAgents).where(eq(schema.cameraAgents.id, camera.agentId)).then((r) => r[0]) : null,
    ]);
    return {
      ...publicCamera(camera),
      zones,
      sensors,
      latestFrame: frameMeta(frame),
      agent: agent ? { id: agent.id, name: agent.name, status: agent.status, lastHeartbeatAt: agent.lastHeartbeatAt } : null,
    };
  });

  route(app, { method: 'PATCH', url: '/api/v1/cameras/:id', summary: 'Uppdatera kamera', tag: 'Kameror', body: cameraUpdateSchema }, async ({ auth, params, body }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    if (body.agentId) await loadAgent(auth.organizationId, body.agentId);
    const patch: Partial<typeof schema.cameras.$inferInsert> = {};
    for (const k of ['name', 'description', 'location', 'captureIntervalSeconds', 'agentId', 'autoCapture'] as const) {
      if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    }
    if (body.enabled !== undefined) {
      patch.enabled = body.enabled;
      patch.status = body.enabled ? 'connecting' : 'disabled';
      if (body.enabled) patch.offlineSince = null;
    }
    if (body.connection) {
      const current = getConnection(camera);
      const next: CameraConnection = { ...current };
      for (const [k, v] of Object.entries(body.connection)) {
        // Empty credential fields mean "keep the stored value".
        if (v === undefined || ((k === 'password' || k === 'username') && v === '')) continue;
        (next as Record<string, unknown>)[k] = v;
      }
      patch.encryptedConnectionConfig = encryptConnection(normalizeConnection(next));
      await audit(auth.organizationId, 'camera.connection_update', 'camera', camera.id, {
        fields: Object.keys(body.connection),
      });
    }
    const [updated] = await db.update(schema.cameras).set(patch).where(eq(schema.cameras.id, camera.id)).returning();
    return publicCamera(updated!);
  });

  route(app, { method: 'DELETE', url: '/api/v1/cameras/:id', summary: 'Ta bort kamera och all tillhörande data', tag: 'Kameror' }, async ({ auth, params }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    const frames = await db.select({ key: schema.cameraFrames.storageKey }).from(schema.cameraFrames).where(eq(schema.cameraFrames.cameraId, camera.id));
    const sensorIds = (await db.select({ id: schema.sensors.id }).from(schema.sensors).where(eq(schema.sensors.cameraId, camera.id))).map((s) => s.id);
    const exampleFiles = await exampleKeysForSensors(sensorIds);
    // Rules attached only to this camera's sensors cascade via FK.
    await db.delete(schema.cameras).where(eq(schema.cameras.id, camera.id));
    await deleteStoredFiles([...frames.map((f) => f.key), ...exampleFiles]);
    await audit(auth.organizationId, 'camera.delete', 'camera', camera.id, { name: camera.name, frames: frames.length });
  });

  route(app, { method: 'POST', url: '/api/v1/cameras/:id/test', summary: 'Testa anslutning (hämtar en bild)', tag: 'Kameror' }, async ({ auth, params }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    const started = Date.now();
    try {
      const frame = await captureNow(camera, 'test');
      return { ok: true, durationMs: Date.now() - started, frame: frameMeta(frame) };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, durationMs: Date.now() - started, code: err.code, error: err.message };
      throw err;
    }
  });

  route(app, { method: 'POST', url: '/api/v1/cameras/:id/analyze', summary: 'Ta en ny bild och analysera alla sensorer', tag: 'Kameror' }, async ({ auth, params }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    const sensors = await db
      .select()
      .from(schema.sensors)
      .where(and(eq(schema.sensors.cameraId, camera.id), eq(schema.sensors.enabled, true)));
    const frame = await captureNow(camera, 'manual');
    if (sensors.length) {
      await db.update(schema.sensors).set({ lastAnalysisRequestedAt: new Date() }).where(inArray(schema.sensors.id, sensors.map((s) => s.id)));
    }
    // Each sensor is analyzed independently; one failure doesn't affect the others.
    const observations = await Promise.all(sensors.map((s) => analyzeSensorFrame(s.id, frame.id).catch(() => null)));
    return { frame: frameMeta(frame), observations: observations.filter(Boolean) };
  });

  route(
    app,
    { method: 'POST', url: '/api/v1/cameras/:id/upload', summary: 'Ladda upp en bild (manuell källa)', tag: 'Kameror', binaryBody: 'image/jpeg', bodyLimit: config.MAX_UPLOAD_BYTES },
    async ({ auth, params, req }) => {
      const camera = await loadCamera(auth.organizationId, uuidParam(params));
      if (camera.connectionType !== 'manual') throw badRequest('Uppladdning stöds bara för kameror med manuell bildkälla');
      if (!Buffer.isBuffer(req.body)) throw badRequest('Skicka bilden som binär data (image/jpeg, image/png eller image/webp)');
      const frame = await ingestFrame(camera, req.body, 'upload');
      const sensors = await db.select().from(schema.sensors).where(and(eq(schema.sensors.cameraId, camera.id), eq(schema.sensors.enabled, true)));
      const observations = await Promise.all(sensors.map((s) => analyzeSensorFrame(s.id, frame.id).catch(() => null)));
      return { frame: frameMeta(frame), observations: observations.filter(Boolean) };
    },
  );

  route(app, { method: 'GET', url: '/api/v1/cameras/:id/snapshot', summary: 'Senaste bild (JPEG)', tag: 'Kameror' }, async ({ auth, params, reply }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    const frame = await latestFrame(camera.id);
    if (!frame) throw new AppError(404, 'no_frame', 'Ingen bild finns ännu');
    const data = await storage.get(frame.storageKey);
    reply.header('Cache-Control', 'private, max-age=5').header('X-Frame-Id', frame.id).type('image/jpeg').send(data);
  });

  route(app, { method: 'GET', url: '/api/v1/frames/:id/image', summary: 'Hämta en lagrad bild (JPEG)', tag: 'Kameror' }, async ({ auth, params, reply }) => {
    const frame = await loadFrame(auth.organizationId, uuidParam(params));
    const data = await storage.get(frame.storageKey).catch(() => null);
    if (!data) throw new AppError(404, 'no_frame', 'Bilden har raderats');
    reply.header('Cache-Control', 'private, max-age=86400, immutable').type('image/jpeg').send(data);
  });

  // Zones
  route(app, { method: 'GET', url: '/api/v1/cameras/:id/zones', summary: 'Lista zoner', tag: 'Zoner' }, async ({ auth, params }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    return { data: await db.select().from(schema.zones).where(eq(schema.zones.cameraId, camera.id)).orderBy(schema.zones.createdAt) };
  });

  route(app, { method: 'POST', url: '/api/v1/cameras/:id/zones', summary: 'Skapa zon', tag: 'Zoner', body: zoneCreateSchema }, async ({ auth, params, body }) => {
    const camera = await loadCamera(auth.organizationId, uuidParam(params));
    const [zone] = await db.insert(schema.zones).values({ ...body, cameraId: camera.id }).returning();
    return zone;
  });

  route(app, { method: 'PATCH', url: '/api/v1/zones/:id', summary: 'Uppdatera zon', tag: 'Zoner', body: zoneUpdateSchema }, async ({ auth, params, body }) => {
    const zone = await loadZone(auth.organizationId, uuidParam(params));
    const [updated] = await db.update(schema.zones).set(body).where(eq(schema.zones.id, zone.id)).returning();
    return updated;
  });

  route(
    app,
    { method: 'DELETE', url: '/api/v1/zones/:id', summary: 'Ta bort zon (och dess sensorer)', tag: 'Zoner', query: z.object({}).passthrough() },
    async ({ auth, params }) => {
      const zone = await loadZone(auth.organizationId, uuidParam(params));
      const sensorIds = (await db.select({ id: schema.sensors.id }).from(schema.sensors).where(eq(schema.sensors.zoneId, zone.id))).map((s) => s.id);
      const exampleFiles = await exampleKeysForSensors(sensorIds);
      await db.delete(schema.zones).where(eq(schema.zones.id, zone.id));
      await deleteStoredFiles(exampleFiles);
      await audit(auth.organizationId, 'zone.delete', 'zone', zone.id, { name: zone.name });
    },
  );
}
