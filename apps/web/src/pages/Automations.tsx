import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Copy, FlaskConical, History, Pencil, Plus, Send, Trash2, Workflow, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { formatSensorValue, integrationMeta, templateVariables, type IntegrationType, type SensorValue, type Trigger } from '@veyra/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAutomations, useCameras, useIntegrations, useSensors } from '@/hooks/queries';
import { api } from '@/lib/api';
import { DeliveryBadge, triggerTypeLabels } from '@/lib/labels';
import type { Automation, Delivery, IntegrationConnection, Sensor } from '@/lib/types';
import { formatDateTime, timeAgo } from '@/lib/utils';

const NEW_NTFY = '__new_ntfy';
const randomTopic = () => `veyra-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`;

function connectionLabel(c: IntegrationConnection): string {
  const type = integrationMeta[c.type].label;
  const name = c.name === type ? '' : ` · ${c.name}`;
  const sim = c.mode === 'simulated' && !/simulerad/i.test(c.name) ? ' (simulerad)' : '';
  return `${type}${name}${sim}`;
}

function NtfySetup({ connection }: { connection: IntegrationConnection }) {
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; error?: string }>(`/integrations/${connection.id}/test`, { body: { action: {} } }),
    onSuccess: (r) => (r.ok ? toast.success('Testnotis skickad – kolla mobilen') : toast.error(r.error ?? 'Kunde inte skicka')),
    onError: (e) => toast.error(e.message),
  });
  const topic = String(connection.config.topic ?? '');
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-primary-soft/60 p-3 text-xs sm:flex-row sm:items-center sm:justify-between">
      <div>
        Installera appen <b>ntfy</b> i mobilen, tryck <b>+</b> och prenumerera på{' '}
        <code className="rounded bg-card px-1 font-semibold">{topic}</code>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(topic).then(() => toast.success('Ämnet kopierat'))}>
          <Copy /> Kopiera
        </Button>
        <Button type="button" size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
          <Send /> Skicka test
        </Button>
      </div>
    </div>
  );
}

const defaultActionConfig: Record<IntegrationType, Record<string, unknown>> = {
  ntfy: { title: '{{zone.name}}', message: '{{sensor.name}}: {{sensor.previousValueLabel}} → {{sensor.valueLabel}}', priority: 'default', attachSnapshot: true },
  email: {
    to: [],
    subject: '{{zone.name}} ändrade status',
    body: 'Status ändrades från {{sensor.previousValueLabel}} till {{sensor.valueLabel}}.\nKamera: {{camera.name}}\nTid: {{event.timestamp}}',
    attachSnapshot: true,
  },
  sms: { to: [], body: '{{zone.name}} är nu {{sensor.valueLabel}}. Tid: {{event.timestamp}}' },
  webhook: { payloadTemplate: '' },
  slack: { message: '*{{zone.name}}*: {{sensor.previousValueLabel}} → {{sensor.valueLabel}} ({{event.timestamp}})' },
  teams: { message: '**{{zone.name}}**: {{sensor.previousValueLabel}} → {{sensor.valueLabel}} ({{event.timestamp}})' },
  discord: { message: '**{{zone.name}}**: {{sensor.previousValueLabel}} → {{sensor.valueLabel}} ({{event.timestamp}})' },
  http: { method: 'POST', path: '', body: '{"sensor":"{{sensor.name}}","value":"{{sensor.value}}","at":"{{event.timestamp}}"}' },
};

function valueOptions(sensor: Sensor | undefined): Array<{ value: SensorValue; label: string }> {
  if (!sensor) return [];
  if (sensor.outputType === 'boolean') return [true, false].map((v) => ({ value: v, label: formatSensorValue(sensor, v) }));
  if (sensor.outputType === 'enum') return (sensor.outputConfig.allowedValues ?? []).map((v) => ({ value: v, label: formatSensorValue(sensor, v) }));
  return [];
}

