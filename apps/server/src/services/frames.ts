import { and, desc, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema } from '../db/client';
import { badRequest } from '../lib/errors';
import { storage } from '../lib/storage';
import { enqueueAutomation } from '../queue';
import { createEvent } from './events';

type Camera = typeof schema.cameras.$inferSelect;
export type Frame = typeof schema.cameraFrames.$inferSelect;

const MAX_PIXELS = 8192 * 8192;

/** Validate an untrusted image and re-encode it as JPEG (strips metadata, normalizes orientation). */
export async function normalizeImage(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw badRequest('Filen är inte en giltig bild');
  }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
    throw badRequest('Bildformatet stöds inte (JPEG, PNG eller WebP)');
  }
  const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function ingestFrame(
  camera: Camera,
  image: Buffer,
  source: Frame['source'],
  capturedAt = new Date(),
): Promise<Frame> {
  const { data, width, height } = await normalizeImage(image);
  const [org] = await db
    .select({ hours: schema.organizations.snapshotRetentionHours })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, camera.organizationId));
  const frameId = crypto.randomUUID();
  const storageKey = `frames/${camera.organizationId}/${camera.id}/${frameId}.jpg`;
  await storage.put(storageKey, data);

  const [frame] = await db
    .insert(schema.cameraFrames)
    .values({
      id: frameId,
      cameraId: camera.id,
      storageKey,
      width,
      height,
      sizeBytes: data.length,
      source,
      capturedAt,
      expiresAt: new Date(capturedAt.getTime() + (org?.hours ?? 72) * 3_600_000),
    })
    .returning();

  await markCameraOnline(camera, capturedAt);
  return frame!;
}

export async function markCameraOnline(camera: Camera, at = new Date()) {
  const wasDown = camera.status === 'offline' || camera.status === 'error';
  await db
    .update(schema.cameras)
    .set({ status: camera.enabled ? 'online' : 'disabled', statusMessage: null, offlineSince: null, lastFrameAt: at })
    .where(eq(schema.cameras.id, camera.id));
  if (wasDown && camera.offlineSince) {
    const ev = await createEvent({
      organizationId: camera.organizationId,
      cameraId: camera.id,
      eventType: 'camera_online',
      dedupeKey: `camera_online:${camera.id}:${camera.offlineSince.toISOString()}`,
      metadata: { offlineSince: camera.offlineSince.toISOString() },
    });
    if (ev) await enqueueAutomation(ev.id);
  }
}

/** Mark a camera as offline/error. Emits a camera_offline event once per outage. */
export async function markCameraDown(camera: Camera, status: 'offline' | 'error', message: string) {
  const since = camera.offlineSince ?? new Date();
  await db
    .update(schema.cameras)
    .set({ status, statusMessage: message, offlineSince: since })
    .where(eq(schema.cameras.id, camera.id));
  if (!camera.offlineSince) {
    const ev = await createEvent({
      organizationId: camera.organizationId,
      cameraId: camera.id,
      eventType: 'camera_offline',
      dedupeKey: `camera_offline:${camera.id}:${since.toISOString()}`,
      metadata: { message },
      occurredAt: since,
    });
    if (ev) await enqueueAutomation(ev.id);
  }
}

/**
 * Copy a stored frame so it can be analyzed again as if it was just captured (observations are
 * unique per (sensor, frame)). The copy becomes the camera's latest image; camera status is untouched.
 */
export async function duplicateFrame(frame: Frame, capturedAt = new Date()): Promise<Frame> {
  const data = await storage.get(frame.storageKey);
  const id = crypto.randomUUID();
  const storageKey = frame.storageKey.replace(/[^/]+\.jpg$/, `${id}.jpg`);
  await storage.put(storageKey, data);
  const { id: _old, createdAt: _c, storageKey: _k, capturedAt: _t, expiresAt, ...rest } = frame;
  const retention = expiresAt ? expiresAt.getTime() - frame.capturedAt.getTime() : null;
  const [copy] = await db
    .insert(schema.cameraFrames)
    .values({ ...rest, id, storageKey, capturedAt, expiresAt: retention ? new Date(capturedAt.getTime() + retention) : null })
    .returning();
  return copy!;
}

export async function latestFrame(cameraId: string): Promise<Frame | null> {
  const [f] = await db
    .select()
    .from(schema.cameraFrames)
    .where(and(eq(schema.cameraFrames.cameraId, cameraId), isNull(schema.cameraFrames.deletedAt)))
    .orderBy(desc(schema.cameraFrames.capturedAt))
    .limit(1);
  return f ?? null;
}

export async function readFrame(frame: Frame): Promise<Buffer> {
  return storage.get(frame.storageKey);
}
