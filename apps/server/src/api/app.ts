import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config';
import { AppError } from '../lib/errors';
import { registerOpenApi } from './openapi';
import { agentRoutes } from './routes/agents';
import { automationRoutes } from './routes/automations';
import { cameraRoutes } from './routes/cameras';
import { dashboardRoutes } from './routes/dashboard';
import { eventRoutes } from './routes/events';
import { exampleRoutes } from './routes/examples';
import { integrationRoutes } from './routes/integrations';
import { sensorRoutes } from './routes/sensors';
import { settingsRoutes } from './routes/settings';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          // Never log credentials.
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        }
      : false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // No CORS: the UI is served from the same origin, and refusing cross-origin preflights is
  // what makes the CSRF header requirement effective.

  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: config.MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) {
      const message = e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'Filen är för stor' : e.message;
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Ett internt fel uppstod' } });
  });
  const webDist = config.WEB_DIST ? path.resolve(config.WEB_DIST) : null;
  const serveWeb = !!webDist && existsSync(path.join(webDist, 'index.html'));
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webDist!, wildcard: false, index: false, maxAge: '1h' });
  }
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/agent/');
    // Single-page app: unknown non-API GETs get the UI, which routes client-side.
    if (serveWeb && !isApi && req.method === 'GET') return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'Hittades inte' } });
  });

  app.get('/health', async () => ({ ok: true }));

  dashboardRoutes(app);
  cameraRoutes(app);
  sensorRoutes(app);
  exampleRoutes(app);
  automationRoutes(app);
  integrationRoutes(app);
  eventRoutes(app);
  agentRoutes(app);
  settingsRoutes(app);
  registerOpenApi(app);

  return app;
}
