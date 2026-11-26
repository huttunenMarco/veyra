import { defineConfig } from '@playwright/test';

/**
 * E2E tests run against a running Veyra. They create cameras, sensors and rules, so point them
 * at a throwaway instance, e.g. `docker compose -p veyra-e2e up -d` and E2E_BASE_URL=http://localhost:8080.
 * Without E2E_BASE_URL they use (or start) the dev stack on :5180.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5180', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'pnpm dev',
    cwd: '../..',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
