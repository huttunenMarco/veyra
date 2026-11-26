import { Activity, ArrowRight, BellRing, CameraOff, Clock, FlaskConical, ShieldAlert, ShieldCheck, Video } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { integrationMeta } from '@veyra/shared';
import { DeliveryBadge, deliveryStatusMeta, eventTypeLabels } from '@/lib/labels';
import type { VeyraEvent } from '@/lib/types';
import { cn, formatDateTime, timeAgo } from '@/lib/utils';
import { Snapshot } from './Snapshot';

const icons = {
  state_changed: Activity,
  sensor_unavailable: ShieldAlert,
  sensor_recovered: ShieldCheck,
  camera_offline: CameraOff,
  camera_online: Video,
  duration_reached: Clock,
  test: FlaskConical,
} as const;

const iconTone: Record<string, string> = {
  state_changed: 'bg-primary-soft text-primary',
  sensor_unavailable: 'bg-warning-soft text-warning',
  sensor_recovered: 'bg-success-soft text-success',
  camera_offline: 'bg-danger-soft text-danger',
  camera_online: 'bg-success-soft text-success',
  duration_reached: 'bg-warning-soft text-warning',
  test: 'bg-muted text-muted-foreground',
};

export function EventRow({ event, compact, highlight }: { event: VeyraEvent; compact?: boolean; highlight?: boolean }) {
  const [open, setOpen] = useState(highlight ?? false);
  const Icon = icons[event.eventType] ?? Activity;
  const title =
    event.eventType === 'camera_offline' || event.eventType === 'camera_online'
      ? event.cameraName
      : [event.zone?.name, event.sensor?.name].filter(Boolean).join(' · ') || event.cameraName;
  return (
    <div className={cn('border-b border-border last:border-0', highlight && 'bg-primary-soft/40')}>
      <button className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50" onClick={() => setOpen(!open)}>
        <div className={cn('mt-0.5 rounded-lg p-2', iconTone[event.eventType])}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium">{title ?? 'Händelse'}</span>
            <span className="text-xs text-muted-foreground">{eventTypeLabels[event.eventType]}</span>
            {event.simulated && <Badge variant="demo">Simulerad</Badge>}
          </div>
          {(event.eventType === 'state_changed' || event.eventType === 'test' || event.eventType === 'duration_reached') && event.sensor && (
            <div className="mt-1 flex items-center gap-1.5 text-sm">
              {event.eventType !== 'duration_reached' && (
                <>
                  <span className="text-muted-foreground">{event.previousLabel ?? 'Okänd'}</span>
                  <ArrowRight className="size-3.5 text-muted-foreground" />
                </>
              )}
              <span className="font-medium">{event.currentLabel ?? 'Okänd'}</span>
            </div>
          )}
          {!compact && event.cameraName && event.eventType.startsWith('sensor') === false && event.eventType !== 'camera_offline' && event.eventType !== 'camera_online' && (
            <div className="mt-0.5 text-xs text-muted-foreground">{event.cameraName}</div>
          )}
          {event.deliveries.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <BellRing className="size-3.5 text-muted-foreground" />
              {event.deliveries.map((d) => (
                <Badge key={d.id} variant={deliveryStatusMeta[d.status].variant}>
                  {integrationMeta[d.integrationType].label}: {deliveryStatusMeta[d.status].label.toLowerCase()}
                  {d.simulated ? ' (sim.)' : ''}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" title={formatDateTime(event.occurredAt)}>
          {timeAgo(event.occurredAt)}
        </span>
      </button>
      {open && (
        <div className="grid gap-4 px-4 pb-4 sm:grid-cols-[220px_1fr] animate-in">
          {event.frameId ? <Snapshot frameId={event.frameId} className="rounded-lg" /> : <div className="hidden sm:block" />}
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
              <span className="text-muted-foreground">Tidpunkt</span>
              <span>{formatDateTime(event.occurredAt)}</span>
              <span className="text-muted-foreground">Kamera</span>
              <span>{event.cameraName ?? '–'}</span>
              <span className="text-muted-foreground">Zon</span>
              <span>{event.zone?.name ?? '–'}</span>
              <span className="text-muted-foreground">Automatiseringar</span>
              <span>{event.automations.length ? event.automations.map((a) => `${a.name}${a.status === 'skipped_cooldown' ? ' (cooldown)' : ''}`).join(', ') : 'Inga'}</span>
              {typeof event.metadata.reason === 'string' && (
                <>
                  <span className="text-muted-foreground">Orsak</span>
                  <span>{event.metadata.reason === 'stale' ? 'Inga nya observationer' : event.metadata.reason === 'failures' ? 'Upprepade analysfel' : String(event.metadata.reason)}</span>
                </>
              )}
            </div>
            {event.deliveries.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Leveranser</div>
                {event.deliveries.map((d) => (
                  <div key={d.id} className="rounded-lg border border-border p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {d.connectionName ?? d.integrationType} {d.destination && <span className="text-muted-foreground">→ {d.destination}</span>}
                      </span>
                      <DeliveryBadge status={d.status} simulated={d.simulated} isTest={d.isTest} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Försök: {d.attempts}
                      {d.responseCode ? ` · Svar: ${d.responseCode}` : ''}
                      {d.completedAt ? ` · ${formatDateTime(d.completedAt)}` : ''}
                    </div>
                    {d.errorMessage && <p className="mt-1 text-xs text-danger">{d.errorMessage}</p>}
                    {d.payloadPreview && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] text-muted-foreground">Visa innehåll</summary>
                        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(d.payloadPreview, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
