import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CameraStatus,
  ConnectionType,
  DeliveryMode,
  DeliveryStatus,
  EventType,
  IntegrationType,
  ObservationStatus,
  OutputConfig,
  OutputType,
  SensorStateStatus,
  SensorValue,
  StabilizationConfig,
  Trigger,
  ZoneGeometry,
} from '@veyra/shared';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Single row holding this installation's settings. (Table name kept from the multi-tenant
 * prototype; all resources still reference it via organization_id.)
 */
export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Europe/Stockholm'),
  defaultIntervalSeconds: integer('default_interval_seconds').notNull().default(60),
  snapshotRetentionHours: integer('snapshot_retention_hours').notNull().default(72),
  observationRetentionDays: integer('observation_retention_days').notNull().default(30),
  eventRetentionDays: integer('event_retention_days').notNull().default(90),
  /** AI settings managed in the UI. Environment variables take precedence when set. */
  openaiApiKeyEncrypted: text('openai_api_key_encrypted'),
  openaiModel: text('openai_model'),
  openaiReasoningEffort: text('openai_reasoning_effort'),
  createdAt: createdAt(),
});

export const cameraAgents = pgTable(
  'camera_agents',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['pending', 'online', 'offline', 'revoked'] })
      .notNull()
      .default('pending'),
    secretHash: text('secret_hash'),
    enrollmentTokenHash: text('enrollment_token_hash').unique(),
    enrollmentExpiresAt: ts('enrollment_expires_at'),
    version: text('version'),
    hostname: text('hostname'),
    platform: text('platform'),
    lastHeartbeatAt: ts('last_heartbeat_at'),
    createdAt: createdAt(),
  },
  (t) => [index('camera_agents_org_idx').on(t.organizationId)],
);

export const cameras = pgTable(
  'cameras',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => cameraAgents.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    location: text('location').notNull().default(''),
    connectionType: text('connection_type').$type<ConnectionType>().notNull(),
    /** AES-GCM encrypted JSON of CameraConnection (URL, credentials). Never returned by the API. */
    encryptedConnectionConfig: text('encrypted_connection_config'),
    captureIntervalSeconds: integer('capture_interval_seconds').notNull().default(60),
    /** false = manual mode: no scheduled captures/analyses, only "Analysera nu" / test. */
    autoCapture: boolean('auto_capture').notNull().default(true),
    status: text('status').$type<CameraStatus>().notNull().default('connecting'),
    statusMessage: text('status_message'),
    offlineSince: ts('offline_since'),
    enabled: boolean('enabled').notNull().default(true),
    lastFrameAt: ts('last_frame_at'),
    lastCaptureRequestedAt: ts('last_capture_requested_at'),
    createdAt: createdAt(),
  },
  (t) => [index('cameras_org_idx').on(t.organizationId)],
);

