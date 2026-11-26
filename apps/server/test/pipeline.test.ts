import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, schema, sqlClient } from '../src/db/client';
import { closeQueues } from '../src/queue';
import { processEvent } from '../src/services/automations';
import { deliver, runExecution } from '../src/services/delivery';
import { detectOfflineCameras, detectStaleSensors, evaluateTimeBasedRules, expireCaptureJobs, scheduleCaptures } from '../src/services/scheduler';
import { client, createApp, jpeg, type Client } from './helpers';

let app: FastifyInstance;
let s: Client;
let hook: http.Server;
let hookUrl: string;
let received: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string; raw: Buffer }> = [];
let respondWith = 200;

beforeAll(async () => {
  app = await createApp();
  s = client(app);
  hook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      received.push({ method: req.method, url: req.url, headers: req.headers, body: raw.toString('utf8'), raw });
      res.statusCode = respondWith;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  hook.close();
  await app.close();
  await closeQueues();
  await sqlClient.end();
});
beforeEach(() => {
  received = [];
  respondWith = 200;
});

async function setupDock(trigger: object = { type: 'state_transition', from: 'occupied', to: 'available' }) {
  const cam = (await s.req('POST', '/api/v1/cameras', { name: 'Lager', connectionType: 'demo' })).json;
  const zone = (await s.req('POST', `/api/v1/cameras/${cam.id}/zones`, { name: 'Lastkaj 2', geometry: { type: 'rectangle', x: 0.5, y: 0, width: 0.5, height: 1 } })).json;
  const sensor = (
    await s.req('POST', '/api/v1/sensors', {
      cameraId: cam.id,
      zoneId: zone.id,
      name: 'Dock 2',
      instruction: 'Truck at dock? occupied / available',
      outputType: 'enum',
      outputConfig: { allowedValues: ['occupied', 'available'], valueLabels: { occupied: 'Upptagen', available: 'Ledig' } },
      stabilization: { requiredConsecutive: 3, unavailableAfter: 3, uncertainAfter: 3 },
    })
  ).json;
  const conn = (await s.req('POST', '/api/v1/integrations', { type: 'webhook', name: 'hook', config: { url: hookUrl, signingSecret: 'shh' } })).json;
  const rule = (
    await s.req('POST', '/api/v1/automations', {
      name: 'Dock 2 free',
      sensorId: sensor.id,
      trigger,
      actions: [{ integrationConnectionId: conn.id, config: { payloadTemplate: '{"zone":"{{zone.name}}","now":"{{sensor.valueLabel}}","was":"{{sensor.previousValueLabel}}"}' } }],
    })
  ).json;
  return { cam, zone, sensor, conn, rule };
}

const observe = (sensorId: string, value: string | null, status = 'confirmed') =>
  s.req('POST', `/api/v1/sensors/${sensorId}/simulate`, { value, status });

async function eventsFor(sensorId: string, type?: string) {
  const rows = await db.select().from(schema.events).where(eq(schema.events.sensorId, sensorId));
  return rows.filter((e) => !type || e.eventType === type);
}

async function runAutomations(sensorId: string) {
  for (const e of await eventsFor(sensorId)) await processEvent(e.id);
  return db.select().from(schema.actionExecutions).innerJoin(schema.events, eq(schema.events.id, schema.actionExecutions.eventId)).where(eq(schema.events.sensorId, sensorId));
}

