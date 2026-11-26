import { describe, expect, it } from 'vitest';
import { assertAllowedTarget } from '../src/allowlist';

describe('camera agent allowlist', () => {
  it('only allows LAN targets by default', async () => {
    await expect(assertAllowedTarget('rtsp://192.168.1.50/stream1', [])).resolves.toBeUndefined();
    await expect(assertAllowedTarget('rtsp://8.8.8.8/stream1', [])).rejects.toThrow(/inte tillåten/);
    await expect(assertAllowedTarget('file:///etc/passwd', [])).rejects.toThrow(/stöds inte/);
  });

  it('respects an explicit allowlist', async () => {
    await expect(assertAllowedTarget('rtsp://8.8.8.8/x', ['8.8.8.0/24'])).resolves.toBeUndefined();
    await expect(assertAllowedTarget('rtsp://192.168.1.50/x', ['10.0.0.0/8'])).rejects.toThrow();
  });
});
