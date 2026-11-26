import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlClient } from '../src/db/client';
import { closeQueues } from '../src/queue';
import { client, createApp, type Client } from './helpers';

let app: FastifyInstance;
let a: Client;

beforeAll(async () => {
  app = await createApp();
  a = client(app);
});
afterAll(async () => {
  await app.close();
  await closeQueues();
  await sqlClient.end();
});

const demoCamera = { name: 'Demo', connectionType: 'demo', connection: { demoScene: 'warehouse' } };
const dockSensor = (cameraId: string, zoneId: string | null) => ({
  cameraId,
  zoneId,
  name: 'Dock',
  instruction: 'Is a truck at the dock? occupied or available.',
  outputType: 'enum',
  outputConfig: { allowedValues: ['occupied', 'available'] },
  stabilization: { requiredConsecutive: 2, unavailableAfter: 3, uncertainAfter: 3 },
});

describe('no login, CSRF protected', () => {
  it('reads without any authentication', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/cameras' });
    expect(r.statusCode).toBe(200);
    const inst = await app.inject({ method: 'GET', url: '/api/v1/instance' });
    expect(inst.json()).toMatchObject({ name: expect.any(String) });
  });

  it('requires the CSRF header for changes', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/cameras', payload: demoCamera });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf');
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000' });
    expect(del.statusCode).toBe(403);
  });

  it('does not send CORS headers to other origins', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/api/v1/cameras', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('camera, zone and sensor CRUD', () => {
  it('creates, reads, updates and deletes a camera without leaking credentials', async () => {
    const agent = await a.req('POST', '/api/v1/agents', { name: 'agent' });
    const created = await a.req('POST', '/api/v1/cameras', {
      name: 'RTSP',
      connectionType: 'rtsp',
      agentId: agent.json.agent.id,
      connection: { rtspUrl: 'rtsp://admin:Sup3rSecret!@192.168.1.50:554/stream1' },
    });
    expect(created.status).toBe(200);
    expect(created.body).not.toContain('Sup3rSecret');
    expect(created.json.connection).toMatchObject({ url: 'rtsp://192.168.1.50:554/stream1', hasUsername: true, hasPassword: true });

    const id = created.json.id;
    const list = await a.req('GET', '/api/v1/cameras');
    expect(list.body).not.toContain('Sup3rSecret');
    expect(list.json.data.some((c: { id: string }) => c.id === id)).toBe(true);

    const patched = await a.req('PATCH', `/api/v1/cameras/${id}`, { name: 'Renamed', connection: { rtspUrl: 'rtsp://192.168.1.51/stream2' } });
    expect(patched.json.name).toBe('Renamed');
    expect(patched.json.connection.hasPassword).toBe(true);

    expect((await a.req('DELETE', `/api/v1/cameras/${id}`)).status).toBe(204);
    expect((await a.req('GET', `/api/v1/cameras/${id}`)).status).toBe(404);
  });


  it('manages zones and sensors', async () => {
    const cam = (await a.req('POST', '/api/v1/cameras', demoCamera)).json;
    const zone = await a.req('POST', `/api/v1/cameras/${cam.id}/zones`, {
      name: 'Lastkaj 1',
      geometry: { type: 'rectangle', x: 0.1, y: 0.1, width: 0.3, height: 0.5 },
    });
    expect(zone.status).toBe(200);
    const bad = await a.req('POST', `/api/v1/cameras/${cam.id}/zones`, { name: 'x', geometry: { type: 'rectangle', x: 2, y: 0, width: 0.1, height: 0.1 } });
    expect(bad.status).toBe(400);

    const moved = await a.req('PATCH', `/api/v1/zones/${zone.json.id}`, { geometry: { type: 'rectangle', x: 0.2, y: 0.2, width: 0.2, height: 0.2 } });
    expect(moved.json.geometry.x).toBe(0.2);

    const invalid = await a.req('POST', '/api/v1/sensors', { ...dockSensor(cam.id, zone.json.id), outputConfig: { allowedValues: ['one'] } });
    expect(invalid.status).toBe(400);

    const sensor = await a.req('POST', '/api/v1/sensors', dockSensor(cam.id, zone.json.id));
    expect(sensor.status).toBe(200);
    const state = await a.req('GET', `/api/v1/sensors/${sensor.json.id}/state`);
    expect(state.json).toMatchObject({ status: 'unknown', value: null });

    const patched = await a.req('PATCH', `/api/v1/sensors/${sensor.json.id}`, { intervalSeconds: 300 });
    expect(patched.json.intervalSeconds).toBe(300);

    // Deleting the zone cascades to its sensors.
    expect((await a.req('DELETE', `/api/v1/zones/${zone.json.id}`)).status).toBe(204);
    expect((await a.req('GET', `/api/v1/sensors/${sensor.json.id}`)).status).toBe(404);
  });

  it('analyzes a demo camera and stores one observation per sensor', async () => {
    const cam = (await a.req('POST', '/api/v1/cameras', demoCamera)).json;
    const z1 = (await a.req('POST', `/api/v1/cameras/${cam.id}/zones`, { name: 'Z1', geometry: { type: 'rectangle', x: 0, y: 0, width: 0.5, height: 1 } })).json;
    const z2 = (await a.req('POST', `/api/v1/cameras/${cam.id}/zones`, { name: 'Z2', geometry: { type: 'rectangle', x: 0.5, y: 0, width: 0.5, height: 1 } })).json;
    const s1 = (await a.req('POST', '/api/v1/sensors', dockSensor(cam.id, z1.id))).json;
    const s2 = (await a.req('POST', '/api/v1/sensors', dockSensor(cam.id, z2.id))).json;
    const r = await a.req('POST', `/api/v1/cameras/${cam.id}/analyze`);
    expect(r.status).toBe(200);
    expect(r.json.observations).toHaveLength(2);
    const bySensor = Object.fromEntries(r.json.observations.map((o: { sensorId: string; frameId: string }) => [o.sensorId, o]));
    expect(bySensor[s1.id].frameId).toBe(r.json.frame.id);
    expect(bySensor[s2.id].frameId).toBe(r.json.frame.id);
    expect(r.json.observations.every((o: { simulated: boolean }) => o.simulated)).toBe(true);
  });
});