export function describeTrigger(t: Trigger, sensor?: Sensor, cameraName?: string): string {
  const fmt = (v: SensorValue | null) => (v === null ? 'valfritt' : sensor ? formatSensorValue(sensor, v) : String(v));
  const who = sensor?.zone?.name ?? sensor?.name ?? 'Sensorn';
  const dur = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
  switch (t.type) {
    case 'state_transition':
      return t.from === null && t.to === null ? `${who} ändrar status` : t.from === null ? `${who} ändras till ${fmt(t.to)}` : `${who} ändras från ${fmt(t.from)} till ${fmt(t.to)}`;
    case 'value_equals':
      return `${who} blir ${fmt(t.value)}`;
    case 'numeric_threshold':
      return `${sensor?.name ?? 'Värdet'} ${{ lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=' }[t.operator]} ${t.threshold}`;
    case 'duration':
      return `${who} är ${fmt(t.value)} i ${dur(t.durationSeconds)}`;
    case 'camera_offline':
      return `${cameraName ?? 'Kameran'} är offline i ${dur(t.durationSeconds)}`;
    case 'sensor_unavailable':
      return `${sensor?.name ?? 'Sensorn'} blir otillgänglig eller inaktuell`;
  }
}

interface ActionDraft {
  id?: string;
  integrationConnectionId: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

function ActionEditor({
  action,
  connection,
  onChange,
  onRemove,
}: {
  action: ActionDraft;
  connection: IntegrationConnection | undefined;
  onChange: (a: ActionDraft) => void;
  onRemove: () => void;
}) {
  const c = action.config;
  const setC = (k: string, v: unknown) => onChange({ ...action, config: { ...c, [k]: v } });
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
  const parseList = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const type = connection?.type;
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Zap className="size-4 text-primary" />
          {connection ? connectionLabel(connection).replace(' (simulerad)', '') : 'Okänd'}
          {connection?.mode === 'simulated' && <Badge variant="demo">Simulerad</Badge>}
        </div>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onRemove} aria-label="Ta bort åtgärd">
          <X />
        </Button>
      </div>
      {type === 'ntfy' && (
        <>
          {connection && <NtfySetup connection={connection} />}
          <Field label="Rubrik">
            <Input value={String(c.title ?? '')} onChange={(e) => setC('title', e.target.value)} />
          </Field>
          <Field label="Meddelande">
            <Textarea rows={2} value={String(c.message ?? '')} onChange={(e) => setC('message', e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prioritet" hint="Hög och brådskande ljuder även när telefonen är på tyst (beroende på inställningar).">
              <Select value={String(c.priority ?? 'default')} onChange={(e) => setC('priority', e.target.value)}>
                <option value="min">Lägsta (tyst)</option>
                <option value="low">Låg</option>
                <option value="default">Normal</option>
                <option value="high">Hög</option>
                <option value="urgent">Brådskande</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm sm:mt-6">
              <Switch checked={c.attachSnapshot !== false} onCheckedChange={(v) => setC('attachSnapshot', v)} /> Visa kamerabilden i notisen
            </label>
          </div>
        </>
      )}
      {type === 'email' && (
        <>
          <Field label="Mottagare" hint="Separera med komma">
            <Input value={list(c.to)} onChange={(e) => setC('to', parseList(e.target.value))} placeholder="lager@foretag.se" />
          </Field>
          <Field label="Ämne">
            <Input value={String(c.subject ?? '')} onChange={(e) => setC('subject', e.target.value)} />
          </Field>
          <Field label="Meddelande">
            <Textarea rows={3} value={String(c.body ?? '')} onChange={(e) => setC('body', e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={!!c.attachSnapshot} onCheckedChange={(v) => setC('attachSnapshot', v)} /> Bifoga bild från händelsen
          </label>
        </>
      )}
      {type === 'sms' && (
        <>
          <Field label="Telefonnummer" hint="E.164-format, t.ex. +46701234567. Separera med komma.">
            <Input value={list(c.to)} onChange={(e) => setC('to', parseList(e.target.value))} placeholder="+46701234567" />
          </Field>
          <Field label="Meddelande">
            <Textarea rows={2} value={String(c.body ?? '')} onChange={(e) => setC('body', e.target.value)} />
          </Field>
        </>
      )}
      {type === 'webhook' && (
        <Field label="JSON-mall (valfri)" hint="Tomt = standardpayload med händelse, sensor, zon och kamera.">
          <Textarea rows={3} className="font-mono text-xs" value={String(c.payloadTemplate ?? '')} onChange={(e) => setC('payloadTemplate', e.target.value)} placeholder='{"dock":"{{zone.name}}","status":"{{sensor.value}}"}' />
        </Field>
      )}
      {(type === 'slack' || type === 'teams' || type === 'discord') && (
        <Field label="Meddelande">
          <Textarea rows={2} value={String(c.message ?? '')} onChange={(e) => setC('message', e.target.value)} />
        </Field>
      )}
      {type === 'http' && (
        <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
          <Field label="Metod">
            <Select value={String(c.method ?? 'POST')} onChange={(e) => setC('method', e.target.value)}>
              {['GET', 'POST', 'PUT', 'PATCH'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Sökväg (relativ till bas-URL)">
            <Input value={String(c.path ?? '')} onChange={(e) => setC('path', e.target.value)} placeholder="/events" />
          </Field>
          <Field label="Body" className="sm:col-span-2">
            <Textarea rows={3} className="font-mono text-xs" value={String(c.body ?? '')} onChange={(e) => setC('body', e.target.value)} />
          </Field>
        </div>
      )}
    </div>
  );
}

function AutomationDialog({ open, onOpenChange, rule }: { open: boolean; onOpenChange: (o: boolean) => void; rule?: Automation | null }) {
  const qc = useQueryClient();
  const sensors = useSensors();
  const cameras = useCameras();
  const integrations = useIntegrations();
  const connections = integrations.data?.data ?? [];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<Trigger['type']>('state_transition');
  const [sensorId, setSensorId] = useState('');
  const [cameraId, setCameraId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [value, setValue] = useState('');
  const [operator, setOperator] = useState<'lt' | 'lte' | 'gt' | 'gte' | 'eq'>('lt');
  const [threshold, setThreshold] = useState('3');
  const [minutes, setMinutes] = useState('5');
  const [cooldown, setCooldown] = useState('0');
  const [enabled, setEnabled] = useState(true);
  const [actions, setActions] = useState<ActionDraft[]>([]);
  const [addConn, setAddConn] = useState('');
  const createNtfy = useMutation({
    mutationFn: () =>
      api<IntegrationConnection>('/integrations', {
        body: { type: 'ntfy', name: 'Push-notis', mode: 'live', config: { serverUrl: 'https://ntfy.sh', topic: randomTopic() } },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }),
    onError: (e) => toast.error(e.message),
  });

  useEffect(() => {
    if (!open) return;
    const t = rule?.trigger;
    setName(rule?.name ?? '');
    setDescription(rule?.description ?? '');
    setTriggerType(t?.type ?? 'state_transition');
    setSensorId(rule?.sensorId ?? '');
    setCameraId(rule?.cameraId ?? '');
    setFrom(t?.type === 'state_transition' && t.from !== null ? JSON.stringify(t.from) : '');
    setTo(t?.type === 'state_transition' && t.to !== null ? JSON.stringify(t.to) : '');
    setValue(t && 'value' in t ? JSON.stringify(t.value) : '');
    setOperator(t?.type === 'numeric_threshold' ? t.operator : 'lt');
    setThreshold(t?.type === 'numeric_threshold' ? String(t.threshold) : '3');
    setMinutes(t && 'durationSeconds' in t ? String(t.durationSeconds / 60) : '5');
    setCooldown(String(rule?.cooldownSeconds ?? 0));
    setEnabled(rule?.enabled ?? true);
    setActions(rule?.actions.map((a) => ({ id: a.id, integrationConnectionId: a.integrationConnectionId, config: a.config, enabled: a.enabled })) ?? []);
  }, [open, rule]);

  const sensor = sensors.data?.find((s) => s.id === sensorId);
  const opts = valueOptions(sensor);

  const buildTrigger = (): Trigger | null => {
    const parse = (s: string) => (s === '' ? null : (JSON.parse(s) as SensorValue));
    switch (triggerType) {
      case 'state_transition':
        return { type: 'state_transition', from: parse(from), to: parse(to) };
      case 'value_equals':
        return value === '' ? null : { type: 'value_equals', value: parse(value)! };
      case 'numeric_threshold':
        return { type: 'numeric_threshold', operator, threshold: Number(threshold) };
      case 'duration':
        return value === '' ? null : { type: 'duration', value: parse(value)!, durationSeconds: Math.round(Number(minutes) * 60) };
      case 'camera_offline':
        return { type: 'camera_offline', durationSeconds: Math.round(Number(minutes) * 60) };
      case 'sensor_unavailable':
        return { type: 'sensor_unavailable' };
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const trigger = buildTrigger();
      if (!trigger) throw new Error('Välj ett värde för villkoret');
      const body = {
        name,
        description,
        trigger,
        sensorId: triggerType === 'camera_offline' ? null : sensorId || null,
        cameraId: triggerType === 'camera_offline' ? cameraId || null : null,
        cooldownSeconds: Number(cooldown),
        enabled,
        actions,
      };
      return rule ? api(`/automations/${rule.id}`, { method: 'PATCH', body }) : api('/automations', { body });
    },
    onSuccess: () => {
      toast.success(rule ? 'Automatiseringen sparades' : 'Automatiseringen skapades');
      qc.invalidateQueries({ queryKey: ['automations'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const numberSensor = sensor?.outputType === 'number';
  const valueSelect = (val: string, setVal: (s: string) => void, allowAny: boolean) => (
    <Select value={val} onChange={(e) => setVal(e.target.value)}>
      {allowAny ? <option value="">Valfritt värde</option> : <option value="">Välj…</option>}
      {opts.map((o) => (
        <option key={String(o.value)} value={JSON.stringify(o.value)}>
          {o.label}
        </option>
      ))}
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{rule ? 'Redigera automatisering' : 'Ny automatisering'}</DialogTitle>
          <DialogDescription>NÄR ett villkor inträffar → GÖR en eller flera åtgärder. Notiser skickas bara för bekräftade händelser.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Namn">
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Lastkaj 2 blev ledig" />
            </Field>
            <Field label="Beskrivning">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>

          <div className="space-y-3 rounded-xl bg-muted/60 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">När</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Villkor">
                <Select value={triggerType} onChange={(e) => setTriggerType(e.target.value as Trigger['type'])}>
                  {Object.entries(triggerTypeLabels).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              {triggerType === 'camera_offline' ? (
                <Field label="Kamera">
                  <Select value={cameraId} onChange={(e) => setCameraId(e.target.value)} required>
                    <option value="">Välj…</option>
                    {cameras.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label="Sensor">
                  <Select value={sensorId} onChange={(e) => setSensorId(e.target.value)} required>
                    <option value="">Välj…</option>
                    {sensors.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.cameraName} · {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {triggerType === 'state_transition' && sensor && !numberSensor && (
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <Field label="Från">{valueSelect(from, setFrom, true)}</Field>
                <ArrowRight className="mb-2.5 size-4 text-muted-foreground" />
                <Field label="Till">{valueSelect(to, setTo, true)}</Field>
              </div>
            )}
            {(triggerType === 'value_equals' || triggerType === 'duration') && sensor && !numberSensor && <Field label="Värde">{valueSelect(value, setValue, false)}</Field>}
            {(triggerType === 'value_equals' || triggerType === 'duration') && numberSensor && (
              <Field label="Värde">
                <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            )}
            {triggerType === 'numeric_threshold' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Jämförelse">
                  <Select value={operator} onChange={(e) => setOperator(e.target.value as typeof operator)}>
                    <option value="lt">mindre än</option>
                    <option value="lte">högst</option>
                    <option value="gt">större än</option>
                    <option value="gte">minst</option>
                    <option value="eq">lika med</option>
                  </Select>
                </Field>
                <Field label="Tröskel">
                  <Input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                </Field>
              </div>
            )}
            {(triggerType === 'duration' || triggerType === 'camera_offline') && (
              <Field label="Varaktighet (minuter)" hint={triggerType === 'duration' ? 'Räknas bara på bekräftat läge — osäkra eller inaktuella perioder nollställer tiden.' : undefined}>
                <Input type="number" min={triggerType === 'duration' ? 0.5 : 0} step={0.5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              </Field>
            )}
            {triggerType === 'state_transition' && (
              <p className="text-xs text-muted-foreground">Utlöses en gång per bekräftad övergång. Osäkra eller saknade observationer räknas aldrig som en ändring.</p>
            )}
          </div>

          <div className="space-y-3 rounded-xl bg-muted/60 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gör följande</div>
            {actions.map((a, i) => (
              <ActionEditor
                key={a.id ?? i}
                action={a}
                connection={connections.find((c) => c.id === a.integrationConnectionId)}
                onChange={(na) => setActions(actions.map((x, j) => (j === i ? na : x)))}
                onRemove={() => setActions(actions.filter((_, j) => j !== i))}
              />
            ))}
            <div className="flex gap-2">
              <Select value={addConn} onChange={(e) => setAddConn(e.target.value)}>
                <option value="">Lägg till åtgärd…</option>
                {!connections.some((c) => c.type === 'ntfy') && <option value={NEW_NTFY}>Push-notis till mobilen (ntfy) – rekommenderas</option>}
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {connectionLabel(c)}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={!addConn}
                loading={createNtfy.isPending}
                onClick={async () => {
                  const conn = addConn === NEW_NTFY ? await createNtfy.mutateAsync() : connections.find((c) => c.id === addConn)!;
                  setActions([...actions, { integrationConnectionId: conn.id, config: { ...defaultActionConfig[conn.type] }, enabled: true }]);
                  setAddConn('');
                }}
              >
                <Plus /> Lägg till
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              E-post, SMS, Slack, Teams, Discord och webhooks läggs till under{' '}
              <Link to="/integrations" className="text-primary hover:underline">
                Integrationer
              </Link>
              .
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Tillgängliga variabler</summary>
              <div className="mt-2 flex flex-wrap gap-1">
                {templateVariables.map((v) => (
                  <code key={v} className="rounded bg-card px-1.5 py-0.5">{`{{${v}}}`}</code>
                ))}
              </div>
            </details>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cooldown (sekunder)" hint="Minsta tid mellan två körningar av regeln.">
              <Input type="number" min={0} value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
            </Field>
            <label className="flex items-center justify-between rounded-lg border border-border px-3 py-2 sm:mt-6">
              <span className="text-sm">Automatiseringen är aktiv</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Avbryt
            </Button>
            <Button type="submit" loading={save.isPending}>
              {rule ? 'Spara' : 'Skapa automatisering'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExecutionsDialog({ rule, onClose }: { rule: Automation | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['executions', rule?.id],
    queryFn: () => api<{ data: Delivery[] }>(`/automations/${rule!.id}/executions`),
    enabled: !!rule,
    refetchInterval: 5000,
  });
  return (
    <Dialog open={!!rule} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Körhistorik · {rule?.name}</DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <Skeleton className="h-32" />
        ) : q.data?.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Inga körningar ännu.</p>
        ) : (
          <div className="max-h-[60vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {q.data?.data.map((d) => (
              <div key={d.id} className="space-y-1 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {integrationMeta[d.integrationType].label}
                    {d.destination && <span className="font-normal text-muted-foreground"> → {d.destination}</span>}
                  </span>
                  <DeliveryBadge status={d.status} simulated={d.simulated} isTest={d.isTest} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(d.createdAt)} · försök {d.attempts}
                  {d.responseCode ? ` · svar ${d.responseCode}` : ''}
                </div>
                {d.errorMessage && <p className="text-xs text-danger">{d.errorMessage}</p>}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AutomationsPage() {
  const qc = useQueryClient();
  const rules = useAutomations();
  const sensors = useSensors();
  const cameras = useCameras();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<{ open: boolean; rule?: Automation | null }>({ open: params.get('new') === '1' });
  const [confirm, setConfirm] = useState<Automation | null>(null);
  const [history, setHistory] = useState<Automation | null>(null);

  useEffect(() => {
    if (params.has('new')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useMutation({
    mutationFn: (r: Automation) => api(`/automations/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
    onError: (e) => toast.error(e.message),
  });
  const test = useMutation({
    mutationFn: (r: Automation) => api(`/automations/${r.id}/test`, { method: 'POST' }),
    onSuccess: () => toast.success('Testhändelse skapad — åtgärderna körs och syns i händelseloggen som test'),
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (r: Automation) => api(`/automations/${r.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirm(null);
      toast.success('Automatiseringen togs bort');
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Automatiseringar"
        description="Regler som reagerar på bekräftade händelser och kör åtgärder."
        actions={
          <Button onClick={() => setDialog({ open: true, rule: null })}>
            <Plus /> Skapa automatisering
          </Button>
        }
      />
      {rules.isLoading ? (
        <Skeleton className="h-48" />
      ) : rules.isError ? (
        <ErrorState error={rules.error} onRetry={() => rules.refetch()} />
      ) : rules.data?.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="Inga automatiseringar"
          description="Skicka SMS, e-post eller anropa en webhook när en sensor ändrar status."
          action={<Button onClick={() => setDialog({ open: true })}>Skapa automatisering</Button>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rules.data?.map((r) => {
            const sensor = sensors.data?.find((s) => s.id === r.sensorId);
            const camera = cameras.data?.find((c) => c.id === r.cameraId);
            return (
              <Card key={r.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{r.name}</div>
                    {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
                  </div>
                  <Switch checked={r.enabled} onCheckedChange={() => toggle.mutate(r)} aria-label="Aktiv" />
                </div>
                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex gap-2">
                    <span className="w-12 shrink-0 text-xs font-semibold uppercase text-muted-foreground">När</span>
                    <span>{describeTrigger(r.trigger, sensor, camera?.name)}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-12 shrink-0 text-xs font-semibold uppercase text-muted-foreground">Gör</span>
                    <div className="flex flex-wrap gap-1.5">
                      {r.actions.length === 0 && <span className="text-muted-foreground">Inga åtgärder</span>}
                      {r.actions.map((a) => (
                        <Badge key={a.id} variant={a.connectionMode === 'simulated' ? 'demo' : 'default'}>
                          {integrationMeta[a.actionType].label}
                          {a.connectionMode === 'simulated' ? ' (sim.)' : ''}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="text-xs text-muted-foreground">Senast utlöst: {r.lastFiredAt ? timeAgo(r.lastFiredAt) : 'aldrig'}</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setHistory(r)}>
                      <History /> Historik
                    </Button>
                    <Button size="sm" variant="ghost" loading={test.isPending && test.variables?.id === r.id} onClick={() => test.mutate(r)}>
                      <FlaskConical /> Testa
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => setDialog({ open: true, rule: r })} aria-label="Redigera">
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(r)} aria-label="Ta bort">
                      <Trash2 className="text-danger" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <AutomationDialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} rule={dialog.rule} />
      <ExecutionsDialog rule={history} onClose={() => setHistory(null)} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Ta bort automatisering?"
        description={`"${confirm?.name}" och dess åtgärder tas bort.`}
        loading={remove.isPending}
        onConfirm={() => confirm && remove.mutate(confirm)}
      />
    </>
  );
}