describe('state transitions → events → webhook', () => {
  it('creates exactly one event for a confirmed transition and delivers a signed webhook', async () => {
    const { sensor } = await setupDock();
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'occupied');
    // Noise: a single "available" followed by occupied must not trigger
    await observe(sensor.id, 'available');
    await observe(sensor.id, 'occupied');
    for (let i = 0; i < 5; i++) await observe(sensor.id, 'available');

    const changes = await eventsFor(sensor.id, 'state_changed');
    expect(changes.map((e) => [e.previousValue, e.currentValue])).toEqual([
      [null, 'occupied'],
      ['occupied', 'available'],
    ]);

    const execs = await runAutomations(sensor.id);
    expect(execs).toHaveLength(1); // only occupied → available matches
    const { retry } = await runExecution(execs[0]!.action_executions.id, 1, 5);
    expect(retry).toBe(false);

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(JSON.parse(body)).toEqual({ zone: 'Lastkaj 2', now: 'Ledig', was: 'Upptagen' });
    const expected = createHmac('sha256', 'shh').update(`${headers['x-veyra-timestamp']}.${body}`).digest('hex');
    expect(headers['x-veyra-signature']).toBe(`sha256=${expected}`);

    const [exec] = await db.select().from(schema.actionExecutions).where(eq(schema.actionExecutions.id, execs[0]!.action_executions.id));
    expect(exec).toMatchObject({ status: 'delivered', responseCode: 200, attempts: 1, simulated: false });
    expect(JSON.stringify(exec)).not.toContain('shh');

    // Reprocessing the same events is idempotent
    const again = await runAutomations(sensor.id);
    expect(again).toHaveLength(1);
  });

  it('does not treat uncertain or failed observations as "available"', async () => {
    const { sensor } = await setupDock();
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'occupied');
    for (let i = 0; i < 4; i++) await observe(sensor.id, 'available', 'uncertain');
    for (let i = 0; i < 4; i++) await observe(sensor.id, null, 'unavailable');
    const changes = await eventsFor(sensor.id, 'state_changed');
    expect(changes).toHaveLength(1);
    expect((await eventsFor(sensor.id, 'sensor_unavailable')).length).toBe(1);
    const state = (await s.req('GET', `/api/v1/sensors/${sensor.id}/state`)).json;
    expect(state).toMatchObject({ value: 'occupied', status: 'unavailable' });
    expect(await runAutomations(sensor.id)).toHaveLength(0);
  });

  it('retries 5xx with backoff and gives up after max attempts; 4xx fails immediately', async () => {
    const { sensor } = await setupDock();
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'occupied');
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'available');
    const [row] = await runAutomations(sensor.id);
    const id = row!.action_executions.id;

    respondWith = 503;
    expect((await runExecution(id, 1, 3)).retry).toBe(true);
    let [exec] = await db.select().from(schema.actionExecutions).where(eq(schema.actionExecutions.id, id));
    expect(exec).toMatchObject({ status: 'retrying', responseCode: 503 });
    expect((await runExecution(id, 3, 3)).retry).toBe(false);
    [exec] = await db.select().from(schema.actionExecutions).where(eq(schema.actionExecutions.id, id));
    expect(exec).toMatchObject({ status: 'failed', attempts: 3 });

    // Permanent client error: no retry
    await db.update(schema.actionExecutions).set({ status: 'pending' }).where(eq(schema.actionExecutions.id, id));
    respondWith = 400;
    expect((await runExecution(id, 1, 5)).retry).toBe(false);
  });

  it('respects rule cooldown', async () => {
    const { sensor, rule } = await setupDock({ type: 'state_transition', from: null, to: null });
    await s.req('PATCH', `/api/v1/automations/${rule.id}`, { cooldownSeconds: 3600 });
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'occupied');
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'available');
    await runAutomations(sensor.id);
    const runs = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    expect(runs.map((r) => r.status).sort()).toEqual(['executed', 'skipped_cooldown']);
  });
});

describe('time based rules and stale detection', () => {
  it('fires a duration rule once per confirmed period', async () => {
    const { sensor, rule } = await setupDock({ type: 'duration', value: 'occupied', durationSeconds: 60 });
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'occupied');
    await db.update(schema.sensorStates).set({ confirmedAt: new Date(Date.now() - 120_000) }).where(eq(schema.sensorStates.sensorId, sensor.id));
    await evaluateTimeBasedRules();
    await evaluateTimeBasedRules();
    const events = await db.select().from(schema.events).where(and(eq(schema.events.eventType, 'duration_reached'), eq(schema.events.sensorId, sensor.id)));
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.ruleId).toBe(rule.id);
  });

  it('marks sensors stale when observations stop', async () => {
    const { sensor } = await setupDock();
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'occupied');
    await db.update(schema.sensorStates).set({ lastObservationAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.sensorStates.sensorId, sensor.id));
    await detectStaleSensors();
    await detectStaleSensors();
    const state = (await s.req('GET', `/api/v1/sensors/${sensor.id}/state`)).json;
    expect(state.status).toBe('stale');
    expect((await eventsFor(sensor.id, 'sensor_unavailable')).length).toBe(1);
  });
});

