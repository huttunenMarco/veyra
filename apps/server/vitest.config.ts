import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://veyra:veyra@localhost:5434/veyra_test',
      // Separate Redis DB so a running dev worker never consumes test jobs.
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6381/2',
      ENCRYPTION_KEY: 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdDE=',
      VISION_PROVIDER: 'mock',
      NOTIFICATIONS_MODE: 'live',
      ALLOW_INSECURE_WEBHOOKS: 'true',
      ALLOW_PRIVATE_NETWORK_TARGETS: 'true',
      DATA_DIR: '../../data/test',
      CAPTURE_JOB_TIMEOUT_SECONDS: '10',
    },
  },
});
