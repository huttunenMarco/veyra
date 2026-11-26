import { existsSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedValue } from '../src/api/routes/examples';
import { config } from '../src/config';
import { db, schema, sqlClient } from '../src/db/client';
import { closeQueues } from '../src/queue';
import { examplesForVision, selectExamples } from '../src/services/examples';
import { client, createApp, type Client } from './helpers';

let app: FastifyInstance;
let s: Client;

beforeAll(async () => {
  app = await createApp();
  s = client(app);
});
afterAll(async () => {
  await app.close();
  await closeQueues();
  await sqlClient.end();
});

const storagePath = (key: string) => path.resolve(process.cwd(), config.DATA_DIR, 'objects', key);

async function setup() {
  const cam = (await s.req('POST', '/api/v1/cameras', { name: 'Hall', connectionType: 'demo', connection: { demoScene: 'garage' } })).json;
  const zone = (await s.req('POST', `/api/v1/cameras/${cam.id}/zones`, { name: 'Garderob', geometry: { type: 'rectangle', x: 0.25, y: 0.1, width: 0.5, height: 0.8 } })).json;
  const sensor = (
    await s.req('POST', '/api/v1/sensors', {
      cameraId: cam.id,
      zoneId: zone.id,
      name: 'Garderob',
      instruction: 'Är garderoben öppen eller stängd?',
      outputType: 'enum',
      outputConfig: { allowedValues: ['open', 'closed'], valueLabels: { open: 'Öppen', closed: 'Stängd' } },
    })
  ).json;
  const frames: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await s.req('POST', `/api/v1/cameras/${cam.id}/analyze`);
    frames.push(r.json.frame.id);
  }
  return { cam, zone, sensor, frames };
}

describe('reference images', () => {
  it('creates, lists, renders and deletes examples', async () => {
    const { sensor, frames } = await setup();
    const created = await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[0], value: 'open', note: 'helt öppen' });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ value: 'open', valueLabel: 'Öppen', note: 'helt öppen' });
    expect(created.body).not.toContain('storageKey');

    expect((await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[0], value: 'closed' })).status).toBe(400); // same frame
    expect((await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[1], value: 'maybe' })).status).toBe(400); // invalid value

    const list = await s.req('GET', `/api/v1/sensors/${sensor.id}/examples`);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.useExamples).toBe(true);

    const img = await app.inject({ method: 'GET', url: `/api/v1/sensors/${sensor.id}/examples/${created.json.id}/image` });
    expect(img.statusCode).toBe(200);
    const meta = await sharp(img.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);

    const [row] = await db.select().from(schema.sensorExamples).where(eq(schema.sensorExamples.id, created.json.id));
    expect(existsSync(storagePath(row!.storageKey))).toBe(true);
    expect((await s.req('DELETE', `/api/v1/sensors/${sensor.id}/examples/${created.json.id}`)).status).toBe(204);
    expect(existsSync(storagePath(row!.storageKey))).toBe(false);
  });

  it('survives snapshot retention: the example keeps its own copy', async () => {
    const { sensor, frames } = await setup();
    const ex = (await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[0], value: 'closed' })).json;
    await s.req('POST', '/api/v1/settings/purge', { target: 'snapshots' });
    const img = await app.inject({ method: 'GET', url: `/api/v1/sensors/${sensor.id}/examples/${ex.id}/image` });
    expect(img.statusCode).toBe(200);
  });

  it('limits examples per value and can be turned off per sensor', async () => {
    const { sensor, frames } = await setup();
    for (let i = 0; i < 3; i++) expect((await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[i], value: 'open' })).status).toBe(200);
    expect((await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[3], value: 'open' })).status).toBe(400);

    const [row] = await db.select().from(schema.sensors).where(eq(schema.sensors.id, sensor.id));
    expect(await examplesForVision(row!, null)).toHaveLength(3);
    const off = await s.req('PATCH', `/api/v1/sensors/${sensor.id}`, { useExamples: false });
    expect(off.json.useExamples).toBe(false);
    const [rowOff] = await db.select().from(schema.sensors).where(eq(schema.sensors.id, sensor.id));
    expect(await examplesForVision(rowOff!, null)).toHaveLength(0);
    // Turning off keeps the images
    expect((await s.req('GET', `/api/v1/sensors/${sensor.id}/examples`)).json.data).toHaveLength(3);
  });


  it('deletes example files when the camera is deleted', async () => {
    const { cam, sensor, frames } = await setup();
    const ex = (await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[0], value: 'open' })).json;
    const [row] = await db.select().from(schema.sensorExamples).where(eq(schema.sensorExamples.id, ex.id));
    await s.req('DELETE', `/api/v1/cameras/${cam.id}`);
    expect(existsSync(storagePath(row!.storageKey))).toBe(false);
  });
});