export const cameraFrames = pgTable(
  'camera_frames',
  {
    id: id(),
    cameraId: uuid('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    source: text('source', { enum: ['agent', 'upload', 'demo'] }).notNull(),
    capturedAt: ts('captured_at').notNull(),
    expiresAt: ts('expires_at'),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [index('camera_frames_camera_idx').on(t.cameraId, t.capturedAt)],
);

/**
 * Capture work for agents (and demo generator). At most one active job per camera,
 * enforced with a partial unique index, so concurrent schedulers never double-capture.
 */
export const captureJobs = pgTable(
  'capture_jobs',
  {
    id: id(),
    cameraId: uuid('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => cameraAgents.id, { onDelete: 'cascade' }),
    reason: text('reason', { enum: ['scheduled', 'manual', 'test'] }).notNull(),
    status: text('status', { enum: ['pending', 'claimed', 'completed', 'failed', 'expired'] })
      .notNull()
      .default('pending'),
    /** Sensors to analyze when the frame arrives. Empty = snapshot only. */
    sensorIds: jsonb('sensor_ids').$type<string[]>().notNull().default([]),
    frameId: uuid('frame_id').references(() => cameraFrames.id, { onDelete: 'set null' }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    claimedAt: ts('claimed_at'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('capture_jobs_active_camera_uq')
      .on(t.cameraId)
      .where(sql`status in ('pending', 'claimed')`),
    index('capture_jobs_agent_status_idx').on(t.agentId, t.status),
  ],
);

export const zones = pgTable(
  'zones',
  {
    id: id(),
    cameraId: uuid('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    geometry: jsonb('geometry').$type<ZoneGeometry>().notNull(),
    color: text('color').notNull().default('#6366f1'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('zones_camera_idx').on(t.cameraId)],
);

export const sensors = pgTable(
  'sensors',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    cameraId: uuid('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    zoneId: uuid('zone_id').references(() => zones.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    instruction: text('instruction').notNull(),
    outputType: text('output_type').$type<OutputType>().notNull(),
    outputConfig: jsonb('output_config').$type<OutputConfig>().notNull(),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    includeFullImageContext: boolean('include_full_image_context').notNull().default(false),
    /** Send the sensor's labeled reference images with each analysis (if any exist). */
    useExamples: boolean('use_examples').notNull().default(true),
    stabilization: jsonb('stabilization').$type<StabilizationConfig>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastAnalysisRequestedAt: ts('last_analysis_requested_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sensors_org_idx').on(t.organizationId), index('sensors_camera_idx').on(t.cameraId)],
);

export const sensorObservations = pgTable(
  'sensor_observations',
  {
    id: id(),
    sensorId: uuid('sensor_id')
      .notNull()
      .references(() => sensors.id, { onDelete: 'cascade' }),
    frameId: uuid('frame_id').references(() => cameraFrames.id, { onDelete: 'set null' }),
    value: jsonb('value').$type<SensorValue | null>(),
    status: text('status').$type<ObservationStatus>().notNull(),
    reason: text('reason').notNull().default(''),
    /** State after this observation was applied, for history display. */
    stateValue: jsonb('state_value').$type<SensorValue | null>(),
    stateStatus: text('state_status').$type<SensorStateStatus>(),
    causedTransition: boolean('caused_transition').notNull().default(false),
    simulated: boolean('simulated').notNull().default(false),
    modelId: text('model_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    processingDurationMs: integer('processing_duration_ms'),
    observedAt: ts('observed_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sensor_observations_sensor_idx').on(t.sensorId, t.observedAt),
    // Idempotency: one observation per sensor per frame.
    uniqueIndex('sensor_observations_sensor_frame_uq').on(t.sensorId, t.frameId),
  ],
);

export const sensorStates = pgTable('sensor_states', {
  sensorId: uuid('sensor_id')
    .primaryKey()
    .references(() => sensors.id, { onDelete: 'cascade' }),
  value: jsonb('value').$type<SensorValue | null>(),
  status: text('status').$type<SensorStateStatus>().notNull().default('unknown'),
  confirmedAt: ts('confirmed_at'),
  lastObservationAt: ts('last_observation_at'),
  lastObservationId: uuid('last_observation_id'),
  candidateValue: jsonb('candidate_value').$type<SensorValue | null>(),
  candidateCount: integer('candidate_count').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  consecutiveUncertain: integer('consecutive_uncertain').notNull().default(0),
  lastChangedAt: ts('last_changed_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * User-labeled reference images ("this is what <value> looks like"). Each keeps its own copy of
 * the full frame, so snapshot retention never removes it; the current zone is applied when used.
 */
export const sensorExamples = pgTable(
  'sensor_examples',
  {
    id: id(),
    sensorId: uuid('sensor_id')
      .notNull()
      .references(() => sensors.id, { onDelete: 'cascade' }),
    value: jsonb('value').$type<SensorValue>().notNull(),
    note: text('note').notNull().default(''),
    storageKey: text('storage_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sourceFrameId: uuid('source_frame_id').references(() => cameraFrames.id, { onDelete: 'set null' }),
    capturedAt: ts('captured_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sensor_examples_sensor_idx').on(t.sensorId)],
);

export const sensorFeedback = pgTable('sensor_feedback', {
  id: id(),
  observationId: uuid('observation_id')
    .notNull()
    .unique()
    .references(() => sensorObservations.id, { onDelete: 'cascade' }),
  correct: boolean('correct').notNull(),
  correctedValue: jsonb('corrected_value').$type<SensorValue | null>(),
  createdAt: createdAt(),
});

export const events = pgTable(
  'events',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    cameraId: uuid('camera_id').references(() => cameras.id, { onDelete: 'cascade' }),
    sensorId: uuid('sensor_id').references(() => sensors.id, { onDelete: 'cascade' }),
    observationId: uuid('observation_id').references(() => sensorObservations.id, { onDelete: 'set null' }),
    frameId: uuid('frame_id').references(() => cameraFrames.id, { onDelete: 'set null' }),
    eventType: text('event_type').$type<EventType>().notNull(),
    previousValue: jsonb('previous_value').$type<SensorValue | null>(),
    currentValue: jsonb('current_value').$type<SensorValue | null>(),
    /** Deterministic key so the same transition can never create two events. */
    dedupeKey: text('dedupe_key').notNull(),
    simulated: boolean('simulated').notNull().default(false),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('events_org_dedupe_uq').on(t.organizationId, t.dedupeKey),
    index('events_org_time_idx').on(t.organizationId, t.occurredAt),
    index('events_sensor_idx').on(t.sensorId, t.occurredAt),
  ],
);

export const automationRules = pgTable(
  'automation_rules',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sensorId: uuid('sensor_id').references(() => sensors.id, { onDelete: 'cascade' }),
    cameraId: uuid('camera_id').references(() => cameras.id, { onDelete: 'cascade' }),
    triggerType: text('trigger_type').$type<Trigger['type']>().notNull(),
    trigger: jsonb('trigger').$type<Trigger>().notNull(),
    cooldownSeconds: integer('cooldown_seconds').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    lastFiredAt: ts('last_fired_at'),
    createdAt: createdAt(),
  },
  (t) => [index('automation_rules_org_idx').on(t.organizationId), index('automation_rules_sensor_idx').on(t.sensorId)],
);

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').$type<IntegrationType>().notNull(),
    name: text('name').notNull(),
    mode: text('mode').$type<DeliveryMode>().notNull().default('live'),
    encryptedConfig: text('encrypted_config').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('integration_connections_org_idx').on(t.organizationId)],
);

export const automationActions = pgTable(
  'automation_actions',
  {
    id: id(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    integrationConnectionId: uuid('integration_connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'restrict' }),
    actionType: text('action_type').$type<IntegrationType>().notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    ordering: integer('ordering').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [index('automation_actions_rule_idx').on(t.ruleId)],
);

/** One row per (event, rule) that matched; unique to keep automation evaluation idempotent. */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['executed', 'skipped_cooldown'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('automation_runs_event_rule_uq').on(t.eventId, t.ruleId)],
);

export const actionExecutions = pgTable(
  'action_executions',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => automationRules.id, { onDelete: 'set null' }),
    actionId: uuid('action_id').references(() => automationActions.id, { onDelete: 'set null' }),
    integrationConnectionId: uuid('integration_connection_id').references(() => integrationConnections.id, {
      onDelete: 'set null',
    }),
    integrationType: text('integration_type').$type<IntegrationType>().notNull(),
    status: text('status').$type<DeliveryStatus>().notNull().default('pending'),
    isTest: boolean('is_test').notNull().default(false),
    simulated: boolean('simulated').notNull().default(false),
    /** Non-secret destination description, e.g. "+4670…12" or "hooks.slack.com". */
    destination: text('destination'),
    /** Rendered message preview (no secrets). */
    payloadPreview: jsonb('payload_preview').$type<Record<string, unknown>>(),
    attempts: integer('attempts').notNull().default(0),
    responseCode: integer('response_code'),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    uniqueIndex('action_executions_event_action_uq').on(t.eventId, t.actionId),
    index('action_executions_org_idx').on(t.organizationId, t.createdAt),
  ],
);

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sensorId: uuid('sensor_id').references(() => sensors.id, { onDelete: 'set null' }),
    modelId: text('model_id').notNull(),
    success: boolean('success').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: real('estimated_cost_usd').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_org_idx').on(t.organizationId, t.createdAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_org_idx').on(t.organizationId, t.createdAt)],
);
