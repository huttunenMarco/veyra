/**
 * Local troubleshooting: grab one frame from an RTSP URL without the backend.
 *   pnpm --filter camera-agent test-capture "rtsp://192.168.1.50:554/stream1" user pass
 * Writes test-frame.jpg in the current directory.
 */
import { writeFile } from 'node:fs/promises';
import { captureRtsp } from '@veyra/capture';

const [url, username, password] = process.argv.slice(2);
if (!url) {
  console.log('Användning: pnpm --filter camera-agent test-capture <rtsp-url> [användare] [lösenord]');
  process.exit(1);
}
const started = Date.now();
try {
  const jpeg = await captureRtsp({
    type: 'rtsp',
    url,
    username: username ?? null,
    password: password ?? null,
    rtspTransport: 'tcp',
  });
  await writeFile('test-frame.jpg', jpeg);
  console.log(`OK: test-frame.jpg (${Math.round(jpeg.length / 1024)} kB, ${Date.now() - started} ms)`);
} catch (err) {
  console.error(`Misslyckades: ${(err as Error).message}`);
  process.exit(1);
}
