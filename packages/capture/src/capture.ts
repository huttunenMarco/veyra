import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { redact } from './redact';

/** Read on each call so tests and hosts can adjust via environment. */
export function captureConfig() {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    captureTimeoutMs: num(process.env.CAPTURE_TIMEOUT_MS, 15_000),
    jpegQscale: Math.min(31, Math.max(2, num(process.env.JPEG_QSCALE, 3))),
  };
}

export interface CaptureJob {
  type: 'rtsp' | 'http_snapshot';
  url: string;
  username: string | null;
  password: string | null;
  rtspTransport: 'tcp' | 'udp';
}

export class CaptureError extends Error {}

export function withCredentials(rawUrl: string, username: string | null, password: string | null): string {
  if (!username) return rawUrl;
  const u = new URL(rawUrl);
  u.username = encodeURIComponent(username);
  u.password = password ? encodeURIComponent(password) : '';
  return u.toString();
}

/** FFmpeg arguments for grabbing a single JPEG frame. Passed as an array — never through a shell. */
export function ffmpegArgs(url: string, transport: 'tcp' | 'udp', timeoutMs: number, qscale: number): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-rtsp_transport', transport,
    // Socket I/O timeout in microseconds (FFmpeg >= 5 uses -timeout for RTSP)
    '-timeout', String(Math.max(1, Math.floor(timeoutMs * 1000 * 0.8))),
    '-i', url,
    '-frames:v', '1',
    '-an',
    '-q:v', String(qscale),
    '-f', 'image2',
    '-c:v', 'mjpeg',
    'pipe:1',
  ];
}

export function captureRtsp(job: CaptureJob, signal?: AbortSignal): Promise<Buffer> {
  const config = captureConfig();
  const url = withCredentials(job.url, job.username, job.password);
  const args = ffmpegArgs(url, job.rtspTransport, config.captureTimeoutMs, config.jpegQscale);
  const secrets = [job.password, job.username];

  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new CaptureError(`Tidsgränsen (${config.captureTimeoutMs} ms) nåddes utan bild från kameran`)));
    }, config.captureTimeoutMs);
    const onAbort = () => {
      kill();
      finish(() => reject(new CaptureError('Avbruten')));
    };
    signal?.addEventListener('abort', onAbort);

    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.on('data', (c: Buffer) => {
      if (err.length < 4000) err += c.toString();
    });
    proc.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(new CaptureError(e.code === 'ENOENT' ? `FFmpeg hittades inte (${config.ffmpegPath}). Installera FFmpeg eller sätt FFMPEG_PATH.` : redact(e.message, secrets))),
      ),
    );
    proc.on('close', (code) =>
      finish(() => {
        const data = Buffer.concat(out);
        if (code === 0 && data.length > 0) return resolve(data);
        reject(new CaptureError(explainFfmpegError(redact(err.trim(), secrets), code)));
      }),
    );
  });
}

export function explainFfmpegError(stderr: string, code: number | null): string {
  const s = stderr.toLowerCase();
  if (s.includes('401') || s.includes('unauthorized')) return 'Kameran nekade inloggningen (401). Kontrollera användarnamn och lösenord för kamerakontot.';
  if (s.includes('404') || s.includes('not found')) return 'Strömmen hittades inte (404). Kontrollera sökvägen, t.ex. /stream1 eller /stream2.';
  if (s.includes('connection refused')) return 'Anslutningen nekades. Kontrollera IP-adress och port (RTSP använder normalt 554).';
  if (s.includes('timed out') || s.includes('timeout')) return 'Kameran svarade inte i tid. Kontrollera att den är på och nåbar från agentens nätverk.';
  if (s.includes('no route to host') || s.includes('host is unreachable')) return 'Ingen väg till kameran. Är agenten på samma nätverk?';
  return `FFmpeg avslutades med kod ${code}: ${stderr.slice(0, 500) || 'inget felmeddelande'}`;
}

function md5(s: string) {
  return createHash('md5').update(s).digest('hex');
}

/** Build a Digest Authorization header (RFC 7616, MD5/qop=auth), common on IP cameras. */
export function digestHeader(wwwAuth: string, method: string, uri: string, username: string, password: string): string {
  const params: Record<string, string> = {};
  for (const m of wwwAuth.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  const realm = params.realm ?? '';
  const nonce = params.nonce ?? '';
  const qop = params.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined;
  const nc = '00000001';
  const cnonce = randomBytes(8).toString('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (params.opaque) parts.push(`opaque="${params.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (params.algorithm) parts.push(`algorithm=${params.algorithm}`);
  return `Digest ${parts.join(', ')}`;
}

function explainFetchError(err: unknown): CaptureError {
  const config = captureConfig();
  const e = err as { name?: string; cause?: { code?: string } };
  if (e.name === 'TimeoutError') return new CaptureError(`Snapshot-URL svarade inte inom ${config.captureTimeoutMs} ms`);
  switch (e.cause?.code) {
    case 'ECONNREFUSED':
      return new CaptureError('Anslutningen nekades. Kontrollera IP-adress och port för snapshot-URL:en.');
    case 'ENOTFOUND':
      return new CaptureError('Värdnamnet för snapshot-URL:en kunde inte hittas.');
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new CaptureError('Ingen väg till kameran. Är agenten på samma nätverk?');
    default:
      return new CaptureError(`Kunde inte hämta snapshot: ${e.cause?.code ?? (err as Error).message}`);
  }
}

export async function captureHttp(job: CaptureJob): Promise<Buffer> {
  const config = captureConfig();
  const url = new URL(job.url);
  const signal = AbortSignal.timeout(config.captureTimeoutMs);
  const headers: Record<string, string> = {};
  if (job.username) headers.Authorization = `Basic ${Buffer.from(`${job.username}:${job.password ?? ''}`).toString('base64')}`;
  const get = () => fetch(url, { headers, signal, redirect: 'manual' }).catch((err) => Promise.reject(explainFetchError(err)));
  let res = await get();
  const challenge = res.headers.get('www-authenticate');
  if (res.status === 401 && job.username && challenge?.toLowerCase().startsWith('digest')) {
    await res.body?.cancel();
    headers.Authorization = digestHeader(challenge, 'GET', url.pathname + url.search, job.username, job.password ?? '');
    res = await get();
  }
  if (res.status === 401) throw new CaptureError('Kameran nekade inloggningen (401). Kontrollera användarnamn och lösenord.');
  if (!res.ok) throw new CaptureError(`Snapshot-URL svarade med HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  const data = Buffer.from(await res.arrayBuffer());
  if (!type.startsWith('image/') && !(data[0] === 0xff && data[1] === 0xd8)) {
    throw new CaptureError(`Svaret var inte en bild (${type || 'okänd typ'})`);
  }
  return data;
}

/** Capture one JPEG from an RTSP stream or HTTP snapshot URL. */
export function captureFrame(job: CaptureJob, signal?: AbortSignal): Promise<Buffer> {
  return job.type === 'rtsp' ? captureRtsp(job, signal) : captureHttp(job);
}
