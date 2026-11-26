import type { CameraStatus, ConnectionType, DeliveryStatus, EventType, ObservationStatus, SensorStateStatus } from '@veyra/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';

type Variant = NonNullable<BadgeProps['variant']>;

export const cameraStatusMeta: Record<CameraStatus, { label: string; variant: Variant }> = {
  online: { label: 'Online', variant: 'success' },
  offline: { label: 'Offline', variant: 'danger' },
  connecting: { label: 'Ansluter', variant: 'warning' },
  error: { label: 'Fel', variant: 'danger' },
  disabled: { label: 'Inaktiverad', variant: 'neutral' },
};

export const connectionTypeLabels: Record<ConnectionType, string> = {
  rtsp: 'RTSP',
  http_snapshot: 'HTTP-snapshot',
  manual: 'Manuell uppladdning',
  demo: 'Demokamera',
};

export const stateStatusMeta: Record<SensorStateStatus, { label: string; variant: Variant }> = {
  confirmed: { label: 'Bekräftad', variant: 'success' },
  unknown: { label: 'Okänd', variant: 'neutral' },
  uncertain: { label: 'Osäker', variant: 'warning' },
  unavailable: { label: 'Otillgänglig', variant: 'danger' },
  stale: { label: 'Inaktuell', variant: 'warning' },
};

export const observationStatusMeta: Record<ObservationStatus, { label: string; variant: Variant }> = {
  confirmed: { label: 'Säker', variant: 'success' },
  uncertain: { label: 'Osäker', variant: 'warning' },
  unavailable: { label: 'Ej tillgänglig', variant: 'danger' },
};

export const deliveryStatusMeta: Record<DeliveryStatus, { label: string; variant: Variant }> = {
  pending: { label: 'Väntar', variant: 'neutral' },
  processing: { label: 'Skickar', variant: 'warning' },
  delivered: { label: 'Levererad', variant: 'success' },
  failed: { label: 'Misslyckad', variant: 'danger' },
  retrying: { label: 'Försöker igen', variant: 'warning' },
};

export const eventTypeLabels: Record<EventType, string> = {
  state_changed: 'Statusändring',
  sensor_unavailable: 'Sensor otillgänglig',
  sensor_recovered: 'Sensor återställd',
  camera_offline: 'Kamera offline',
  camera_online: 'Kamera online',
  duration_reached: 'Varaktighet uppnådd',
  test: 'Test',
};

export const triggerTypeLabels: Record<string, string> = {
  state_transition: 'Statusövergång',
  value_equals: 'Värde blir',
  numeric_threshold: 'Tröskelvärde',
  duration: 'Varaktighet',
  camera_offline: 'Kamera offline',
  sensor_unavailable: 'Sensor otillgänglig',
};

export function CameraStatusBadge({ status }: { status: CameraStatus }) {
  const m = cameraStatusMeta[status] ?? cameraStatusMeta.offline;
  return (
    <Badge variant={m.variant} dot>
      {m.label}
    </Badge>
  );
}

export function StateStatusBadge({ status }: { status: SensorStateStatus }) {
  const m = stateStatusMeta[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function DeliveryBadge({ status, simulated, isTest }: { status: DeliveryStatus; simulated?: boolean; isTest?: boolean }) {
  const m = deliveryStatusMeta[status];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={m.variant}>{m.label}</Badge>
      {simulated && <Badge variant="demo">Simulerad</Badge>}
      {isTest && <Badge variant="outline">Test</Badge>}
    </span>
  );
}

/** Color tone of a sensor value: uncertainty is amber, unknown neutral. Never shows non-confirmed state as healthy. */
export function stateTone(status: SensorStateStatus): 'ok' | 'warn' | 'bad' | 'none' {
  if (status === 'confirmed') return 'ok';
  if (status === 'uncertain' || status === 'stale') return 'warn';
  if (status === 'unavailable') return 'bad';
  return 'none';
}
