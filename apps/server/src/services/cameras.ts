import type { CameraConnection } from '@veyra/shared';
import { schema } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';

type Camera = typeof schema.cameras.$inferSelect;

export function getConnection(camera: Pick<Camera, 'encryptedConnectionConfig'>): CameraConnection {
  if (!camera.encryptedConnectionConfig) return { rtspTransport: 'tcp' };
  return decryptJson<CameraConnection>(camera.encryptedConnectionConfig);
}

export function encryptConnection(conn: CameraConnection): string {
  return encryptJson(conn);
}

/** Strip credentials embedded in a URL (rtsp://user:pass@host). They are stored separately. */
export function splitUrlCredentials(raw: string): { url: string; username?: string; password?: string } {
  try {
    const u = new URL(raw);
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    u.username = '';
    u.password = '';
    return { url: u.toString(), username, password };
  } catch {
    return { url: raw };
  }
}

/** Safe, credential-free description of a camera's source for API responses. */
export function connectionSummary(camera: Camera) {
  const conn = getConnection(camera);
  const target = conn.rtspUrl ?? conn.httpUrl;
  let url: string | null = null;
  let host: string | null = null;
  if (target) {
    try {
      const u = new URL(target);
      host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
      // Query strings may carry tokens (e.g. snapshot URLs), so they are masked.
      url = `${u.protocol}//${host}${u.pathname}${u.search ? '?…' : ''}`;
    } catch {
      url = null;
    }
  }
  return {
    url,
    host,
    hasUsername: !!conn.username,
    hasPassword: !!conn.password,
    rtspTransport: conn.rtspTransport,
    demoScene: conn.demoScene ?? null,
  };
}

export function publicCamera(camera: Camera) {
  const { encryptedConnectionConfig: _secret, ...rest } = camera;
  return { ...rest, connection: connectionSummary(camera) };
}