describe('manual mode (automatic analysis paused)', () => {
  it('never captures, analyzes, or marks the camera offline/stale on schedule', async () => {
    const { cam, sensor } = await setupDock();
    for (let i = 0; i < 3; i++) await observe(sensor.id, 'occupied');
    const paused = await s.req('PATCH', `/api/v1/cameras/${cam.id}`, { autoCapture: false });
    expect(paused.json.autoCapture).toBe(false);

    const old = new Date(Date.now() - 3_600_000);
    await db.update(schema.cameras).set({ lastFrameAt: old, lastCaptureRequestedAt: old, status: 'online' }).where(eq(schema.cameras.id, cam.id));
    await db.update(schema.sensorStates).set({ lastObservationAt: old }).where(eq(schema.sensorStates.sensorId, sensor.id));
    await db.update(schema.sensors).set({ lastAnalysisRequestedAt: old }).where(eq(schema.sensors.id, sensor.id));
    const framesBefore = await db.select().from(schema.cameraFrames).where(eq(schema.cameraFrames.cameraId, cam.id));

    await scheduleCaptures();
    await detectOfflineCameras();
    await detectStaleSensors();

    const framesAfter = await db.select().from(schema.cameraFrames).where(eq(schema.cameraFrames.cameraId, cam.id));
    expect(framesAfter).toHaveLength(framesBefore.length);
    const [camNow] = await db.select().from(schema.cameras).where(eq(schema.cameras.id, cam.id));
    expect(camNow!.status).toBe('online');
    expect((await s.req('GET', `/api/v1/sensors/${sensor.id}/state`)).json.status).toBe('confirmed');

    // "Analysera nu" still works on demand
    const r = await s.req('POST', `/api/v1/cameras/${cam.id}/analyze`);
    expect(r.status).toBe(200);
    expect(r.json.observations).toHaveLength(1);

    // Resuming makes it schedulable again
    await s.req('PATCH', `/api/v1/cameras/${cam.id}`, { autoCapture: true });
    await db.update(schema.cameras).set({ lastCaptureRequestedAt: old }).where(eq(schema.cameras.id, cam.id));
    await scheduleCaptures();
    const framesResumed = await db.select().from(schema.cameraFrames).where(eq(schema.cameraFrames.cameraId, cam.id));
    expect(framesResumed.length).toBeGreaterThan(framesAfter.length);
  });
});

