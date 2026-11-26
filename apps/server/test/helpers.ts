import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildApp } from '../src/api/app';

export async function createApp() {
  return buildApp();
}

export interface Client {
  req: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any; body: string }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** HTTP client for the (login-free) API. Sends the CSRF header like the web UI does. */
export function client(app: FastifyInstance): Client {
  const req = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({
      method: method as 'GET',
      url,
      headers: { 'x-veyra-csrf': '1' },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, json: r.body ? safeJson(r.body) : null, body: r.body };
  };
  return { req };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function jpeg(width = 640, height = 360): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } }).jpeg().toBuffer();
}
