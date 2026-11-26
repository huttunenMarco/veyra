import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config';
import { db, schema } from '../../db/client';
import { audit } from '../../lib/audit';
import { randomToken, safeEqualHex, sha256 } from '../../lib/crypto';
import { AppError, badRequest, notFound, unauthorized } from '../../lib/errors';
import { getConnection } from '../../services/cameras';
import { completeCaptureJob, failCaptureJob } from '../../services/capture';
import { ingestFrame } from '../../services/frames';
import { loadAgent } from '../loaders';
import { route, uuidParam } from '../route';

const ENROLLMENT_TTL_MS = 24 * 3_600_000;

function publicAgent(a: typeof schema.cameraAgents.$inferSelect) {
  const { secretHash: _s, enrollmentTokenHash: _e, ...rest } = a;
  return { ...rest, enrollmentPending: !!a.enrollmentTokenHash && !!a.enrollmentExpiresAt && a.enrollmentExpiresAt > new Date() };
}

async function issueEnrollment(agentId: string) {
  const token = `ve_${randomToken(24)}`;
  await db
    .update(schema.cameraAgents)
    .set({ enrollmentTokenHash: sha256(token), enrollmentExpiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS) })
    .where(eq(schema.cameraAgents.id, agentId));
  return token;
}

/** Agent credential format: va_<agentId>.<secret>. Only the hash of the secret is stored. */
async function authenticateAgent(req: FastifyRequest) {
  const header = req.headers.authorization ?? '';
  const m = header.match(/^Bearer va_([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/);
  if (!m) throw unauthorized('Agenten saknar giltiga inloggningsuppgifter');
  const [agent] = await db.select().from(schema.cameraAgents).where(eq(schema.cameraAgents.id, m[1]!));
  if (!agent || !agent.secretHash || agent.status === 'revoked' || !safeEqualHex(agent.secretHash, sha256(m[2]!))) {
    throw unauthorized('Agenten är okänd eller återkallad');
  }
  const now = new Date();
  if (agent.status !== 'online' || !agent.lastHeartbeatAt || now.getTime() - agent.lastHeartbeatAt.getTime() > 5000) {
    await db.update(schema.cameraAgents).set({ status: 'online', lastHeartbeatAt: now }).where(eq(schema.cameraAgents.id, agent.id));
  }
  return agent;
}

async function claimJobs(agentId: string) {
  // SKIP LOCKED lets several agent processes poll safely.
  const claimed = await db.execute<{ id: string }>(sql`
    update capture_jobs set status = 'claimed', claimed_at = now(), attempts = attempts + 1
    where id in (
      select j.id from capture_jobs j
      join cameras c on c.id = j.camera_id
      where j.agent_id = ${agentId} and j.status = 'pending' and c.agent_id = ${agentId}
      order by j.created_at
      for update of j skip locked
      limit 5
    )
    returning id`);
  const ids = [...claimed].map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ job: schema.captureJobs, camera: schema.cameras })
    .from(schema.captureJobs)
    .innerJoin(schema.cameras, eq(schema.cameras.id, schema.captureJobs.cameraId))
    .where(inArray(schema.captureJobs.id, ids));
  return rows.map(({ job, camera }) => {
    const conn = getConnection(camera);
    return {
      jobId: job.id,
      cameraId: camera.id,
      cameraName: camera.name,
      type: camera.connectionType as 'rtsp' | 'http_snapshot',
      url: camera.connectionType === 'rtsp' ? conn.rtspUrl : conn.httpUrl,
      username: conn.username ?? null,
      password: conn.password ?? null,
      rtspTransport: conn.rtspTransport,
    };
  });
}

async function loadAgentJob(agentId: string, jobId: string) {
  const [job] = await db.select().from(schema.captureJobs).where(and(eq(schema.captureJobs.id, jobId), eq(schema.captureJobs.agentId, agentId)));
  if (!job) throw notFound('Jobbet');
  if (job.status !== 'claimed' && job.status !== 'pending') throw new AppError(409, 'job_closed', `Jobbet är redan ${job.status}`);
  return job;
}