describe('ntfy push notifications', () => {
  const ctx = {
    template: { 'zone.name': 'Garderob', 'sensor.name': 'Garderob', 'sensor.valueLabel': 'Öppen', 'event.id': 'abc' },
    payload: {},
  };
  const action = { title: '{{zone.name}}', message: '{{sensor.name}} är nu {{sensor.valueLabel}}', priority: 'high', attachSnapshot: true };

  it('publishes text as JSON (UTF-8 safe) and uploads the snapshot as an attachment', async () => {
    const serverUrl = new URL(hookUrl).origin;
    const created = await s.req('POST', '/api/v1/integrations', { type: 'ntfy', name: 'Mobil', config: { serverUrl, topic: 'veyra-test_1' } });
    expect(created.status).toBe(200);
    expect(created.json.config).toMatchObject({ topic: 'veyra-test_1', serverUrl });
    const [row] = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, created.json.id));

    // No snapshot available → JSON publish
    const text = await deliver(row!, 'ntfy', action, ctx);
    expect(text).toMatchObject({ ok: true, destination: `127.0.0.1:${new URL(hookUrl).port}/veyra-test_1` });
    expect(received[0]).toMatchObject({ method: 'POST', url: '/' });
    expect(JSON.parse(received[0]!.body)).toMatchObject({
      topic: 'veyra-test_1',
      title: 'Garderob',
      message: 'Garderob är nu Öppen',
      priority: 4,
      click: expect.stringContaining('/events?highlight=abc'),
    });

    // With a snapshot → image upload, text in query parameters
    const img = await jpeg(320, 180);
    const withImage = await deliver(row!, 'ntfy', action, { ...ctx, snapshot: img });
    expect(withImage.ok).toBe(true);
    const up = received[1]!;
    expect(up.method).toBe('PUT');
    const url = new URL(up.url!, 'http://x');
    expect(url.pathname).toBe('/veyra-test_1');
    expect(url.searchParams.get('message')).toBe('Garderob är nu Öppen');
    expect(url.searchParams.get('title')).toBe('Garderob');
    expect(url.searchParams.get('filename')).toBe('snapshot.jpg');
    expect(up.headers['content-type']).toBe('image/jpeg');
    expect(up.raw.equals(img)).toBe(true);
  });

  it('validates the topic and keeps access tokens secret', async () => {
    expect((await s.req('POST', '/api/v1/integrations', { type: 'ntfy', name: 'x', config: { topic: 'har mellanslag' } })).status).toBe(400);
    const r = await s.req('POST', '/api/v1/integrations', { type: 'ntfy', name: 'Egen', config: { serverUrl: 'https://ntfy.example.com', topic: 'hem', accessToken: 'tk_supersecret' } });
    expect(r.body).not.toContain('tk_supersecret');
    expect(r.json.secretsSet).toContain('accessToken');
  });
});

