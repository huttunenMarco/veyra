import { z } from 'zod';

export const integrationTypes = ['ntfy', 'email', 'sms', 'webhook', 'slack', 'teams', 'discord', 'http'] as const;
export type IntegrationType = (typeof integrationTypes)[number];

/** `simulated` connections record what would be sent without contacting the provider. */
export const deliveryModes = ['live', 'simulated'] as const;
export type DeliveryMode = (typeof deliveryModes)[number];

const httpsUrl = z.string().trim().url().max(2000);
const e164 = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Telefonnummer måste vara i E.164-format, t.ex. +46701234567');
const headerName = z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'Ogiltigt headernamn');
const headers = z.record(headerName, z.string().max(2000)).default({});

/** ntfy topic names: letters, digits, _ and -. On public servers the name works like a password. */
export const ntfyTopic = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ämnet får bara innehålla a–z, 0–9, _ och - (max 64 tecken)');

export const connectionConfigSchemas = {
  ntfy: z.object({
    serverUrl: z.string().trim().url().max(500).default('https://ntfy.sh'),
    topic: ntfyTopic,
    /** Only for servers that require login (self-hosted ntfy with access control). */
    accessToken: z.string().trim().max(500).default(''),
  }),
  email: z.object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().max(255).default(''),
    password: z.string().max(500).default(''),
    from: z.string().trim().min(3).max(255),
  }),
  sms: z.object({
    accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'Ogiltigt Twilio Account SID'),
    authToken: z.string().trim().min(10).max(200),
    from: z.string().trim().min(2).max(40),
  }),
  webhook: z.object({
    url: httpsUrl,
    headers,
    signingSecret: z.string().max(500).default(''),
  }),
  slack: z.object({ webhookUrl: httpsUrl }),
  teams: z.object({ webhookUrl: httpsUrl }),
  discord: z.object({ webhookUrl: httpsUrl }),
  http: z.object({
    baseUrl: httpsUrl,
    headers,
    authHeaderName: z.string().trim().max(64).default('Authorization'),
    authHeaderValue: z.string().max(2000).default(''),
  }),
} satisfies Record<IntegrationType, z.ZodTypeAny>;

/** Fields that are secret and must never be returned to the client or logged. */
export const secretFields: Record<IntegrationType, string[]> = {
  ntfy: ['accessToken'],
  email: ['password'],
  sms: ['authToken'],
  webhook: ['signingSecret', 'headers'],
  slack: ['webhookUrl'],
  teams: ['webhookUrl'],
  discord: ['webhookUrl'],
  http: ['authHeaderValue', 'headers'],
};

export type ConnectionConfig<T extends IntegrationType> = z.infer<(typeof connectionConfigSchemas)[T]>;

export const ntfyPriorities = ['min', 'low', 'default', 'high', 'urgent'] as const;

export const actionConfigSchemas = {
  ntfy: z.object({
    title: z.string().max(250).default('{{zone.name}}'),
    message: z.string().min(1).max(2000),
    priority: z.enum(ntfyPriorities).default('default'),
    attachSnapshot: z.boolean().default(true),
  }),
  email: z.object({
    to: z.array(z.string().trim().email('Ogiltig e-postadress')).min(1).max(20),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(5000),
    attachSnapshot: z.boolean().default(true),
  }),
  sms: z.object({
    to: z.array(e164).min(1).max(10),
    body: z.string().min(1).max(1000),
  }),
  webhook: z.object({
    /** Optional JSON template; when empty a standard event payload is sent. */
    payloadTemplate: z.string().max(10000).default(''),
  }),
  slack: z.object({ message: z.string().min(1).max(3000) }),
  teams: z.object({ message: z.string().min(1).max(3000) }),
  discord: z.object({ message: z.string().min(1).max(1900) }),
  http: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('POST'),
    path: z
      .string()
      .max(1000)
      .default('')
      .refine((p) => !/^[a-z]+:\/\//i.test(p) && !p.startsWith('//'), 'Sökvägen måste vara relativ'),
    body: z.string().max(10000).default(''),
  }),
} satisfies Record<IntegrationType, z.ZodTypeAny>;

export type ActionConfig<T extends IntegrationType> = z.infer<(typeof actionConfigSchemas)[T]>;

export const deliveryStatuses = ['pending', 'processing', 'delivered', 'failed', 'retrying'] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

/**
 * `experimental`: implemented against the provider's documented API but not yet verified
 * end-to-end with a real account. Shown as a badge in the UI.
 */
export const integrationMeta: Record<IntegrationType, { label: string; description: string; experimental?: boolean }> = {
  ntfy: { label: 'Push-notis (ntfy)', description: 'Notis i mobilen via appen ntfy – enklast' },
  email: { label: 'E-post', description: 'Skicka e-post via SMTP', experimental: true },
  sms: { label: 'SMS', description: 'Skicka SMS via Twilio', experimental: true },
  webhook: { label: 'Webhook', description: 'HTTP POST med signerad JSON' },
  slack: { label: 'Slack', description: 'Slack incoming webhook', experimental: true },
  teams: { label: 'Microsoft Teams', description: 'Teams Workflows-webhook (Power Automate)', experimental: true },
  discord: { label: 'Discord', description: 'Discord webhook', experimental: true },
  http: { label: 'HTTP API', description: 'Autentiserat anrop till externt API', experimental: true },
};
