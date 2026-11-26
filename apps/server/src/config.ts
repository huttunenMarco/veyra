import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

/** Optional string where an empty value (e.g. `OPENAI_MODEL=` in .env) means "not set". */
const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://veyra:veyra@localhost:5434/veyra'),
  REDIS_URL: z.string().default('redis://localhost:6381'),
  /** Snapshots, reference images and the generated secret key live here. */
  DATA_DIR: z.string().default('../../data'),
  /** Built web UI to serve. Unset in development (Vite serves it). */
  WEB_DIST: optional,
  /** Public URL of this installation, used for links in notifications. */
  PUBLIC_URL: z.string().default('http://localhost:5180'),
  /** 32 bytes, base64. Generated into DATA_DIR/secret.key when not set. */
  ENCRYPTION_KEY: optional,

  // AI. These override the values set in the UI (Inställningar → AI).
  VISION_PROVIDER: z.enum(['openai', 'mock', 'auto']).default('auto'),
  OPENAI_API_KEY: optional,
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: optional,
  OPENAI_REASONING_EFFORT: optional,
  OPENAI_TIMEOUT_MS: z.coerce.number().default(60_000),
  OPENAI_INPUT_COST_PER_MTOK: z.coerce.number().default(0.25),
  OPENAI_OUTPUT_COST_PER_MTOK: z.coerce.number().default(2.0),

  /** `simulate` records all deliveries without sending anything. */
  NOTIFICATIONS_MODE: z.enum(['live', 'simulate']).default('live'),
  /** Home-server defaults: allow http:// and LAN targets (e.g. Home Assistant). */
  ALLOW_INSECURE_WEBHOOKS: bool(true),
  ALLOW_PRIVATE_NETWORK_TARGETS: bool(true),

  SCHEDULER_TICK_SECONDS: z.coerce.number().default(10),
  AGENT_OFFLINE_AFTER_SECONDS: z.coerce.number().default(60),
  CAPTURE_JOB_TIMEOUT_SECONDS: z.coerce.number().default(45),
  MAX_UPLOAD_BYTES: z.coerce.number().default(10 * 1024 * 1024),
});

// Backwards compatibility with earlier variable names.
// (process.env coerces undefined to the string "undefined", so only copy real values.)
if (!process.env.PORT && process.env.API_PORT) process.env.PORT = process.env.API_PORT;
if (!process.env.PUBLIC_URL && process.env.WEB_ORIGIN) process.env.PUBLIC_URL = process.env.WEB_ORIGIN;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Ogiltig konfiguration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

export const dataDir = path.resolve(process.cwd(), parsed.data.DATA_DIR);

/** Use ENCRYPTION_KEY if given, otherwise a key generated once and kept in the data directory. */
function resolveEncryptionKey(): string {
  if (parsed.data!.ENCRYPTION_KEY) return parsed.data!.ENCRYPTION_KEY;
  const file = path.join(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString('base64');
  writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}

export const config = { ...parsed.data, ENCRYPTION_KEY: resolveEncryptionKey() };

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
export const DEFAULT_REASONING_EFFORT = 'low';
