import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config';

/**
 * The agent only connects to cameras on the local network (or an explicit allowlist),
 * so a compromised or misconfigured backend cannot use it to reach arbitrary hosts.
 */
const privateList = new net.BlockList();
privateList.addSubnet('10.0.0.0', 8, 'ipv4');
privateList.addSubnet('172.16.0.0', 12, 'ipv4');
privateList.addSubnet('192.168.0.0', 16, 'ipv4');
privateList.addSubnet('169.254.0.0', 16, 'ipv4');
privateList.addSubnet('127.0.0.0', 8, 'ipv4');
privateList.addSubnet('100.64.0.0', 10, 'ipv4');
privateList.addSubnet('fc00::', 7, 'ipv6');
privateList.addSubnet('fe80::', 10, 'ipv6');
privateList.addAddress('::1', 'ipv6');

function matchesAllowlist(host: string, address: string, allow: string[]): boolean {
  for (const entry of allow) {
    if (entry === '*') return true;
    if (entry.toLowerCase() === host.toLowerCase() || entry === address) return true;
    const [base, bits] = entry.split('/');
    if (bits && net.isIP(base!) && net.isIP(address) === net.isIP(base!)) {
      const list = new net.BlockList();
      const type = net.isIP(base!) === 6 ? 'ipv6' : 'ipv4';
      list.addSubnet(base!, Number(bits), type);
      if (list.check(address, type)) return true;
    }
  }
  return false;
}

export async function assertAllowedTarget(rawUrl: string, allow = config.allowedHosts): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Ogiltig kamera-URL');
  }
  if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(url.protocol)) throw new Error(`Protokollet ${url.protocol} stöds inte`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  for (const address of addresses) {
    const allowed =
      allow.length > 0
        ? matchesAllowlist(host, address, allow)
        : privateList.check(address, net.isIP(address) === 6 ? 'ipv6' : 'ipv4');
    if (!allowed) {
      throw new Error(
        `Kameraadressen ${host} (${address}) är inte tillåten. Agenten ansluter bara till lokala nätverk, eller adresser i VEYRA_ALLOWED_HOSTS.`,
      );
    }
  }
}
