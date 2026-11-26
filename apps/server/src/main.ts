import { existsSync } from 'node:fs';
import { config, dataDir } from './config';
import { buildApp } from './api/app';
import { sqlClient } from './db/client';
import { runMigrations } from './db/migrate';
import { closeQueues } from './queue';
import { getInstance } from './services/instance';
import { visionSettings } from './vision';
import { startWorker } from './worker';

/** Veyra in one process: database migrations, API + web UI, and background jobs. */
await runMigrations();
await getInstance();

const app = await buildApp({ logger: true });
const worker = await startWorker();
await app.listen({ port: config.PORT, host: config.HOST });

const ai = await visionSettings();
app.log.info(
  [
    `Veyra är igång på port ${config.PORT}${config.WEB_DIST && existsSync(config.WEB_DIST) ? ' (webbgränssnitt inbyggt)' : ''}`,
    `data: ${dataDir}`,
    `AI: ${ai.provider === 'openai' ? `OpenAI ${ai.model}` : 'simulerad – lägg in en OpenAI-nyckel under Inställningar → AI'}`,
    `notiser: ${config.NOTIFICATIONS_MODE}`,
  ].join(' · '),
);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await worker.close();
    await closeQueues();
    await sqlClient.end();
    process.exit(0);
  });
}
