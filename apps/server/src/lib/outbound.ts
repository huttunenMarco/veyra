import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';
import { config } from '../config';

/**
 * Outbound HTTP guard for user-configured destinations (webhooks, HTTP actions, Twilio).
 * - https only (http allowed in dev via ALLOW_INSECURE_WEBHOOKS)
 * - every resolved address is checked at connect time (prevents DNS rebinding)
 * - private, loopback, link-local and metadata ranges are blocked unless explicitly allowed
 * - redirects are not followed, timeouts and response size are bounded
 */

const blockedV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const blockList = new net.BlockList();
for (const [addr, prefix] of blockedV4) blockList.addSubnet(addr, prefix, 'ipv4');
blockList.addSubnet('::', 128, 'ipv6');
blockList.addSubnet('::1', 128, 'ipv6');
blockList.addSubnet('fc00::', 7, 'ipv6');
blockList.addSubnet('fe80::', 10, 'ipv6');
blockList.addSubnet('ff00::', 8, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  if (config.ALLOW_PRIVATE_NETWORK_TARGETS) return false;
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return blockList.check(mapped[1]!, 'ipv4');
    return blockList.check(address, 'ipv6');
  }
  return blockList.check(address, 'ipv4');
}

export class OutboundBlockedError extends Error {}

export function validateOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundBlockedError('Ogiltig URL');
  }
  const allowHttp = config.ALLOW_INSECURE_WEBHOOKS;
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new OutboundBlockedError('Endast https:// är tillåtet');
  }
  if (url.username || url.password) throw new OutboundBlockedError('Inloggningsuppgifter i URL är inte tillåtna');
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new OutboundBlockedError('Mål-adressen är ett privat eller internt nätverk');
  }
  return url;
}

const guardedLookup: typeof dns.lookup = ((hostname: string, options: dns.LookupOptions, callback: never) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    const cb = callback as unknown as (
      e: Error | null,
      a: string | dns.LookupAddress[],
      f?: number,
    ) => void;
    if (err) return cb(err, '');
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) return cb(new OutboundBlockedError(`Blockerad adress ${bad.address} för ${hostname}`), '');
    if (options.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}) as typeof dns.lookup;

const dispatcher = new Agent({ connect: { lookup: guardedLookup }, headersTimeout: 15_000, bodyTimeout: 15_000 });

export interface OutboundResponse {
  status: number;
  ok: boolean;
  body: string;
}

export async function safeFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<OutboundResponse> {
  validateOutboundUrl(url);
  const res: Response = await undiciFetch(url, {
    ...init,
    redirect: 'manual',
    dispatcher,
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  const body = await readLimited(res, 16 * 1024);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, body };
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

/** Resolve a hostname and refuse private targets (used for SMTP, which does not go through fetch). */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (config.ALLOW_PRIVATE_NETWORK_TARGETS) return;
  const list = await dns.promises.lookup(hostname, { all: true });
  const bad = list.find((a) => isBlockedAddress(a.address));
  if (bad) throw new OutboundBlockedError(`Blockerad adress ${bad.address} för ${hostname}`);
}