export function agentRoutes(app: FastifyInstance) {
  // --- Management (web UI) ---
  route(app, { method: 'GET', url: '/api/v1/agents', summary: 'Lista kameraagenter', tag: 'Agenter' }, async ({ auth }) => {
    const agents = await db.select().from(schema.cameraAgents).where(eq(schema.cameraAgents.organizationId, auth.organizationId)).orderBy(schema.cameraAgents.createdAt);
    const counts = await db
      .select({ agentId: schema.cameras.agentId, n: count() })
      .from(schema.cameras)
      .where(eq(schema.cameras.organizationId, auth.organizationId))
      .groupBy(schema.cameras.agentId);
    return { data: agents.map((a) => ({ ...publicAgent(a), cameraCount: counts.find((c) => c.agentId === a.id)?.n ?? 0 })) };
  });

  route(
    app,
    { method: 'POST', url: '/api/v1/agents', summary: 'Skapa kameraagent (returnerar registreringskod)', tag: 'Agenter', body: z.object({ name: z.string().trim().min(1).max(100) }) },
    async ({ auth, body }) => {
      const [agent] = await db.insert(schema.cameraAgents).values({ organizationId: auth.organizationId, name: body.name }).returning();
      const enrollmentToken = await issueEnrollment(agent!.id);
      await audit(auth.organizationId, 'agent.create', 'agent', agent!.id, { name: body.name });
      return { agent: publicAgent(agent!), enrollmentToken, apiUrl: config.PUBLIC_URL };
    },
  );

  route(app, { method: 'POST', url: '/api/v1/agents/:id/enrollment', summary: 'Ny registreringskod (ersätter agentens nyckel vid registrering)', tag: 'Agenter' }, async ({ auth, params }) => {
    const agent = await loadAgent(auth.organizationId, uuidParam(params));
    const enrollmentToken = await issueEnrollment(agent.id);
    if (agent.status === 'revoked') await db.update(schema.cameraAgents).set({ status: 'pending' }).where(eq(schema.cameraAgents.id, agent.id));
    await audit(auth.organizationId, 'agent.enrollment', 'agent', agent.id);
    return { enrollmentToken, apiUrl: config.PUBLIC_URL };
  });

  route(app, { method: 'POST', url: '/api/v1/agents/:id/revoke', summary: 'Återkalla agent', tag: 'Agenter' }, async ({ auth, params }) => {
    const agent = await loadAgent(auth.organizationId, uuidParam(params));
    await db.update(schema.cameraAgents).set({ status: 'revoked', secretHash: null, enrollmentTokenHash: null }).where(eq(schema.cameraAgents.id, agent.id));
    await db.update(schema.captureJobs).set({ status: 'failed', error: 'Agenten återkallades' }).where(and(eq(schema.captureJobs.agentId, agent.id), inArray(schema.captureJobs.status, ['pending', 'claimed'])));
    await audit(auth.organizationId, 'agent.revoke', 'agent', agent.id);
  });

  route(app, { method: 'DELETE', url: '/api/v1/agents/:id', summary: 'Ta bort agent', tag: 'Agenter' }, async ({ auth, params }) => {
    const agent = await loadAgent(auth.organizationId, uuidParam(params));
    await db.delete(schema.cameraAgents).where(eq(schema.cameraAgents.id, agent.id));
    await audit(auth.organizationId, 'agent.delete', 'agent', agent.id);
  });

  // --- Agent protocol (outbound HTTPS polling from the agent) ---
  const agentInfo = z.object({ version: z.string().max(40).default('unknown'), hostname: z.string().max(200).default(''), platform: z.string().max(100).default('') });

  route(
    app,
    { method: 'POST', url: '/agent/v1/enroll', summary: 'Registrera agent med engångskod', tag: 'Agentprotokoll', auth: 'agent', body: agentInfo.extend({ enrollmentToken: z.string().min(10).max(200) }) },
    async ({ body }) => {
      const [agent] = await db
        .select()
        .from(schema.cameraAgents)
        .where(eq(schema.cameraAgents.enrollmentTokenHash, sha256(body.enrollmentToken)));
      if (!agent || !agent.enrollmentExpiresAt || agent.enrollmentExpiresAt < new Date()) {
        throw unauthorized('Registreringskoden är ogiltig eller har gått ut');
      }
      const secret = randomToken(32);
      await db
        .update(schema.cameraAgents)
        .set({
          secretHash: sha256(secret),
          enrollmentTokenHash: null,
          enrollmentExpiresAt: null,
          status: 'online',
          lastHeartbeatAt: new Date(),
          version: body.version,
          hostname: body.hostname,
          platform: body.platform,
        })
        .where(eq(schema.cameraAgents.id, agent.id));
      await audit(agent.organizationId, 'agent.enrolled', 'agent', agent.id, { hostname: body.hostname });
      return { agentId: agent.id, agentToken: `va_${agent.id}.${secret}`, name: agent.name };
    },
  );

  route(app, { method: 'POST', url: '/agent/v1/heartbeat', summary: 'Heartbeat', tag: 'Agentprotokoll', auth: 'agent', body: agentInfo }, async ({ req, body }) => {
    const agent = await authenticateAgent(req);
    await db
      .update(schema.cameraAgents)
      .set({ version: body.version, hostname: body.hostname, platform: body.platform, lastHeartbeatAt: new Date(), status: 'online' })
      .where(eq(schema.cameraAgents.id, agent.id));
    return { ok: true, serverTime: new Date().toISOString() };
  });

  route(
    app,
    { method: 'GET', url: '/agent/v1/jobs', summary: 'Hämta väntande jobb (long-poll)', tag: 'Agentprotokoll', auth: 'agent', query: z.object({ wait: z.coerce.number().int().min(0).max(25).default(20) }) },
    async ({ req, query }) => {
      const agent = await authenticateAgent(req);
      const deadline = Date.now() + query.wait * 1000;
      let aborted = false;
      req.raw.on('close', () => (aborted = true));
      for (;;) {
        const jobs = await claimJobs(agent.id);
        if (jobs.length || Date.now() >= deadline || aborted) return { jobs };
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  );

  route(
    app,
    { method: 'POST', url: '/agent/v1/jobs/:id/frame', summary: 'Ladda upp bild för jobb', tag: 'Agentprotokoll', auth: 'agent', binaryBody: 'image/jpeg', bodyLimit: config.MAX_UPLOAD_BYTES },
    async ({ req, params }) => {
      const agent = await authenticateAgent(req);
      const job = await loadAgentJob(agent.id, uuidParam(params));
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Bilddata saknas');
      const [camera] = await db
        .select()
        .from(schema.cameras)
        .where(and(eq(schema.cameras.id, job.cameraId), eq(schema.cameras.organizationId, agent.organizationId), eq(schema.cameras.agentId, agent.id)));
      if (!camera) throw notFound('Kameran');
      const frame = await ingestFrame(camera, req.body, 'agent');
      await completeCaptureJob(job, frame);
      return { ok: true, frameId: frame.id };
    },
  );

  route(
    app,
    { method: 'POST', url: '/agent/v1/jobs/:id/fail', summary: 'Rapportera misslyckat jobb', tag: 'Agentprotokoll', auth: 'agent', body: z.object({ error: z.string().max(2000) }) },
    async ({ req, params, body }) => {
      const agent = await authenticateAgent(req);
      const job = await loadAgentJob(agent.id, uuidParam(params));
      await failCaptureJob(job, body.error);
      return { ok: true };
    },
  );
}

