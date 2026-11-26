import { z } from 'zod';
import { zoneGeometrySchema } from './geometry';
import { triggerSchema } from './automation';
import { integrationTypes, deliveryModes } from './integrations';

export const connectionTypes = ['rtsp', 'http_snapshot', 'manual', 'demo'] as const;
export type ConnectionType = (typeof connectionTypes)[number];

export const cameraStatuses = ['online', 'offline', 'connecting', 'error', 'disabled'] as const;
export type CameraStatus = (typeof cameraStatuses)[number];

export const cameraConnectionSchema = z.object({
  rtspUrl: z
    .string()
    .trim()
    .regex(/^rtsps?:\/\/[^\s]+$/i, 'RTSP-adressen måste börja med rtsp://')
    .max(1000)
    .optional(),
  httpUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s]+$/i, 'Adressen måste börja med http:// eller https://')
    .max(1000)
    .optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  rtspTransport: z.enum(['tcp', 'udp']).default('tcp'),
  demoScene: z.enum(['warehouse', 'garage', 'production']).optional(),
});
export type CameraConnection = z.infer<typeof cameraConnectionSchema>;

export const cameraCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).default(''),
    location: z.string().max(200).default(''),
    connectionType: z.enum(connectionTypes),
    connection: cameraConnectionSchema.default({ rtspTransport: 'tcp' }),
    /** Only for cameras on another network: capture through a remote agent instead of this server. */
    agentId: z.string().uuid().nullable().default(null),
    captureIntervalSeconds: z.number().int().min(15).max(86400).default(60),
    /** false = only capture/analyze on demand ("Analysera nu"). */
    autoCapture: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.connectionType === 'rtsp' && !v.connection.rtspUrl) {
      ctx.addIssue({ code: 'custom', path: ['connection', 'rtspUrl'], message: 'Ange en RTSP-adress' });
    }
    if (v.connectionType === 'http_snapshot' && !v.connection.httpUrl) {
      ctx.addIssue({ code: 'custom', path: ['connection', 'httpUrl'], message: 'Ange en snapshot-URL' });
    }
  });
export type CameraCreateInput = z.infer<typeof cameraCreateSchema>;

export const cameraUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  location: z.string().max(200).optional(),
  /** Partial: omitted credential fields keep their stored values. */
  connection: z
    .object({
      rtspUrl: cameraConnectionSchema.shape.rtspUrl,
      httpUrl: cameraConnectionSchema.shape.httpUrl,
      username: z.string().max(200).optional(),
      password: z.string().max(500).optional(),
      rtspTransport: z.enum(['tcp', 'udp']).optional(),
    })
    .optional(),
  agentId: z.string().uuid().nullable().optional(),
  captureIntervalSeconds: z.number().int().min(15).max(86400).optional(),
  autoCapture: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const zoneCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  geometry: zoneGeometrySchema,
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366f1'),
  enabled: z.boolean().default(true),
});
// Explicit (no defaults): a partial update must never reset omitted fields.
export const zoneUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  geometry: zoneGeometrySchema.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  enabled: z.boolean().optional(),
});

export const automationActionInputSchema = z.object({
  id: z.string().uuid().optional(),
  integrationConnectionId: z.string().uuid(),
  /** Validated server-side against the connection type's action schema. */
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});

export const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  sensorId: z.string().uuid().nullable().default(null),
  cameraId: z.string().uuid().nullable().default(null),
  trigger: triggerSchema,
  cooldownSeconds: z.number().int().min(0).max(86400).default(0),
  enabled: z.boolean().default(true),
  actions: z.array(automationActionInputSchema).max(20).default([]),
});
export type AutomationInput = z.infer<typeof automationInputSchema>;

export const integrationInputSchema = z.object({
  type: z.enum(integrationTypes),
  name: z.string().trim().min(1).max(120),
  mode: z.enum(deliveryModes).default('live'),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const apiScopes = ['read', 'write'] as const;
export type ApiScope = (typeof apiScopes)[number];

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(apiScopes)).min(1).default(['read']),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export const settingsUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().max(64).optional(),
  defaultIntervalSeconds: z.number().int().min(15).max(86400).optional(),
  snapshotRetentionHours: z.number().int().min(1).max(24 * 365).optional(),
  observationRetentionDays: z.number().int().min(1).max(3650).optional(),
  eventRetentionDays: z.number().int().min(1).max(3650).optional(),
});

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
