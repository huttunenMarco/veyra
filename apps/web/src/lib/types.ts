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

export interface Instance {
  name: string;
  timezone: string;
  aiConfigured: boolean;
  cameraCount: number;
}

export interface FrameMeta {
  id: string;
  width: number;
  height: number;
  capturedAt: string;
  source: 'agent' | 'upload' | 'demo';
}

export interface Camera {
  id: string;
  name: string;
  description: string;
  location: string;
  connectionType: ConnectionType;
  agentId: string | null;
  captureIntervalSeconds: number;
  /** false = manual mode, only "Analysera nu". */
  autoCapture: boolean;
  status: CameraStatus;
  statusMessage: string | null;
  offlineSince: string | null;
  enabled: boolean;
  lastFrameAt: string | null;
  createdAt: string;
  connection: {
    url: string | null;
    host: string | null;
    hasUsername: boolean;
    hasPassword: boolean;
    rtspTransport: 'tcp' | 'udp';
    demoScene: string | null;
  };
}

export interface CameraListItem extends Camera {
  zoneCount: number;
  sensorCount: number;
  lastAnalysisAt: string | null;
  latestFrame: FrameMeta | null;
}

export interface Zone {
  id: string;
  cameraId: string;
  name: string;
  geometry: ZoneGeometry;
  color: string;
  enabled: boolean;
}

export interface SensorState {
  sensorId: string;
  value: SensorValue | null;
  valueLabel: string;
  status: SensorStateStatus;
  confirmedAt: string | null;
  lastObservationAt: string | null;
  lastChangedAt: string | null;
  pendingValue: SensorValue | null;
  pendingCount: number;
  staleAfterSeconds: number;
}

export interface Sensor {
  id: string;
  cameraId: string;
  cameraName: string;
  zoneId: string | null;
  zone: { id: string; name: string; color: string } | null;
  name: string;
  description: string;
  instruction: string;
  outputType: OutputType;
  outputConfig: OutputConfig;
  intervalSeconds: number;
  includeFullImageContext: boolean;
  useExamples: boolean;
  stabilization: StabilizationConfig;
  enabled: boolean;
  state: SensorState;
}

export interface CameraDetail extends Camera {
  zones: Zone[];
  sensors: Sensor[];
  latestFrame: FrameMeta | null;
  agent: { id: string; name: string; status: string; lastHeartbeatAt: string | null } | null;
}

export interface Observation {
  id: string;
  sensorId: string;
  frameId: string | null;
  value: SensorValue | null;
  status: ObservationStatus;
  reason: string;
  stateValue: SensorValue | null;
  stateStatus: SensorStateStatus | null;
  causedTransition: boolean;
  simulated: boolean;
  modelId: string | null;
  processingDurationMs: number | null;
  observedAt: string;
  snapshotAvailable?: boolean;
  feedback?: { correct: boolean; correctedValue: SensorValue | null } | null;
}

export interface Delivery {
  id: string;
  integrationType: IntegrationType;
  connectionName: string | null;
  status: DeliveryStatus;
  simulated: boolean;
  isTest: boolean;
  destination: string | null;
  attempts: number;
  responseCode: number | null;
  errorMessage: string | null;
  payloadPreview: Record<string, unknown> | null;
  completedAt: string | null;
  createdAt?: string;
  ruleName?: string | null;
}

export interface VeyraEvent {
  id: string;
  eventType: EventType;
  cameraId: string | null;
  cameraName: string | null;
  sensorId: string | null;
  frameId: string | null;
  sensor: { id: string; name: string; outputType: OutputType } | null;
  zone: { id: string; name: string; color: string } | null;
  previousValue: SensorValue | null;
  currentValue: SensorValue | null;
  previousLabel: string | null;
  currentLabel: string | null;
  simulated: boolean;
  metadata: Record<string, unknown>;
  occurredAt: string;
  automations: Array<{ ruleId: string; name: string; status: string }>;
  deliveries: Delivery[];
}

export interface AutomationAction {
  id: string;
  ruleId: string;
  integrationConnectionId: string;
  actionType: IntegrationType;
  config: Record<string, unknown>;
  ordering: number;
  enabled: boolean;
  connectionName: string;
  connectionMode: DeliveryMode;
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  sensorId: string | null;
  cameraId: string | null;
  triggerType: Trigger['type'];
  trigger: Trigger;
  cooldownSeconds: number;
  enabled: boolean;
  lastFiredAt: string | null;
  actions: AutomationAction[];
}

export interface IntegrationConnection {
  id: string;
  type: IntegrationType;
  name: string;
  mode: DeliveryMode;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsSet: string[];
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  status: 'pending' | 'online' | 'offline' | 'revoked';
  version: string | null;
  hostname: string | null;
  platform: string | null;
  lastHeartbeatAt: string | null;
  enrollmentPending: boolean;
  enrollmentExpiresAt: string | null;
  cameraCount: number;
  createdAt: string;
}

export interface Paged<T> {
  data: T[];
  nextCursor?: string | null;
}