describe('automations', () => {
  it('creates, updates, tests and deletes a rule', async () => {
    const cam = (await a.req('POST', '/api/v1/cameras', demoCamera)).json;
    const sensor = (await a.req('POST', '/api/v1/sensors', dockSensor(cam.id, null))).json;
    const conn = (await a.req('POST', '/api/v1/integrations', { type: 'webhook', name: 'wh', mode: 'simulated', config: { url: 'https://example.com/x' } })).json;
    const rule = await a.req('POST', '/api/v1/automations', {
      name: 'Dock free',
      sensorId: sensor.id,
      trigger: { type: 'state_transition', from: 'occupied', to: 'available' },
      actions: [{ integrationConnectionId: conn.id, config: {} }],
    });
    expect(rule.status).toBe(200);
    expect(rule.json.actions).toHaveLength(1);

    const badAction = await a.req('POST', '/api/v1/automations', {
      name: 'bad',
      sensorId: sensor.id,
      trigger: { type: 'sensor_unavailable' },
      actions: [{ integrationConnectionId: conn.id, config: { payloadTemplate: 'x'.repeat(20000) } }],
    });
    expect(badAction.status).toBe(400);

    const updated = await a.req('PATCH', `/api/v1/automations/${rule.json.id}`, { enabled: false, cooldownSeconds: 120 });
    expect(updated.json).toMatchObject({ enabled: false, cooldownSeconds: 120 });
    expect(updated.json.actions).toHaveLength(1);

    const test = await a.req('POST', `/api/v1/automations/${rule.json.id}/test`);
    expect(test.json.eventId).toBeTruthy();

    // An integration in use cannot be deleted.
    expect((await a.req('DELETE', `/api/v1/integrations/${conn.id}`)).status).toBe(409);
    expect((await a.req('DELETE', `/api/v1/automations/${rule.json.id}`)).status).toBe(204);
  });

  it('rejects numeric thresholds on non-numeric sensors', async () => {
    const cam = (await a.req('POST', '/api/v1/cameras', demoCamera)).json;
    const sensor = (await a.req('POST', '/api/v1/sensors', dockSensor(cam.id, null))).json;
    const r = await a.req('POST', '/api/v1/automations', { name: 'x', sensorId: sensor.id, trigger: { type: 'numeric_threshold', operator: 'lt', threshold: 3 } });
    expect(r.status).toBe(400);
  });

  it('never returns integration secrets', async () => {
    const r = await a.req('POST', '/api/v1/integrations', {
      type: 'sms',
      name: 'Twilio',
      config: { accountSid: 'AC' + '0'.repeat(32), authToken: 'tok_very_secret_123', from: '+46700000000' },
    });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('tok_very_secret_123');
    expect(r.json.secretsSet).toContain('authToken');
    // Keeping secrets on update when left empty
    const u = await a.req('PATCH', `/api/v1/integrations/${r.json.id}`, { config: { from: '+46711111111', authToken: '' } });
    expect(u.json.secretsSet).toContain('authToken');
  });
});

describe('settings', () => {
  it('stores the OpenAI key write-only and encrypted', async () => {
    expect((await a.req('PATCH', '/api/v1/settings/ai', { openaiApiKey: 'not-a-key' })).status).toBe(400);
    const saved = await a.req('PATCH', '/api/v1/settings/ai', { openaiApiKey: 'sk-test-0123456789abcdef', openaiModel: 'gpt-5-mini' });
    expect(saved.json).toMatchObject({ configured: true, keySource: 'ui', model: 'gpt-5-mini' });
    const settings = await a.req('GET', '/api/v1/settings');
    expect(settings.body).not.toContain('sk-test-0123456789abcdef');
    expect(settings.body).not.toContain('openaiApiKeyEncrypted');
    const cleared = await a.req('PATCH', '/api/v1/settings/ai', { openaiApiKey: null });
    expect(cleared.json.configured).toBe(false);
  });

  it('renames the installation', async () => {
    await a.req('PATCH', '/api/v1/settings', { name: 'Sommarstugan' });
    expect((await a.req('GET', '/api/v1/instance')).json.name).toBe('Sommarstugan');
    expect((await a.req('PATCH', '/api/v1/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('serves an OpenAPI document', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    expect(r.json().paths['/api/v1/sensors/{id}/state'].get).toBeTruthy();
  });
});
