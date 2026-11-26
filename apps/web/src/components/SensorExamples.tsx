import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Check, FlaskConical, Images, RotateCcw, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatSensorValue, type SensorValue } from '@veyra/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown';
import { Switch } from '@/components/ui/switch';
import { api, frameUrl } from '@/lib/api';
import type { Observation, Sensor } from '@/lib/types';
import { cn, formatDateTime } from '@/lib/utils';

interface Example {
  id: string;
  value: SensorValue;
  valueLabel: string;
  note: string;
  capturedAt: string;
  sourceFrameId: string | null;
}

interface Evaluation {
  examplesUsed: number;
  total: number;
  correct: number;
  accuracy: number;
  results: Array<{ observationId: string; frameId: string; observedAt: string; expectedLabel: string; gotLabel: string; status: string; reason: string; correct: boolean }>;
}

/** The answers a user can pick for this sensor (numbers are free-form and not offered). */
export function sensorValues(sensor: Sensor): Array<{ value: SensorValue; label: string }> {
  if (sensor.outputType === 'boolean') return [true, false].map((v) => ({ value: v, label: formatSensorValue(sensor, v) }));
  if (sensor.outputType === 'enum') return (sensor.outputConfig.allowedValues ?? []).map((v) => ({ value: v, label: formatSensorValue(sensor, v) }));
  return [];
}

const examplesKey = (sensorId: string) => ['examples', sensorId];

