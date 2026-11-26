import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FlaskConical, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { formatSensorValue, sensorInputSchema, type OutputType, type SensorValue } from '@veyra/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { observationStatusMeta } from '@/lib/labels';
import type { Sensor, Zone } from '@/lib/types';
import { cn } from '@/lib/utils';

const knownLabels: Record<string, string> = {
  occupied: 'Upptagen',
  available: 'Ledig',
  open: 'Öppen',
  closed: 'Stängd',
  present: 'Närvarande',
  absent: 'Frånvarande',
  empty: 'Tom',
  full: 'Full',
  blocked: 'Blockerad',
  clear: 'Fri',
  on: 'På',
  off: 'Av',
  running: 'I drift',
  stopped: 'Stoppad',
};

const STOP = new Set(['the', 'and', 'or', 'annars', 'eller', 'om', 'return', 'returnera', 'svara', 'med', 'och', 'not', 'otherwise', 'else', 'if']);

/** Heuristic: derive output type and allowed values from a natural-language instruction. */
export function suggestOutput(instruction: string): { outputType: OutputType; values: string[] } {
  const text = instruction.trim();
  if (/\b(hur många|antal|räkna|how many|count|number of)\b/i.test(text)) return { outputType: 'number', values: [] };
  const found: string[] = [];
  const add = (w: string) => {
    const v = w.toLowerCase();
    if (/^[a-z][a-z0-9_-]{1,39}$/.test(v) && !STOP.has(v) && v !== 'unknown' && !found.includes(v)) found.push(v);
  };
  for (const m of text.matchAll(/:\s*([A-Za-z_][\w-]*)/g)) add(m[1]!);
  for (const m of text.matchAll(/["'`]([A-Za-z_][\w-]*)["'`]/g)) add(m[1]!);
  const list = text.match(/(?:return|returnera|svara(?: med)?)\s+([\w\s,-]+?)(?:\.|$)/i);
  if (list) for (const w of list[1]!.split(/,|\s+or\s+|\s+eller\s+|\s+/)) add(w.trim());
  if (found.length >= 2) return { outputType: 'enum', values: found.slice(0, 8) };
  return { outputType: 'boolean', values: [] };
}

interface FormValues {
  name: string;
  zoneId: string;
  instruction: string;
  outputType: OutputType;
  allowedValues: string[];
  valueLabels: Record<string, string>;
  unit: string;
  intervalSeconds: number;
  enabled: boolean;
  description: string;
  includeFullImageContext: boolean;
  useExamples: boolean;
  requiredConsecutive: number;
  unavailableAfter: number;
  uncertainAfter: number;
  staleAfterSeconds: string;
}

interface TestResult {
  value: SensorValue | null;
  status: 'confirmed' | 'uncertain' | 'unavailable';
  reason: string;
  modelId: string;
  simulated: boolean;
  durationMs: number;
  examplesUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
}

const intervals = [
  [30, '30 sekunder'],
  [60, '1 minut'],
  [120, '2 minuter'],
  [300, '5 minuter'],
  [900, '15 minuter'],
  [3600, '1 timme'],
] as const;

export function SensorDialog({
  open,
  onOpenChange,
  cameraId,
  zones,
  sensor,
  defaultZoneId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cameraId: string;
  zones: Zone[];
  sensor?: Sensor | null;
  defaultZoneId?: string | null;
}) {
  const qc = useQueryClient();
  const [advanced, setAdvanced] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const defaults = (): FormValues => ({
    name: sensor?.name ?? '',
    zoneId: sensor ? (sensor.zoneId ?? '') : (defaultZoneId ?? ''),
    instruction: sensor?.instruction ?? '',
    outputType: sensor?.outputType ?? 'enum',
    allowedValues: sensor?.outputConfig.allowedValues ?? [],
    valueLabels: sensor?.outputConfig.valueLabels ?? {},
    unit: sensor?.outputConfig.unit ?? '',
    intervalSeconds: sensor?.intervalSeconds ?? 60,
    enabled: sensor?.enabled ?? true,
    description: sensor?.description ?? '',
    includeFullImageContext: sensor?.includeFullImageContext ?? false,
    useExamples: sensor?.useExamples ?? true,
    requiredConsecutive: sensor?.stabilization.requiredConsecutive ?? 2,
    unavailableAfter: sensor?.stabilization.unavailableAfter ?? 3,
    uncertainAfter: sensor?.stabilization.uncertainAfter ?? 3,
    staleAfterSeconds: sensor?.stabilization.staleAfterSeconds ? String(sensor.stabilization.staleAfterSeconds) : '',
  });

  const form = useForm<FormValues>({ defaultValues: defaults() });
  const { register, watch, setValue, handleSubmit, reset } = form;
  const v = watch();

  useEffect(() => {
    if (open) {
      reset(defaults());
      setTest(null);
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sensor?.id]);

  const outputConfig = () => {
    const labels = Object.fromEntries(Object.entries(v.valueLabels).filter(([k, l]) => l && (v.outputType === 'boolean' ? ['true', 'false'].includes(k) : v.allowedValues.includes(k))));
    if (v.outputType === 'enum') return { allowedValues: v.allowedValues, valueLabels: labels };
    if (v.outputType === 'number') return { unit: v.unit || undefined, min: 0 };
    return { valueLabels: labels };
  };

  const payload = (values: FormValues) => ({
    cameraId,
    zoneId: values.zoneId || null,
    name: values.name,
    description: values.description,
    instruction: values.instruction,
    outputType: values.outputType,
    outputConfig: outputConfig(),
    intervalSeconds: Number(values.intervalSeconds),
    includeFullImageContext: values.includeFullImageContext,
    useExamples: values.useExamples,
    enabled: values.enabled,
    stabilization: {
      requiredConsecutive: Number(values.requiredConsecutive),
      unavailableAfter: Number(values.unavailableAfter),
      uncertainAfter: Number(values.uncertainAfter),
      ...(values.staleAfterSeconds ? { staleAfterSeconds: Number(values.staleAfterSeconds) } : {}),
    },
  });

  const testMutation = useMutation({
    mutationFn: (fresh: boolean) =>
      api<TestResult>('/sensors/test-analysis', {
        body: {
          cameraId,
          zoneId: v.zoneId || null,
          instruction: v.instruction,
          outputType: v.outputType,
          outputConfig: outputConfig(),
          includeFullImageContext: v.includeFullImageContext,
          sensorId: sensor?.id,
          useExamples: v.useExamples,
          fresh,
        },
      }),
    onSuccess: setTest,
    onError: (e) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof payload>) =>
      sensor ? api(`/sensors/${sensor.id}`, { method: 'PATCH', body }) : api('/sensors', { body }),
    onSuccess: () => {
      toast.success(sensor ? 'Sensorn uppdaterades' : 'Sensorn skapades');
      qc.invalidateQueries({ queryKey: ['cameras'] });
      qc.invalidateQueries({ queryKey: ['sensors'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const onSubmit = handleSubmit((values) => {
    const body = payload(values);
    const r = sensorInputSchema.safeParse(body);
    if (!r.success) {
      setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate(body);
  });

  const addValue = (raw: string) => {
    const val = raw.trim().toLowerCase().replace(/\s+/g, '_');
    if (!val || v.allowedValues.includes(val)) return;
    setValue('allowedValues', [...v.allowedValues, val]);
    if (knownLabels[val] && !v.valueLabels[val]) setValue('valueLabels', { ...v.valueLabels, [val]: knownLabels[val]! });
    setNewValue('');
  };

  const applySuggestion = () => {
    const s = suggestOutput(v.instruction);
    setValue('outputType', s.outputType);
    if (s.outputType === 'enum') {
      setValue('allowedValues', s.values);
      setValue('valueLabels', Object.fromEntries(s.values.filter((x) => knownLabels[x]).map((x) => [x, knownLabels[x]!])));
      toast.success(`Hittade värden: ${s.values.join(', ')}`);
    } else {
      toast.success(s.outputType === 'number' ? 'Föreslår numeriskt svar (antal)' : 'Föreslår ja/nej-svar');
    }
  };

  const spec = { outputType: v.outputType, outputConfig: outputConfig() };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{sensor ? 'Redigera AI-sensor' : 'Skapa AI-sensor'}</DialogTitle>
          <DialogDescription>Beskriv med vanliga ord vad som ska övervakas. Veyra returnerar ett strukturerat värde.</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-5 md:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Namn" error={errors.name}>
                <Input placeholder="t.ex. Lastkaj 2 beläggning" {...register('name')} />
              </Field>
              <Field label="Område">
                <Select {...register('zoneId')}>
                  <option value="">Hela bilden</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Instruktion" error={errors.instruction} hint="Var konkret om vad som räknas som varje svar.">
              <Textarea
                rows={4}
                placeholder="Kontrollera om en lastbil står vid kajen. Om en lastbil står där: occupied. Annars: available."
                {...register('instruction')}
              />
            </Field>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Svarstyp</span>
                <Button type="button" variant="ghost" size="sm" onClick={applySuggestion} disabled={v.instruction.length < 5}>
                  <Sparkles /> Föreslå från instruktion
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['boolean', 'Ja / Nej', 'true / false'],
                    ['enum', 'Kategorier', 't.ex. ledig / upptagen'],
                    ['number', 'Antal', 'heltal eller mätvärde'],
                  ] as const
                ).map(([type, label, hint]) => (
                  <button
                    type="button"
                    key={type}
                    onClick={() => setValue('outputType', type)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left transition-colors',
                      v.outputType === type ? 'border-primary bg-primary-soft ring-1 ring-primary' : 'border-border hover:bg-muted',
                    )}
                  >
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-xs text-muted-foreground">{hint}</div>
                  </button>
                ))}
              </div>
            </div>

            {v.outputType === 'enum' && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <div className="text-sm font-medium">Möjliga värden</div>
                <div className="space-y-2">
                  {v.allowedValues.map((val) => (
                    <div key={val} className="flex items-center gap-2">
                      <code className="w-32 shrink-0 truncate rounded bg-muted px-2 py-1 text-xs">{val}</code>
                      <Input
                        className="h-8"
                        placeholder="Visningsnamn (valfritt)"
                        value={v.valueLabels[val] ?? ''}
                        onChange={(e) => setValue('valueLabels', { ...v.valueLabels, [val]: e.target.value })}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setValue('allowedValues', v.allowedValues.filter((x) => x !== val))}
                        aria-label={`Ta bort ${val}`}
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    className="h-8"
                    placeholder="nytt värde, t.ex. occupied"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addValue(newValue);
                      }
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => addValue(newValue)}>
                    <Plus /> Lägg till
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  "Okänd" hanteras separat — modellen kan alltid svara osäker eller otillgänglig istället för att gissa.
                </p>
                {errors['outputConfig.allowedValues'] && <p className="text-xs text-danger">{errors['outputConfig.allowedValues']}</p>}
              </div>
            )}

            {v.outputType === 'boolean' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Visningsnamn för ja">
                  <Input placeholder="Ja" value={v.valueLabels.true ?? ''} onChange={(e) => setValue('valueLabels', { ...v.valueLabels, true: e.target.value })} />
                </Field>
                <Field label="Visningsnamn för nej">
                  <Input placeholder="Nej" value={v.valueLabels.false ?? ''} onChange={(e) => setValue('valueLabels', { ...v.valueLabels, false: e.target.value })} />
                </Field>
              </div>
            )}

            {v.outputType === 'number' && (
              <Field label="Enhet" hint="Modellen ska inte gissa — osäkra räkningar markeras som osäkra.">
                <Input placeholder="st" {...register('unit')} />
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Analysintervall">
                <Select {...register('intervalSeconds', { valueAsNumber: true })}>
                  {intervals.map(([s, l]) => (
                    <option key={s} value={s}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:mt-6">
                <span className="text-sm">Automatisk analys aktiv</span>
                <Switch checked={v.enabled} onCheckedChange={(c) => setValue('enabled', c)} />
              </label>
            </div>

            <div className="rounded-lg border border-border">
              <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium" onClick={() => setAdvanced(!advanced)}>
                Avancerade inställningar
                <ChevronDown className={cn('size-4 transition-transform', advanced && 'rotate-180')} />
              </button>
              {advanced && (
                <div className="grid gap-4 border-t border-border p-3 sm:grid-cols-2">
                  <Field label="Bekräftelser före statusändring" hint="Antal observationer i rad med nytt värde.">
                    <Input type="number" min={1} max={20} {...register('requiredConsecutive', { valueAsNumber: true })} />
                  </Field>
                  <Field label="Otillgänglig efter misslyckanden">
                    <Input type="number" min={1} max={50} {...register('unavailableAfter', { valueAsNumber: true })} />
                  </Field>
                  <Field label="Osäker efter osäkra svar">
                    <Input type="number" min={1} max={50} {...register('uncertainAfter', { valueAsNumber: true })} />
                  </Field>
                  <Field label="Inaktuell efter (sekunder)" hint="Tomt = 3 × intervallet">
                    <Input type="number" min={30} placeholder="auto" {...register('staleAfterSeconds')} />
                  </Field>
                  <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:col-span-2">
                    <span className="text-sm">
                      Skicka med hela bilden som kontext
                      <span className="block text-xs text-muted-foreground">Bättre förståelse, något högre kostnad.</span>
                    </span>
                    <Switch checked={v.includeFullImageContext} onCheckedChange={(c) => setValue('includeFullImageContext', c)} />
                  </label>
                  {sensor && (
                    <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:col-span-2">
                      <span className="text-sm">
                        Använd referensbilder
                        <span className="block text-xs text-muted-foreground">Skickar med sensorns märkta exempelbilder (hanteras på sensorns sida).</span>
                      </span>
                      <Switch checked={v.useExamples} onCheckedChange={(c) => setValue('useExamples', c)} />
                    </label>
                  )}
                  <Field label="Beskrivning" className="sm:col-span-2">
                    <Textarea rows={2} {...register('description')} />
                  </Field>
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-3 rounded-lg bg-muted/60 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FlaskConical className="size-4 text-primary" /> Testa analysen
            </div>
            <p className="text-xs text-muted-foreground">Kör instruktionen mot senaste bilden utan att spara. Bilden skickas till AI-leverantören.</p>
            <div className="flex flex-col gap-2">
              <Button type="button" variant="outline" size="sm" loading={testMutation.isPending && testMutation.variables === false} disabled={v.instruction.length < 5 || testMutation.isPending} onClick={() => testMutation.mutate(false)}>
                Testa på senaste bild
              </Button>
              <Button type="button" variant="ghost" size="sm" loading={testMutation.isPending && testMutation.variables === true} disabled={v.instruction.length < 5 || testMutation.isPending} onClick={() => testMutation.mutate(true)}>
                Ta ny bild och testa
              </Button>
            </div>
            {test && (
              <div className="space-y-2 rounded-lg border border-border bg-card p-3 animate-in">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={observationStatusMeta[test.status].variant}>{observationStatusMeta[test.status].label}</Badge>
                  {test.simulated && <Badge variant="demo">Simulerad</Badge>}
                </div>
                <div className="text-xl font-semibold">{test.value === null ? 'Okänd' : formatSensorValue(spec, test.value)}</div>
                <p className="text-sm text-muted-foreground">{test.reason}</p>
                <pre className="overflow-x-auto rounded bg-muted p-2 text-[11px]">
                  {JSON.stringify({ value: test.value, status: test.status, reason: test.reason }, null, 2)}
                </pre>
                <p className="text-[11px] text-muted-foreground">
                  {test.modelId} · {test.durationMs} ms{test.examplesUsed ? ` · ${test.examplesUsed} referensbilder` : ''}{test.inputTokens ? ` · ${test.inputTokens + (test.outputTokens ?? 0)} tokens` : ''}
                </p>
              </div>
            )}
          </aside>

          <DialogFooter className="md:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Avbryt
            </Button>
            <Button type="submit" loading={save.isPending}>
              {sensor ? 'Spara ändringar' : 'Skapa sensor'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
