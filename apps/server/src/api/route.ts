import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest, notFound } from '../lib/errors';
import { instanceId } from '../services/instance';

export const CSRF_HEADER = 'x-veyra-csrf';

/** Veyra is a single, login-free installation: every request acts on it. */
export interface AuthContext {
  organizationId: string;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteSpec<B extends z.ZodTypeAny | undefined, Q extends z.ZodTypeAny | undefined> {
  method: Method;
  url: string;
  summary: string;
  tag: string;
  /** agent: endpoints used by remote camera agents (they authenticate themselves, no CSRF header). */
  auth?: 'agent';
  body?: B;
  query?: Q;
  /** Binary request body (e.g. image/jpeg) */
  binaryBody?: string;
  hidden?: boolean;
  bodyLimit?: number;
}

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;

export interface HandlerCtx<B, Q> {
  req: FastifyRequest;
  reply: FastifyReply;
  auth: AuthContext;
  body: B;
  query: Q;
  params: Record<string, string>;
}

export interface RouteDoc {
  method: Method;
  url: string;
  summary: string;
  tag: string;
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  binaryBody?: string;
}

export const routeDocs: RouteDoc[] = [];

function zodError(error: z.ZodError) {
  return badRequest(
    'Valideringen misslyckades',
    error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

export function route<B extends z.ZodTypeAny | undefined = undefined, Q extends z.ZodTypeAny | undefined = undefined>(
  app: FastifyInstance,
  spec: RouteSpec<B, Q>,
  handler: (ctx: HandlerCtx<Infer<B>, Infer<Q>>) => Promise<unknown>,
) {
  if (!spec.hidden) {
    routeDocs.push({ method: spec.method, url: spec.url, summary: spec.summary, tag: spec.tag, body: spec.body, query: spec.query, binaryBody: spec.binaryBody });
  }
  app.route({
    method: spec.method,
    url: spec.url,
    bodyLimit: spec.bodyLimit,
    handler: async (req, reply) => {
      // CSRF: state changes must carry a custom header. Browsers can't send it cross-site without
      // a CORS preflight (which we don't allow), so other web pages can't drive this server.
      if (spec.auth !== 'agent' && req.method !== 'GET' && req.method !== 'HEAD' && req.headers[CSRF_HEADER] !== '1') {
        throw new AppError(403, 'csrf', `Lägg till headern "${CSRF_HEADER}: 1" på ändrande anrop`);
      }
      const auth: AuthContext = { organizationId: await instanceId() };
      let body: unknown = undefined;
      if (spec.body) {
        const r = spec.body.safeParse(req.body ?? {});
        if (!r.success) throw zodError(r.error);
        body = r.data;
      }
      let query: unknown = undefined;
      if (spec.query) {
        const r = spec.query.safeParse(req.query ?? {});
        if (!r.success) throw zodError(r.error);
        query = r.data;
      }
      const result = await handler({
        req,
        reply,
        auth,
        body: body as Infer<B>,
        query: query as Infer<Q>,
        params: req.params as Record<string, string>,
      });
      if (reply.sent) return reply;
      if (result === undefined) return reply.code(204).send();
      return result;
    },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(params: Record<string, string>, name = 'id'): string {
  const v = params[name];
  if (!v || !UUID.test(v)) throw notFound();
  return v;
}
