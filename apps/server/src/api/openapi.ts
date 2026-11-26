import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { routeDocs } from './route';

function toJsonSchema(schema: z.ZodTypeAny) {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routeDocs) {
    const path = r.url.replace(/:([a-zA-Z]+)/g, '{$1}');
    const params = [...r.url.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const queryParams: unknown[] = [];
    if (r.query) {
      const js = toJsonSchema(r.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(js.properties ?? {})) {
        queryParams.push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema });
      }
    }
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: [r.tag],
      parameters: [...params, ...queryParams],
      responses: {
        '200': { description: 'OK' },
        '400': { description: 'Valideringsfel', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'CSRF-header saknas' },
        '404': { description: 'Hittades inte' },
      },
    };
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: toJsonSchema(r.body) } } };
    if (r.binaryBody) op.requestBody = { required: true, content: { [r.binaryBody]: { schema: { type: 'string', format: 'binary' } } } };
    paths[path] = { ...(paths[path] ?? {}), [r.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Veyra API',
      version: '1.0.0',
      description:
        'REST API för Veyra. Ingen inloggning: API:t är öppet i ditt nätverk – exponera inte Veyra direkt mot internet. ' +
        'Ändrande anrop (POST/PATCH/DELETE) kräver headern `x-veyra-csrf: 1`. Fel returneras som `{ "error": { "code", "message", "details" } }`. ' +
        'Listor pagineras med `limit` och `cursor` (returneras som `nextCursor`).',
    },
    servers: [{ url: config.PUBLIC_URL }],
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } },
        },
      },
    },
    paths,
  };
}

export function registerOpenApi(app: FastifyInstance) {
  app.get('/api/v1/openapi.json', async () => buildOpenApi());
  app.get('/api/docs', async (_req, reply) => {
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"/><title>Veyra API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"/></head>
<body><div id="ui"></div><script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#ui' });</script></body></html>`);
  });
}
