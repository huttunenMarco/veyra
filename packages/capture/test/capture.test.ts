import { describe, expect, it } from 'vitest';
import { digestHeader, explainFfmpegError, ffmpegArgs, withCredentials } from '../src/capture';
import { redact } from '../src/redact';

describe('capture', () => {
  it('builds ffmpeg args as an array with the URL as a single argument', () => {
    const url = 'rtsp://u:p%3Bx@192.168.1.50:554/stream1; rm -rf /';
    const args = ffmpegArgs(url, 'tcp', 10_000, 3);
    expect(args).toContain(url);
    expect(args[args.indexOf('-i') + 1]).toBe(url);
    expect(args).toContain('pipe:1');
  });

  it('encodes credentials into the URL', () => {
    expect(withCredentials('rtsp://192.168.1.50:554/stream1', 'cam@user', 'p@ss:w/rd')).toBe(
      'rtsp://cam%40user:p%40ss%3Aw%2Frd@192.168.1.50:554/stream1',
    );
  });

  it('redacts credentials', () => {
    expect(redact('error opening rtsp://admin:secret@10.0.0.2/x', ['secret'])).toBe('error opening rtsp://***@10.0.0.2/x');
    expect(redact('bad password hunter2', ['hunter2'])).toBe('bad password ***');
  });



  it('explains common ffmpeg failures', () => {
    expect(explainFfmpegError('method DESCRIBE failed: 401 Unauthorized', 1)).toMatch(/nekade inloggningen/);
    expect(explainFfmpegError('Connection refused', 1)).toMatch(/nekades/);
  });

  it('computes digest auth', () => {
    const h = digestHeader('Digest realm="cam", nonce="abc", qop="auth"', 'GET', '/snap.jpg', 'admin', 'pw');
    expect(h).toMatch(/^Digest username="admin", realm="cam", nonce="abc", uri="\/snap.jpg", response="[0-9a-f]{32}"/);
    expect(h).toContain('qop=auth');
  });
});
