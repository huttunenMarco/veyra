import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Pencil, ScanEye, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { formatSensorValue, type SensorValue } from '@veyra/shared';
import { EventRow } from '@/components/EventList';
import { ExamplesCard, ObservationActions } from '@/components/SensorExamples';
import { SensorDialog } from '@/components/SensorDialog';
import { Snapshot } from '@/components/Snapshot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { Select } from '@/components/ui/input';
import { useCamera, useEvents, useSensor } from '@/hooks/queries';
import { api } from '@/lib/api';
import { observationStatusMeta, StateStatusBadge, stateTone } from '@/lib/labels';
import { useCrumb } from '@/lib/store';
import type { Observation, Sensor } from '@/lib/types';
import { cn, formatDateTime, formatInterval, timeAgo } from '@/lib/utils';

const PALETTE = ['#6366f1', '#06b6d4', '#f59e0b', '#ec4899', '#22c55e', '#8b5cf6', '#ef4444', '#14b8a6'];

/** Enum/boolean timeline: confirmed segments colored per value; uncertain/unavailable/unknown shown explicitly as gaps. */
function StateTimeline({ sensor, observations }: { sensor: Sensor; observations: Observation[] }) {
  const items = [...observations].reverse();
  if (items.length < 2) return <p className="text-sm text-muted-foreground">För få observationer för en tidslinje.</p>;
  const start = new Date(items[0]!.observedAt).getTime();
  const end = Date.now();
  const span = Math.max(1, end - start);
  const values = sensor.outputType === 'boolean' ? ['true', 'false'] : (sensor.outputConfig.allowedValues ?? []);
  const color = (v: SensorValue | null, status: string | null) => {
    if (status !== 'confirmed' || v === null) return status === 'unavailable' ? '#ef444455' : '#f59e0b55';
    const i = values.indexOf(String(v));
    return PALETTE[i % PALETTE.length]!;
  };
  const spec = { outputType: sensor.outputType, outputConfig: sensor.outputConfig };
  return (
    <div>
      <div className="flex h-8 w-full overflow-hidden rounded-md bg-muted">
        {items.map((o, i) => {
          const t0 = new Date(o.observedAt).getTime();
          const t1 = i < items.length - 1 ? new Date(items[i + 1]!.observedAt).getTime() : end;
          const width = ((t1 - t0) / span) * 100;
          return (
            <div
              key={o.id}
              style={{ width: `${width}%`, background: color(o.stateValue, o.stateStatus) }}
              title={`${formatDateTime(o.observedAt)}: ${o.stateStatus === 'confirmed' ? formatSensorValue(spec, o.stateValue) : (o.stateStatus ?? 'okänd')}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {values.map((v, i) => (
          <span key={v} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            {formatSensorValue(spec, sensor.outputType === 'boolean' ? v === 'true' : v)}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[#f59e0b55]" /> Okänd / osäker / inaktuell
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[#ef444455]" /> Otillgänglig
        </span>
        <span className="ml-auto">{formatDateTime(items[0]!.observedAt)} – nu</span>
      </div>
    </div>
  );
}

function NumberChart({ observations, unit }: { observations: Observation[]; unit?: string }) {
  // Non-confirmed observations become null so the line breaks instead of hiding gaps.
  const data = [...observations].reverse().map((o) => ({
    t: new Date(o.observedAt).getTime(),
    value: o.status === 'confirmed' && typeof o.value === 'number' ? o.value : null,
    state: typeof o.stateValue === 'number' && o.stateStatus === 'confirmed' ? o.stateValue : null,
  }));
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: -16, right: 8, top: 8 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t) => new Date(t).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })} fontSize={11} stroke="var(--muted-foreground)" />
          <YAxis allowDecimals={false} fontSize={11} stroke="var(--muted-foreground)" />
          <Tooltip
            labelFormatter={(t) => formatDateTime(new Date(t as number))}
            formatter={(v, n) => [v === null ? 'saknas' : `${v}${unit ? ` ${unit}` : ''}`, n === 'state' ? 'Bekräftat' : 'Observerat']}
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
          />
          <Line type="stepAfter" dataKey="state" stroke="#6366f1" strokeWidth={2} dot={false} connectNulls={false} />
          <Line type="monotone" dataKey="value" stroke="#94a3b8" strokeWidth={1} dot={{ r: 2 }} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SimulatePanel({ sensor }: { sensor: Sensor }) {
  const qc = useQueryClient();
  const options: Array<{ label: string; value: SensorValue }> =
    sensor.outputType === 'boolean'
      ? [
          { label: formatSensorValue(sensor, true), value: true },
          { label: formatSensorValue(sensor, false), value: false },
        ]
      : sensor.outputType === 'enum'
        ? (sensor.outputConfig.allowedValues ?? []).map((v) => ({ label: formatSensorValue(sensor, v), value: v }))
        : [0, 1, 2, 3, 5, 8].map((n) => ({ label: String(n), value: n }));
  const [value, setValue] = useState<string>(String(options[0]?.value ?? ''));
  const simulate = useMutation({
    mutationFn: (status: 'confirmed' | 'uncertain' | 'unavailable') => {
      const opt = options.find((o) => String(o.value) === value);
      return api(`/sensors/${sensor.id}/simulate`, { body: { value: status === 'unavailable' ? null : (opt?.value ?? null), status } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sensors'] });
      qc.invalidateQueries({ queryKey: ['history'] });
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['cameras'] });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical className="size-4" /> Simulera observation
        </CardTitle>
        <CardDescription>
          Testa regler och tillståndsmotorn utan kamera. Simulerade observationer markeras tydligt. Statusen ändras först efter{' '}
          {sensor.stabilization.requiredConsecutive === 1 ? '1 bekräftelse' : `${sensor.stabilization.requiredConsecutive} bekräftelser i rad`}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Select value={value} onChange={(e) => setValue(e.target.value)} className="w-40">
          {options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="outline" loading={simulate.isPending && simulate.variables === 'confirmed'} onClick={() => simulate.mutate('confirmed')}>
          Säker observation
        </Button>
        <Button size="sm" variant="ghost" onClick={() => simulate.mutate('uncertain')}>
          Osäker
        </Button>
        <Button size="sm" variant="ghost" onClick={() => simulate.mutate('unavailable')}>
          Misslyckad
        </Button>
      </CardContent>
    </Card>
  );
}

export function SensorDetailPage() {
  const { sensorId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const sensor = useSensor(sensorId);
  const s = sensor.data;
  const camera = useCamera(s?.cameraId ?? '');
  useCrumb(sensorId, s?.name);
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const history = useQuery({
    queryKey: ['history', sensorId],
    queryFn: () => api<{ data: Observation[] }>(`/sensors/${sensorId}/history?limit=200`),
    refetchInterval: 10_000,
  });
  const events = useEvents({ sensorId, limit: '20' });

  const analyze = useMutation({
    mutationFn: () => api<{ observation: Observation }>(`/sensors/${sensorId}/analyze`, { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(`Analys klar: ${r.observation.value === null ? 'inget värde' : String(r.observation.value)} (${observationStatusMeta[r.observation.status].label.toLowerCase()})`);
      qc.invalidateQueries({ queryKey: ['history', sensorId] });
      qc.invalidateQueries({ queryKey: ['sensors'] });
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api(`/sensors/${sensorId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Sensorn togs bort');
      qc.invalidateQueries({ queryKey: ['sensors'] });
      navigate('/sensors');
    },
  });

  const obs = useMemo(() => history.data?.data ?? [], [history.data]);

  if (sensor.isLoading) return <Skeleton className="h-96" />;
  if (sensor.isError || !s) return <ErrorState error={sensor.error} onRetry={() => sensor.refetch()} />;
  const tone = stateTone(s.state.status);

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{s.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <Link to={`/cameras/${s.cameraId}`} className="hover:underline">
              {s.cameraName}
            </Link>{' '}
            · {s.zone?.name ?? 'Hela bilden'} ·{' '}
            {camera.data && !camera.data.autoCapture ? 'endast "Analysera nu"' : `var ${formatInterval(s.intervalSeconds)}`} {!s.enabled && '· pausad'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEdit(true)}>
            <Pencil /> Redigera
          </Button>
          <Button variant="outline" size="icon" onClick={() => setConfirm(true)} aria-label="Ta bort">
            <Trash2 className="text-danger" />
          </Button>
          <Button loading={analyze.isPending} onClick={() => analyze.mutate()}>
            <ScanEye /> Analysera nu
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Bekräftat läge</span>
              <StateStatusBadge status={s.state.status} />
            </div>
            <div className={cn('mt-2 text-3xl font-semibold', tone === 'warn' && 'text-warning', tone === 'bad' && 'text-danger', tone === 'none' && 'text-muted-foreground')}>
              {s.state.valueLabel}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Bekräftat sedan</dt>
              <dd>{s.state.confirmedAt ? timeAgo(s.state.confirmedAt) : '–'}</dd>
              <dt className="text-muted-foreground">Senaste ändring</dt>
              <dd>{s.state.lastChangedAt ? timeAgo(s.state.lastChangedAt) : '–'}</dd>
              <dt className="text-muted-foreground">Senaste observation</dt>
              <dd>{timeAgo(s.state.lastObservationAt)}</dd>
              <dt className="text-muted-foreground">Väntande värde</dt>
              <dd>
                {s.state.pendingValue !== null && s.state.pendingCount > 0
                  ? `${formatSensorValue(s, s.state.pendingValue)} (${s.state.pendingCount}/${s.stabilization.requiredConsecutive})`
                  : '–'}
              </dd>
            </dl>
          </Card>
          <Card className="p-5">
            <div className="text-xs font-medium text-muted-foreground">Instruktion</div>
            <p className="mt-1 text-sm">{s.instruction}</p>
            <div className="mt-3 flex flex-wrap gap-1">
              <Badge variant="outline">{s.outputType === 'enum' ? 'Kategorier' : s.outputType === 'boolean' ? 'Ja/Nej' : 'Antal'}</Badge>
              {(s.outputConfig.allowedValues ?? []).map((v) => (
                <Badge key={v} variant="neutral">
                  {v}
                </Badge>
              ))}
            </div>
          </Card>
          <SimulatePanel sensor={s} />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{s.outputType === 'number' ? 'Värde över tid' : 'Tillstånd över tid'}</CardTitle>
            </CardHeader>
            <CardContent>
              {history.isLoading ? (
                <Skeleton className="h-24" />
              ) : s.outputType === 'number' ? (
                <NumberChart observations={obs} unit={s.outputConfig.unit} />
              ) : (
                <StateTimeline sensor={s} observations={obs} />
              )}
            </CardContent>
          </Card>

          <ExamplesCard sensor={s} />

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="text-sm">Observationer</CardTitle>
              <CardDescription>
                👍/👎 sparar om svaret var rätt (används av "Testa mot historiken"). Bokmärket sparar bilden som referensbild.
              </CardDescription>
            </CardHeader>
            {obs.length === 0 ? (
              <CardContent>
                <EmptyState icon={ScanEye} title="Inga observationer" description='Klicka "Analysera nu" för att köra sensorn.' />
              </CardContent>
            ) : (
              <div className="max-h-[560px] divide-y divide-border overflow-y-auto border-t border-border">
                {obs.slice(0, 100).map((o) => (
                  <div key={o.id} className="flex gap-3 px-4 py-3">
                    {o.snapshotAvailable && o.frameId ? (
                      <a href={`/api/v1/frames/${o.frameId}/image`} target="_blank" rel="noreferrer" className="shrink-0">
                        <Snapshot frameId={o.frameId} className="w-28 rounded-md" />
                      </a>
                    ) : (
                      <div className="grid w-28 shrink-0 place-items-center rounded-md bg-muted text-[11px] text-muted-foreground aspect-video">
                        {o.simulated && !o.frameId ? 'Simulerad' : 'Ingen bild'}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{o.value === null ? '–' : formatSensorValue(s, o.value)}</span>
                        <Badge variant={observationStatusMeta[o.status].variant}>{observationStatusMeta[o.status].label}</Badge>
                        {o.simulated && <Badge variant="demo">Simulerad</Badge>}
                        {o.causedTransition && <Badge>Statusändring</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{o.reason}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {formatDateTime(o.observedAt)} · läge: {o.stateStatus === 'confirmed' ? formatSensorValue(s, o.stateValue) : (o.stateStatus ?? '–')}
                        {o.modelId ? ` · ${o.modelId}` : ''}
                        {o.processingDurationMs ? ` · ${o.processingDurationMs} ms` : ''}
                      </p>
                    </div>
                    <ObservationActions sensor={s} observation={o} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="text-sm">Händelser</CardTitle>
            </CardHeader>
            {events.data?.data.length ? (
              events.data.data.map((e) => <EventRow key={e.id} event={e} compact />)
            ) : (
              <CardContent className="text-sm text-muted-foreground">Inga händelser ännu.</CardContent>
            )}
          </Card>
        </div>
      </div>

      {camera.data && <SensorDialog open={edit} onOpenChange={setEdit} cameraId={s.cameraId} zones={camera.data.zones} sensor={s} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Ta bort sensor?"
        description="Sensorn, dess historik och automatiseringar kopplade till den tas bort."
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
