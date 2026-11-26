import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Cpu, KeyRound, Plus, RefreshCw, ShieldOff, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, PageHeader, Skeleton } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAgents } from '@/hooks/queries';
import { api } from '@/lib/api';
import type { Agent } from '@/lib/types';
import { formatDateTime, timeAgo } from '@/lib/utils';

interface SettingsData {
  organization: {
    id: string;
    name: string;
    timezone: string;
    defaultIntervalSeconds: number;
    snapshotRetentionHours: number;
    observationRetentionDays: number;
    eventRetentionDays: number;
  };
  ai: AiInfo;
  notificationsMode: 'live' | 'simulate';
}

interface AiInfo {
  provider: 'openai' | 'mock';
  model: string;
  reasoningEffort: string | null;
  configured: boolean;
  keySource: 'env' | 'ui' | null;
  lockedByEnv: { apiKey: boolean; model: boolean; reasoningEffort: boolean };
  inputCostPerMTok: number;
  outputCostPerMTok: number;
}

const MODELS = ['gpt-5-mini', 'gpt-5', 'gpt-5-nano', 'gpt-4.1-mini', 'gpt-4.1'];

function AiSettingsCard({ ai }: { ai: AiInfo }) {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [model, setModel] = useState(ai.model);
  const [effort, setEffort] = useState(ai.reasoningEffort ?? '');
  useEffect(() => {
    setModel(ai.model);
    setEffort(ai.reasoningEffort ?? '');
  }, [ai.model, ai.reasoningEffort]);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['settings'] });
    qc.invalidateQueries({ queryKey: ['instance'] });
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AiInfo>('/settings/ai', { method: 'PATCH', body }),
    onSuccess: () => {
      setKey('');
      invalidate();
      toast.success('AI-inställningarna sparades');
    },
    onError: (e) => toast.error(e.message),
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; error?: string }>('/settings/ai/test', { body: { openaiApiKey: key || undefined, openaiModel: model } }),
    onSuccess: (r) => (r.ok ? toast.success(`Nyckeln fungerar och ${model} är tillgänglig`) : toast.error(r.error ?? 'Testet misslyckades')),
    onError: (e) => toast.error(e.message),
  });
  const reasoning = model.startsWith('gpt-5') || model.startsWith('o');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm">
          OpenAI
          {ai.provider === 'openai' ? <Badge variant="success">Aktiv</Badge> : <Badge variant="demo">Simulerad – ingen nyckel</Badge>}
        </CardTitle>
        <CardDescription>
          Skapa en nyckel på{' '}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-primary hover:underline">
            platform.openai.com/api-keys
          </a>
          . Nyckeln sparas krypterad på din server och visas aldrig igen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const body: Record<string, unknown> = {};
            if (key) body.openaiApiKey = key;
            if (!ai.lockedByEnv.model) body.openaiModel = model;
            if (!ai.lockedByEnv.reasoningEffort) body.openaiReasoningEffort = reasoning ? effort : '';
            save.mutate(body);
          }}
        >
          <Field
            label="API-nyckel"
            hint={
              ai.lockedByEnv.apiKey
                ? 'Satt via OPENAI_API_KEY på servern.'
                : ai.keySource === 'ui'
                  ? 'En nyckel är sparad. Klistra in en ny för att byta.'
                  : 'Utan nyckel används simulerade resultat som inte tittar på bilden.'
            }
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder={ai.configured ? '•••••••••••• (sparad)' : 'sk-...'}
              value={key}
              disabled={ai.lockedByEnv.apiKey}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Modell" hint={ai.lockedByEnv.model ? 'Satt via OPENAI_MODEL.' : 'gpt-5-mini är ett bra standardval.'}>
              <Select value={model} disabled={ai.lockedByEnv.model} onChange={(e) => setModel(e.target.value)}>
                {[...new Set([model, ...MODELS])].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            </Field>
            {reasoning && (
              <Field label="Noggrannhet" hint="Högre = bättre men långsammare och dyrare.">
                <Select value={effort} disabled={ai.lockedByEnv.reasoningEffort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="minimal">Minimal</option>
                  <option value="low">Låg (standard)</option>
                  <option value="medium">Medel</option>
                  <option value="high">Hög</option>
                </Select>
              </Field>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={save.isPending}>
              Spara
            </Button>
            <Button type="button" variant="outline" loading={test.isPending} disabled={!key && !ai.configured} onClick={() => test.mutate()}>
              Testa nyckeln
            </Button>
            {ai.keySource === 'ui' && (
              <Button type="button" variant="ghost" onClick={() => save.mutate({ openaiApiKey: null })}>
                Ta bort nyckeln
              </Button>
            )}
          </div>
        </form>
        <p className="text-xs text-muted-foreground">
          Prisuppskattning: ${ai.inputCostPerMTok} / ${ai.outputCostPerMTok} per 1M tokens (in/ut). Integritet: bilder (beskurna till zonen)
          skickas till OpenAI vid varje analys. Veyra gör ingen ansiktsigenkänning eller identifiering av personer.
        </p>
      </CardContent>
    </Card>
  );
}

interface Usage {
  days: number;
  totals: { requests: number; failures: number; inputTokens: number | null; outputTokens: number | null; cost: number | null };
  daily: Array<{ day: string; requests: number; cost: number | null }>;
}

function useGeneralForm(s: SettingsData) {
  const qc = useQueryClient();
  const [v, setV] = useState(s.organization);
  useEffect(() => setV(s.organization), [s.organization]);
  const save = useMutation({
    mutationFn: () =>
      api('/settings', {
        method: 'PATCH',
        body: {
          name: v.name,
          timezone: v.timezone,
          defaultIntervalSeconds: Number(v.defaultIntervalSeconds),
          snapshotRetentionHours: Number(v.snapshotRetentionHours),
          observationRetentionDays: Number(v.observationRetentionDays),
          eventRetentionDays: Number(v.eventRetentionDays),
        },
      }),
    onSuccess: () => {
      toast.success('Inställningarna sparades');
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['instance'] });
    },
    onError: (e) => toast.error(e.message),
  });
  return { v, setV, save };
}