describe('built-in capture (no agent needed)', () => {
  it('captures directly from the camera and reports actionable errors', async () => {
    const img = await jpeg(800, 600);
    const cam1 = http.createServer((req, res) => {
      if (req.url?.startsWith('/snap.jpg')) {
        res.setHeader('content-type', 'image/jpeg');
        res.end(img);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => cam1.listen(0, '127.0.0.1', r));
    const port = (cam1.address() as AddressInfo).port;
    try {
      const cam = (await s.req('POST', '/api/v1/cameras', { name: 'Inbyggd', connectionType: 'http_snapshot', connection: { httpUrl: `http://127.0.0.1:${port}/snap.jpg?token=x` } })).json;
      expect(cam.agentId).toBeNull();
      expect(cam.connection.url).toBe(`http://127.0.0.1:${port}/snap.jpg?…`);

      const ok = await s.req('POST', `/api/v1/cameras/${cam.id}/test`);
      expect(ok.json).toMatchObject({ ok: true, frame: { width: 800, height: 600 } });

      await s.req('PATCH', `/api/v1/cameras/${cam.id}`, { connection: { httpUrl: `http://127.0.0.1:${port}/missing.jpg` } });
      const bad = await s.req('POST', `/api/v1/cameras/${cam.id}/test`);
      expect(bad.json).toMatchObject({ ok: false, error: expect.stringContaining('404') });
      expect((await s.req('GET', `/api/v1/cameras/${cam.id}`)).json.status).toBe('error');
    } finally {
      cam1.close();
    }
  });
});

describe('camera agent lifecycle', () => {
  async function enroll() {
    const created = (await s.req('POST', '/api/v1/agents', { name: 'Hemma' })).json;
    const r = await app.inject({ method: 'POST', url: '/agent/v1/enroll', payload: { enrollmentToken: created.enrollmentToken, version: 'test', hostname: 'pc' } });
    expect(r.statusCode).toBe(200);
    // Enrollment tokens are single-use
    const again = await app.inject({ method: 'POST', url: '/agent/v1/enroll', payload: { enrollmentToken: created.enrollmentToken } });
    expect(again.statusCode).toBe(401);
    return { agentId: created.agent.id as string, token: r.json().agentToken as string };
  }

  it('captures a frame through poll → upload → completion', async () => {
    const agent = await enroll();
    const auth = { authorization: `Bearer ${agent.token}` };
    const cam = (
      await s.req('POST', '/api/v1/cameras', { name: 'Tapo', connectionType: 'rtsp', agentId: agent.agentId, connection: { rtspUrl: 'rtsp://user:pw@192.168.1.50:554/stream1' } })
    ).json;

    const testPromise = s.req('POST', `/api/v1/cameras/${cam.id}/test`);
    let jobs: Array<{ jobId: string; url: string; username: string; password: string }> = [];
    for (let i = 0; i < 20 && jobs.length === 0; i++) {
      jobs = (await app.inject({ method: 'GET', url: '/agent/v1/jobs?wait=0', headers: auth })).json().jobs;
      if (!jobs.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ url: 'rtsp://192.168.1.50:554/stream1', username: 'user', password: 'pw' });

    const up = await app.inject({ method: 'POST', url: `/agent/v1/jobs/${jobs[0]!.jobId}/frame`, headers: { ...auth, 'content-type': 'image/jpeg' }, payload: await jpeg(1920, 1080) });
    expect(up.statusCode).toBe(200);
    const result = await testPromise;
    expect(result.json).toMatchObject({ ok: true, frame: { width: 1920, height: 1080, source: 'agent' } });
    const camNow = (await s.req('GET', `/api/v1/cameras/${cam.id}`)).json;
    expect(camNow.status).toBe('online');

    // A completed job can't be reused
    const reuse = await app.inject({ method: 'POST', url: `/agent/v1/jobs/${jobs[0]!.jobId}/frame`, headers: { ...auth, 'content-type': 'image/jpeg' }, payload: await jpeg() });
    expect(reuse.statusCode).toBe(409);
  });

  it('reports failures with an actionable error and isolates agents', async () => {
    const agent = await enroll();
    const other = await enroll();
    const auth = { authorization: `Bearer ${agent.token}` };
    const cam = (await s.req('POST', '/api/v1/cameras', { name: 'Fel', connectionType: 'rtsp', agentId: agent.agentId, connection: { rtspUrl: 'rtsp://192.168.1.99/x' } })).json;
    const testPromise = s.req('POST', `/api/v1/cameras/${cam.id}/test`);
    await new Promise((r) => setTimeout(r, 300));

    // Another agent never sees this camera's jobs
    const foreign = (await app.inject({ method: 'GET', url: '/agent/v1/jobs?wait=0', headers: { authorization: `Bearer ${other.token}` } })).json();
    expect(foreign.jobs).toHaveLength(0);

    const jobs = (await app.inject({ method: 'GET', url: '/agent/v1/jobs?wait=2', headers: auth })).json().jobs;
    await app.inject({ method: 'POST', url: `/agent/v1/jobs/${jobs[0].jobId}/fail`, headers: auth, payload: { error: 'Kameran nekade inloggningen (401).' } });
    const result = await testPromise;
    expect(result.json).toMatchObject({ ok: false, error: 'Kameran nekade inloggningen (401).' });
    expect((await s.req('GET', `/api/v1/cameras/${cam.id}`)).json.status).toBe('error');
  });

  it('expires unclaimed jobs and rejects revoked agents', async () => {
    const agent = await enroll();
    const cam = (await s.req('POST', '/api/v1/cameras', { name: 'Tyst', connectionType: 'rtsp', agentId: agent.agentId, connection: { rtspUrl: 'rtsp://192.168.1.98/x' } })).json;
    await db.insert(schema.captureJobs).values({ cameraId: cam.id, agentId: agent.agentId, reason: 'scheduled', createdAt: new Date(Date.now() - 600_000) });
    await expireCaptureJobs();
    const [job] = await db.select().from(schema.captureJobs).where(eq(schema.captureJobs.cameraId, cam.id));
    expect(job!.status).toBe('expired');

    await s.req('POST', `/api/v1/agents/${agent.agentId}/revoke`);
    const r = await app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: { authorization: `Bearer ${agent.token}` }, payload: {} });
    expect(r.statusCode).toBe(401);
  });
});