describe('re-analyzing an observation', () => {
  it('runs the same image again as if it was just captured', async () => {
    const { cam, sensor } = await setup();
    const history = (await s.req('GET', `/api/v1/sensors/${sensor.id}/history`)).json.data as Array<{ id: string; frameId: string; observedAt: string }>;
    const oldest = history[history.length - 1]!;

    const r = await s.req('POST', `/api/v1/observations/${oldest.id}/reanalyze`);
    expect(r.status).toBe(200);
    expect(r.json.observation.frameId).not.toBe(oldest.frameId);
    expect(new Date(r.json.observation.observedAt).getTime()).toBeGreaterThan(new Date(history[0]!.observedAt).getTime());

    const after = (await s.req('GET', `/api/v1/sensors/${sensor.id}/history`)).json.data;
    expect(after).toHaveLength(history.length + 1);
    expect(after[0].id).toBe(r.json.observation.id); // newest
    // The copy is now the camera's latest image
    expect((await s.req('GET', `/api/v1/cameras/${cam.id}`)).json.latestFrame.id).toBe(r.json.observation.frameId);
  });
});

describe('evaluate against reviewed observations', () => {
  it('requires feedback, then reports accuracy without reusing example frames', async () => {
    const { sensor, frames } = await setup();
    expect((await s.req('POST', `/api/v1/sensors/${sensor.id}/evaluate`, {})).status).toBe(400);

    const history = (await s.req('GET', `/api/v1/sensors/${sensor.id}/history`)).json.data as Array<{ id: string; frameId: string; value: string }>;
    for (const o of history) await s.req('POST', `/api/v1/observations/${o.id}/feedback`, { correct: true });
    expect((await s.req('POST', `/api/v1/observations/${history[0]!.id}/feedback`, { correct: false, correctedValue: 'nope' })).status).toBe(400);

    await s.req('POST', `/api/v1/sensors/${sensor.id}/examples`, { frameId: frames[0], value: 'open' });
    const r = await s.req('POST', `/api/v1/sensors/${sensor.id}/evaluate`, { limit: 10 });
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(history.length - 1); // the example's own frame is excluded
    expect(r.json.examplesUsed).toBe(1);
    expect(r.json.results.every((x: { frameId: string }) => x.frameId !== frames[0])).toBe(true);
    expect(r.json.accuracy).toBeGreaterThanOrEqual(0);
  });
});

describe('helpers', () => {
  it('infers the expected value from feedback', () => {
    const two = { outputType: 'enum' as const, outputConfig: { allowedValues: ['open', 'closed'] } };
    expect(expectedValue(two, 'open', true, null)).toBe('open');
    expect(expectedValue(two, 'open', false, null)).toBe('closed');
    expect(expectedValue(two, 'open', false, 'open')).toBe('open');
    expect(expectedValue({ outputType: 'boolean', outputConfig: {} }, true, false, null)).toBe(false);
    expect(expectedValue({ outputType: 'number', outputConfig: {} }, 3, false, null)).toBeNull();
    expect(expectedValue({ outputType: 'enum', outputConfig: { allowedValues: ['a', 'b', 'c'] } }, 'a', false, null)).toBeNull();
  });

  it('selects a balanced set of examples', () => {
    const rows = [...Array(5)].map(() => ({ value: 'open' })).concat([...Array(5)].map(() => ({ value: 'closed' })));
    const picked = selectExamples(rows);
    expect(picked.filter((r) => r.value === 'open')).toHaveLength(3);
    expect(picked.filter((r) => r.value === 'closed')).toHaveLength(3);
  });
});