function Copyable({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 pr-10 text-xs">{text}</pre>
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute right-1.5 top-1.5"
        onClick={() => navigator.clipboard.writeText(text).then(() => toast.success('Kopierat'))}
        aria-label="Kopiera"
      >
        <Copy />
      </Button>
    </div>
  );
}

function EnrollmentDialog({ data, onClose }: { data: { token: string; apiUrl: string; name: string } | null; onClose: () => void }) {
  const [os, setOs] = useState<'windows' | 'unix' | 'docker'>('windows');
  if (!data) return null;
  const cmds = {
    windows: `# PowerShell, i Veyra-mappen\n$env:VEYRA_API_URL="${data.apiUrl}"\n$env:VEYRA_ENROLLMENT_TOKEN="${data.token}"\npnpm --filter camera-agent dev`,
    unix: `VEYRA_API_URL=${data.apiUrl} \\\nVEYRA_ENROLLMENT_TOKEN=${data.token} \\\npnpm --filter camera-agent dev`,
    docker: `cd apps/camera-agent && docker build -t veyra-agent .\ndocker run -d --restart unless-stopped --name veyra-agent \\\n  -e VEYRA_API_URL=${data.apiUrl} \\\n  -e VEYRA_ENROLLMENT_TOKEN=${data.token} \\\n  -v veyra-agent:/data veyra-agent`,
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Starta agenten "{data.name}"</DialogTitle>
          <DialogDescription>
            Kör agenten på en dator i samma nätverk som kamerorna. Registreringskoden gäller i 24 timmar och kan bara användas en gång. Agenten
            ansluter bara utgående — inga portar behöver öppnas i routern.
          </DialogDescription>
        </DialogHeader>
        <Field label="Registreringskod">
          <Copyable text={data.token} />
        </Field>
        <div className="flex gap-1">
          {(['windows', 'unix', 'docker'] as const).map((k) => (
            <Button key={k} size="sm" variant={os === k ? 'secondary' : 'ghost'} onClick={() => setOs(k)}>
              {k === 'windows' ? 'Windows' : k === 'unix' ? 'macOS / Linux' : 'Docker'}
            </Button>
          ))}
        </div>
        <Copyable text={cmds[os]} />
        <p className="text-xs text-muted-foreground">
          Kräver Node.js 22+ och FFmpeg (Windows: <code>winget install Gyan.FFmpeg</code>). Om API:t körs på en annan dator, ersätt localhost med dess
          IP-adress. Agenten sparar sin nyckel i <code>.veyra-agent.json</code> och behöver inte koden igen.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function AgentsTab() {
  const qc = useQueryClient();
  const agents = useAgents();
  const [name, setName] = useState('');
  const [enroll, setEnroll] = useState<{ token: string; apiUrl: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<{ agent: Agent; action: 'revoke' | 'delete' } | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ agent: Agent; enrollmentToken: string; apiUrl: string }>('/agents', { body: { name } }),
    onSuccess: (r) => {
      setEnroll({ token: r.enrollmentToken, apiUrl: r.apiUrl, name: r.agent.name });
      setName('');
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const reenroll = useMutation({
    mutationFn: (a: Agent) => api<{ enrollmentToken: string; apiUrl: string }>(`/agents/${a.id}/enrollment`, { method: 'POST' }).then((r) => ({ ...r, name: a.name })),
    onSuccess: (r) => {
      setEnroll({ token: r.enrollmentToken, apiUrl: r.apiUrl, name: r.name });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const act = useMutation({
    mutationFn: ({ agent, action }: { agent: Agent; action: 'revoke' | 'delete' }) =>
      action === 'revoke' ? api(`/agents/${agent.id}/revoke`, { method: 'POST' }) : api(`/agents/${agent.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const statusBadge = (a: Agent) =>
    a.status === 'online' ? (
      <Badge variant="success" dot>Online</Badge>
    ) : a.status === 'offline' ? (
      <Badge variant="danger" dot>Offline</Badge>
    ) : a.status === 'revoked' ? (
      <Badge variant="neutral">Återkallad</Badge>
    ) : (
      <Badge variant="warning">Väntar på registrering</Badge>
    );

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Namn på agent, t.ex. Lager-PC" required />
          <Button type="submit" loading={create.isPending}>
            <Plus /> Skapa agent
          </Button>
        </form>
      </Card>
      {agents.isLoading ? (
        <Skeleton className="h-24" />
      ) : agents.data?.length === 0 ? (
        <EmptyState
          icon={Cpu}
          title="Inga fjärragenter"
          description="Behövs bara för kameror på ett annat nätverk än servern, t.ex. i sommarstugan. Kameror i samma nätverk hämtar Veyra själv."
        />
      ) : (
        <Card className="divide-y divide-border">
          {agents.data?.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Cpu className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {a.name} {statusBadge(a)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {a.hostname ? `${a.hostname} · ` : ''}
                  {a.version ? `v${a.version} · ` : ''}
                  {a.cameraCount} kameror · senaste kontakt {timeAgo(a.lastHeartbeatAt)}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => reenroll.mutate(a)}>
                <KeyRound /> {a.status === 'pending' ? 'Visa ny kod' : 'Registrera om'}
              </Button>
              {a.status !== 'revoked' && (
                <Button size="sm" variant="ghost" onClick={() => setConfirm({ agent: a, action: 'revoke' })}>
                  <ShieldOff /> Återkalla
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" onClick={() => setConfirm({ agent: a, action: 'delete' })} aria-label="Ta bort">
                <Trash2 className="text-danger" />
              </Button>
            </div>
          ))}
        </Card>
      )}
      <EnrollmentDialog data={enroll} onClose={() => setEnroll(null)} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.action === 'revoke' ? 'Återkalla agent?' : 'Ta bort agent?'}
        description={
          confirm?.action === 'revoke'
            ? 'Agentens nyckel slutar fungera direkt. Kameror via agenten går offline tills den registreras om.'
            : 'Agenten tas bort. Kameror som använder den behöver en ny agent.'
        }
        confirmLabel={confirm?.action === 'revoke' ? 'Återkalla' : 'Ta bort'}
        loading={act.isPending}
        onConfirm={() => confirm && act.mutate(confirm)}
      />
    </div>
  );
}

function SystemTab() {
  const q = useQuery({ queryKey: ['queues'], queryFn: () => api<Record<string, { counts: Record<string, number>; failed: Array<{ id: string; failedReason: string; attemptsMade: number; timestamp: number }> }>>('/system/queues'), refetchInterval: 5000 });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api<{ data: Array<{ id: string; action: string; resourceType: string; createdAt: string; metadata: Record<string, unknown> }> }>('/settings/audit') });
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Bakgrundsköer</CardTitle>
          <CardDescription>Misslyckade jobb sparas för inspektion.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {q.isLoading && <Skeleton className="h-24" />}
          {q.data &&
            Object.entries(q.data).map(([name, d]) => (
              <div key={name} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{name.replace('veyra-', '')}</span>
                  <span className="flex flex-wrap gap-1 text-xs">
                    <Badge variant="neutral">väntar {d.counts.waiting ?? 0}</Badge>
                    <Badge variant="neutral">aktiva {d.counts.active ?? 0}</Badge>
                    <Badge variant="neutral">fördröjda {d.counts.delayed ?? 0}</Badge>
                    <Badge variant={d.counts.failed ? 'danger' : 'neutral'}>misslyckade {d.counts.failed ?? 0}</Badge>
                  </span>
                </div>
                {d.failed.slice(0, 3).map((f) => (
                  <p key={f.id} className="mt-1 truncate text-xs text-danger" title={f.failedReason}>
                    {formatDateTime(new Date(f.timestamp))}: {f.failedReason}
                  </p>
                ))}
              </div>
            ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Granskningslogg</CardTitle>
          <CardDescription>Känsliga konfigurationsändringar.</CardDescription>
        </CardHeader>
        <CardContent className="max-h-[480px] space-y-1 overflow-y-auto">
          {audit.data?.data.map((a) => (
            <div key={a.id} className="flex justify-between gap-3 border-b border-border py-1.5 text-xs last:border-0">
              <span>
                <code>{a.action}</code>
              </span>
              <span className="shrink-0 text-muted-foreground">{formatDateTime(a.createdAt)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsData>('/settings') });
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/settings/usage?days=30') });
  const [purge, setPurge] = useState<null | 'snapshots' | 'observations' | 'events'>(null);
  const purgeMutation = useMutation({
    mutationFn: (target: string) => api<{ removed: number }>('/settings/purge', { body: { target } }),
    onSuccess: (r) => {
      toast.success(`${r.removed} poster raderades`);
      setPurge(null);
      qc.invalidateQueries();
    },
    onError: (e) => toast.error(e.message),
  });

  if (settings.isLoading || !settings.data) return <Skeleton className="h-96" />;
  const s = settings.data;
  return (
    <>
      <PageHeader title="Inställningar" />
      <Tabs defaultValue={params.get('tab') ?? 'general'}>
        <TabsList>
          <TabsTrigger value="general">Allmänt</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="data">Datalagring</TabsTrigger>
          <TabsTrigger value="agents">Fjärragenter</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>
        <GeneralAndData s={s} onPurge={setPurge} />
        <TabsContent value="ai">
          <div className="grid gap-6 xl:grid-cols-2">
            <AiSettingsCard ai={s.ai} />
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Användning senaste 30 dagarna</CardTitle>
              </CardHeader>
              <CardContent>
                {usage.data && (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <div>
                        <div className="text-xs text-muted-foreground">Anrop</div>
                        <div className="text-lg font-semibold">{usage.data.totals.requests}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Misslyckade</div>
                        <div className="text-lg font-semibold">{usage.data.totals.failures}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Tokens</div>
                        <div className="text-lg font-semibold">{((usage.data.totals.inputTokens ?? 0) + (usage.data.totals.outputTokens ?? 0)).toLocaleString('sv-SE')}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Uppskattad kostnad</div>
                        <div className="text-lg font-semibold">${(usage.data.totals.cost ?? 0).toFixed(3)}</div>
                      </div>
                    </div>
                    <div className="mt-4 h-40">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={usage.data.daily}>
                          <XAxis dataKey="day" fontSize={10} stroke="var(--muted-foreground)" tickFormatter={(d) => d.slice(5)} />
                          <YAxis fontSize={10} stroke="var(--muted-foreground)" allowDecimals={false} />
                          <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                          <Bar dataKey="requests" name="Anrop" fill="#6366f1" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="agents">
          <AgentsTab />
        </TabsContent>
        <TabsContent value="system">
          <SystemTab />
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={!!purge}
        onOpenChange={(o) => !o && setPurge(null)}
        title="Radera data?"
        description={
          purge === 'snapshots'
            ? 'Alla lagrade kamerabilder raderas permanent.'
            : purge === 'observations'
              ? 'All observationshistorik raderas permanent. Aktuella sensorlägen behålls.'
              : 'Alla händelser och leveranshistorik raderas permanent.'
        }
        confirmLabel="Radera"
        loading={purgeMutation.isPending}
        onConfirm={() => purge && purgeMutation.mutate(purge)}
      />
    </>
  );
}

function GeneralAndData({ s, onPurge }: { s: SettingsData; onPurge: (t: 'snapshots' | 'observations' | 'events') => void }) {
  const { v, setV, save } = useGeneralForm(s);
  const set = (k: keyof typeof v, val: string) => setV({ ...v, [k]: val });
  return (
    <>
      <TabsContent value="general">
        <Card className="max-w-2xl p-6">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Field label="Namn" hint="Visas i sidhuvudet, t.ex. Hemma eller Sommarstugan.">
              <Input value={v.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Tidszon" hint="Används för tidsstämplar i notiser.">
              <Select value={v.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {['Europe/Stockholm', 'Europe/Helsinki', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/London', 'UTC'].map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </Select>
            </Field>
            <Field label="Språk">
              <Select disabled value="sv">
                <option value="sv">Svenska</option>
              </Select>
            </Field>
            <Field label="Standardintervall för analys (sekunder)">
              <Input type="number" min={15} value={v.defaultIntervalSeconds} onChange={(e) => set('defaultIntervalSeconds', e.target.value)} />
            </Field>
            <Button type="submit" loading={save.isPending}>
              Spara
            </Button>
          </form>
        </Card>
      </TabsContent>
      <TabsContent value="data">
        <div className="grid gap-6 xl:grid-cols-2">
          <Card className="p-6">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <p className="text-sm text-muted-foreground">
                Kamerabilder kan innehålla personuppgifter. Veyra lagrar enskilda bilder — aldrig video — och raderar dem automatiskt enligt
                inställningarna nedan.
              </p>
              <Field label="Spara bilder i (timmar)" hint="Senaste bilden per kamera behålls alltid.">
                <Input type="number" min={1} value={v.snapshotRetentionHours} onChange={(e) => set('snapshotRetentionHours', e.target.value)} />
              </Field>
              <Field label="Spara observationer i (dagar)">
                <Input type="number" min={1} value={v.observationRetentionDays} onChange={(e) => set('observationRetentionDays', e.target.value)} />
              </Field>
              <Field label="Spara händelser i (dagar)">
                <Input type="number" min={1} value={v.eventRetentionDays} onChange={(e) => set('eventRetentionDays', e.target.value)} />
              </Field>
              <Button type="submit" loading={save.isPending}>
                Spara
              </Button>
            </form>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Radera data</CardTitle>
              <CardDescription>Permanenta åtgärder. Kameror och sensorer påverkas inte.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" className="w-full justify-start" onClick={() => onPurge('snapshots')}>
                <Trash2 className="text-danger" /> Radera alla kamerabilder
              </Button>
              <Button variant="outline" className="w-full justify-start" onClick={() => onPurge('observations')}>
                <Trash2 className="text-danger" /> Radera observationshistorik
              </Button>
              <Button variant="outline" className="w-full justify-start" onClick={() => onPurge('events')}>
                <Trash2 className="text-danger" /> Radera händelser och leveranser
              </Button>
              <p className="pt-2 text-xs text-muted-foreground">
                <RefreshCw className="mr-1 inline size-3" />
                Automatisk rensning körs varje timme.
              </p>
            </CardContent>
          </Card>
        </div>
      </TabsContent>
    </>
  );
}