/** 👍 / 👎 (with "what was right?") and "use as reference image" for one observation. */
export function ObservationActions({ sensor, observation: o }: { sensor: Sensor; observation: Observation }) {
  const qc = useQueryClient();
  const values = sensorValues(sensor);
  const feedback = useMutation({
    mutationFn: (body: { correct: boolean; correctedValue?: SensorValue | null }) => api(`/observations/${o.id}/feedback`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['history', sensor.id] }),
    onError: (e) => toast.error(e.message),
  });
  const addExample = useMutation({
    mutationFn: (value: SensorValue) => api(`/sensors/${sensor.id}/examples`, { body: { frameId: o.frameId, value } }),
    onSuccess: (_d, value) => {
      toast.success(`Sparad som referensbild för "${formatSensorValue(sensor, value)}"`);
      qc.invalidateQueries({ queryKey: examplesKey(sensor.id) });
    },
    onError: (e) => toast.error(e.message),
  });
  const wrongChoices = values.filter((v) => v.value !== o.value);
  const reanalyze = useMutation({
    mutationFn: () => api<{ observation: Observation }>(`/observations/${o.id}/reanalyze`, { method: 'POST' }),
    onSuccess: (r) => {
      const v = r.observation.value;
      toast.success(`Ny analys av bilden: ${v === null ? 'inget svar' : formatSensorValue(sensor, v)}`);
      qc.invalidateQueries({ queryKey: ['history', sensor.id] });
      qc.invalidateQueries({ queryKey: ['sensors'] });
      qc.invalidateQueries({ queryKey: ['cameras'] });
      qc.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="flex shrink-0 items-start gap-1">
      {o.frameId && o.snapshotAvailable && (
        <Button
          size="icon-sm"
          variant={o.status === 'unavailable' ? 'outline' : 'ghost'}
          loading={reanalyze.isPending}
          onClick={() => reanalyze.mutate()}
          aria-label="Analysera bilden igen"
          title="Analysera bilden igen, som om den togs nu"
        >
          {!reanalyze.isPending && <RotateCcw />}
        </Button>
      )}
      <Button
        size="icon-sm"
        variant={o.feedback?.correct === true ? 'secondary' : 'ghost'}
        onClick={() => feedback.mutate({ correct: true })}
        aria-label="Korrekt"
        title="Korrekt"
      >
        <ThumbsUp className={cn(o.feedback?.correct === true && 'text-success')} />
      </Button>
      {wrongChoices.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant={o.feedback?.correct === false ? 'secondary' : 'ghost'} aria-label="Felaktig" title="Felaktig">
              <ThumbsDown className={cn(o.feedback?.correct === false && 'text-danger')} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Vad var rätt svar?</DropdownMenuLabel>
            {wrongChoices.map((v) => (
              <DropdownMenuItem key={String(v.value)} onSelect={() => feedback.mutate({ correct: false, correctedValue: v.value })}>
                {v.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => feedback.mutate({ correct: false, correctedValue: null })}>Vet inte / annat</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          size="icon-sm"
          variant={o.feedback?.correct === false ? 'secondary' : 'ghost'}
          onClick={() => feedback.mutate({ correct: false })}
          aria-label="Felaktig"
          title="Felaktig"
        >
          <ThumbsDown className={cn(o.feedback?.correct === false && 'text-danger')} />
        </Button>
      )}
      {values.length > 0 && o.frameId && o.snapshotAvailable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Använd som referensbild" title="Använd som referensbild">
              <BookmarkPlus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Använd som referensbild – bilden visar:</DropdownMenuLabel>
            {values.map((v) => (
              <DropdownMenuItem key={String(v.value)} onSelect={() => addExample.mutate(v.value)}>
                {v.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Optional reference images per value, on/off switch, and "test against history". */
export function ExamplesCard({ sensor }: { sensor: Sensor }) {
  const qc = useQueryClient();
  const values = sensorValues(sensor);
  const examples = useQuery({
    queryKey: examplesKey(sensor.id),
    queryFn: () => api<{ data: Example[]; useExamples: boolean }>(`/sensors/${sensor.id}/examples`),
  });
  const [withExamples, setWithExamples] = useState(true);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);

  const toggle = useMutation({
    mutationFn: (useExamples: boolean) => api(`/sensors/${sensor.id}`, { method: 'PATCH', body: { useExamples } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examplesKey(sensor.id) });
      qc.invalidateQueries({ queryKey: ['sensors'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/sensors/${sensor.id}/examples/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: examplesKey(sensor.id) }),
    onError: (e) => toast.error(e.message),
  });
  const evaluate = useMutation({
    mutationFn: () => api<Evaluation>(`/sensors/${sensor.id}/evaluate`, { body: { useExamples: withExamples, limit: 10 } }),
    onSuccess: setEvaluation,
    onError: (e) => toast.error(e.message),
  });

  if (values.length === 0) return null; // Reference images are for boolean/category sensors.
  const list = examples.data?.data ?? [];
  const enabled = examples.data?.useExamples ?? sensor.useExamples;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Images className="size-4" /> Referensbilder <span className="font-normal text-muted-foreground">(valfritt)</span>
          </CardTitle>
          <CardDescription>
            Visa AI:n hur varje läge ser ut just här. Välj <BookmarkPlus className="inline size-3.5" /> på en observation nedan. 1–2 bilder per läge
            räcker oftast; de skickas med vid varje analys (något högre kostnad).
          </CardDescription>
        </div>
        {list.length > 0 && (
          <label className="flex shrink-0 items-center gap-2 text-xs">
            Används
            <Switch checked={enabled} onCheckedChange={(c) => toggle.mutate(c)} />
          </label>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Inga referensbilder. Sensorn fungerar som vanligt utan dem.</p>
        ) : (
          <div className={cn('grid gap-4 sm:grid-cols-2', !enabled && 'opacity-50')}>
            {values.map((v) => {
              const items = list.filter((e) => e.value === v.value);
              return (
                <div key={String(v.value)} className="space-y-2">
                  <div className="text-xs font-medium">
                    {v.label} <span className="text-muted-foreground">({items.length}/3)</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {items.length === 0 && <span className="text-xs text-muted-foreground">Ingen bild ännu</span>}
                    {items.map((e) => (
                      <div key={e.id} className="group relative" title={`${formatDateTime(e.capturedAt)}${e.note ? ` – ${e.note}` : ''}`}>
                        <img
                          src={`/api/v1/sensors/${sensor.id}/examples/${e.id}/image`}
                          alt={v.label}
                          className="h-24 w-auto rounded-md border border-border object-cover"
                        />
                        <button
                          onClick={() => remove.mutate(e.id)}
                          className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          aria-label="Ta bort referensbild"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-3 rounded-lg bg-muted/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              <FlaskConical className="mr-1.5 inline size-4" />
              Testa mot historiken
            </div>
            <div className="flex items-center gap-3">
              {list.length > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  Med referensbilder
                  <Switch checked={withExamples} onCheckedChange={setWithExamples} />
                </label>
              )}
              <Button size="sm" variant="outline" loading={evaluate.isPending} onClick={() => evaluate.mutate()}>
                Kör test
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Kör nuvarande instruktion mot upp till 10 bilder du markerat med 👍/👎 och visar hur många som blir rätt. Varje bild är ett AI-anrop.
          </p>
          {evaluation && (
            <div className="space-y-2 animate-in">
              <div className="flex items-center gap-2">
                <Badge variant={evaluation.accuracy >= 0.9 ? 'success' : evaluation.accuracy >= 0.6 ? 'warning' : 'danger'}>
                  {evaluation.correct} av {evaluation.total} rätt ({Math.round(evaluation.accuracy * 100)} %)
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {evaluation.examplesUsed > 0 ? `med ${evaluation.examplesUsed} referensbilder` : 'utan referensbilder'}
                </span>
              </div>
              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                {evaluation.results.map((r) => (
                  <div key={r.observationId} className="flex items-center gap-3 p-2 text-xs">
                    <img src={frameUrl(r.frameId)} alt="" className="h-10 w-16 rounded object-cover" />
                    {r.correct ? <Check className="size-4 shrink-0 text-success" /> : <X className="size-4 shrink-0 text-danger" />}
                    <div className="min-w-0 flex-1">
                      <div>
                        Rätt: <b>{r.expectedLabel}</b> · AI: <b>{r.gotLabel}</b>
                        {r.status !== 'confirmed' && <span className="text-warning"> ({r.status === 'uncertain' ? 'osäker' : 'otillgänglig'})</span>}
                      </div>
                      <div className="truncate text-muted-foreground" title={r.reason}>
                        {r.reason}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

