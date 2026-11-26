import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Globe, Hash, Mail, MessageSquare, MessagesSquare, Pencil, Plus, Send, Smartphone, Trash2, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { integrationMeta, integrationTypes, type DeliveryMode, type IntegrationType } from '@veyra/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog, ErrorState, PageHeader, Skeleton } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useIntegrations } from '@/hooks/queries';
import { api } from '@/lib/api';
import { DeliveryBadge } from '@/lib/labels';
import type { Delivery, IntegrationConnection } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';

const icons: Record<IntegrationType, React.ElementType> = {
  ntfy: BellRing,
  email: Mail,
  sms: Smartphone,
  webhook: Webhook,
  slack: Hash,
  teams: MessagesSquare,
  discord: MessageSquare,
  http: Globe,
};

interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'switch' | 'headers';
  placeholder?: string;
  hint?: string;
  secret?: boolean;
}

const fieldDefs: Record<IntegrationType, FieldDef[]> = {
  ntfy: [
    { key: 'topic', label: 'Ämne', hint: 'Fungerar som ett lösenord på ntfy.sh – alla som vet namnet kan läsa notiserna. Behåll det slumpade namnet.' },
    { key: 'serverUrl', label: 'Server', placeholder: 'https://ntfy.sh', hint: 'Byt bara om du kör en egen ntfy-server.' },
    { key: 'accessToken', label: 'Åtkomsttoken (valfritt)', type: 'password', secret: true, hint: 'Bara för egna servrar med inloggning.' },
  ],
  email: [
    { key: 'host', label: 'SMTP-server', placeholder: 'smtp.sendgrid.net' },
    { key: 'port', label: 'Port', type: 'number', placeholder: '587' },
    { key: 'secure', label: 'TLS direkt (port 465)', type: 'switch' },
    { key: 'user', label: 'Användarnamn' },
    { key: 'password', label: 'Lösenord', type: 'password', secret: true },
    { key: 'from', label: 'Avsändare', placeholder: 'Veyra <noreply@foretag.se>' },
  ],
  sms: [
    { key: 'accountSid', label: 'Twilio Account SID', placeholder: 'AC…' },
    { key: 'authToken', label: 'Auth Token', type: 'password', secret: true },
    { key: 'from', label: 'Avsändare', placeholder: '+46… eller alfanumeriskt namn', hint: 'Twilio-nummer i E.164 eller godkänt alfanumeriskt avsändar-ID.' },
  ],
  webhook: [
    { key: 'url', label: 'URL', placeholder: 'https://example.com/hooks/veyra', hint: 'Endast https. Interna adresser blockeras.' },
    { key: 'signingSecret', label: 'Signeringsnyckel', type: 'password', secret: true, hint: 'Signerar body med HMAC-SHA256 (X-Veyra-Signature).' },
    { key: 'headers', label: 'Extra headers', type: 'headers', secret: true },
  ],
  slack: [{ key: 'webhookUrl', label: 'Incoming webhook-URL', type: 'password', secret: true, placeholder: 'https://hooks.slack.com/services/…' }],
  teams: [
    {
      key: 'webhookUrl',
      label: 'Workflows-webhook-URL',
      type: 'password',
      secret: true,
      hint: 'Skapa i Teams: Arbetsflöden → "Post to a channel when a webhook request is received". (Gamla Office 365-connectors stöds inte.)',
    },
  ],
  discord: [{ key: 'webhookUrl', label: 'Webhook-URL', type: 'password', secret: true, placeholder: 'https://discord.com/api/webhooks/…' }],
  http: [
    { key: 'baseUrl', label: 'Bas-URL', placeholder: 'https://api.example.com' },
    { key: 'authHeaderName', label: 'Autentiseringsheader', placeholder: 'Authorization' },
    { key: 'authHeaderValue', label: 'Headervärde', type: 'password', secret: true, placeholder: 'Bearer …' },
    { key: 'headers', label: 'Extra headers', type: 'headers', secret: true },
  ],
};

function parseHeaders(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function IntegrationDialog({
  open,
  onOpenChange,
  type,
  connection,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  type: IntegrationType;
  connection?: IntegrationConnection | null;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<DeliveryMode>('live');
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!open) return;
    setName(connection?.name ?? integrationMeta[type].label);
    setMode(connection?.mode ?? 'live');
    setValues(
      connection
        ? { ...connection.config }
        : type === 'email'
          ? { port: 587, secure: false }
          : type === 'ntfy'
            ? { serverUrl: 'https://ntfy.sh', topic: `veyra-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}` }
            : {},
    );
  }, [open, connection, type]);

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = {};
      for (const f of fieldDefs[type]) {
        const v = values[f.key];
        if (f.type === 'headers') {
          if (typeof v === 'string' && v.trim()) config[f.key] = parseHeaders(v);
        } else if (f.type === 'number') {
          if (v !== undefined && v !== '') config[f.key] = Number(v);
        } else if (f.type === 'switch') {
          config[f.key] = !!v;
        } else if (v !== undefined && v !== '') {
          config[f.key] = v;
        }
      }
      return connection
        ? api(`/integrations/${connection.id}`, { method: 'PATCH', body: { name, mode, config } })
        : api('/integrations', { body: { type, name, mode, config } });
    },
    onSuccess: () => {
      toast.success('Integrationen sparades');
      qc.invalidateQueries({ queryKey: ['integrations'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{connection ? `Redigera ${integrationMeta[type].label}` : `Anslut ${integrationMeta[type].label}`}</DialogTitle>
          <DialogDescription>Uppgifterna lagras krypterade och visas aldrig igen. Lämna hemliga fält tomma för att behålla sparade värden.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Namn">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          {fieldDefs[type].map((f) =>
            f.type === 'switch' ? (
              <label key={f.key} className="flex items-center justify-between text-sm">
                {f.label}
                <Switch checked={!!values[f.key]} onCheckedChange={(c) => setValues({ ...values, [f.key]: c })} />
              </label>
            ) : f.type === 'headers' ? (
              <Field key={f.key} label={f.label} hint={connection?.secretsSet.includes(f.key) ? 'Sparade headers behålls om fältet lämnas tomt.' : 'En per rad: Namn: värde'}>
                <Textarea rows={2} className="font-mono text-xs" value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder="X-Api-Key: …" />
              </Field>
            ) : (
              <Field
                key={f.key}
                label={f.label}
                hint={f.secret && connection?.secretsSet.includes(f.key) ? 'Sparat — lämna tomt för att behålla.' : f.hint}
              >
                <Input
                  type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={f.secret ? String(values[f.key] ?? '') : String(values[f.key] ?? '')}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              </Field>
            ),
          )}
          {type === 'ntfy' && <NtfyHelp topic={String(values.topic ?? '')} server={String(values.serverUrl ?? 'https://ntfy.sh')} />}
          <Field label="Läge" hint="Simulerat läge registrerar leveranser utan att skicka något — bra för test.">
            <Select value={mode} onChange={(e) => setMode(e.target.value as DeliveryMode)}>
              <option value="live">Skarpt — skicka på riktigt</option>
              <option value="simulated">Simulerat — skicka inte</option>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Avbryt
            </Button>
            <Button type="submit" loading={save.isPending}>
              Spara
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NtfyHelp({ topic, server }: { topic: string; server: string }) {
  const custom = server.replace(/\/+$/, '') !== 'https://ntfy.sh';
  return (
    <div className="space-y-1.5 rounded-lg bg-primary-soft/60 p-3 text-xs">
      <div className="font-medium">Så får du notiserna i mobilen</div>
      <ol className="list-decimal space-y-1 pl-4">
        <li>Installera appen <b>ntfy</b> (App Store / Google Play).</li>
        <li>
          Tryck <b>+</b> och prenumerera på ämnet <code className="rounded bg-card px-1">{topic || '…'}</code>
          {custom && (
            <>
              {' '}
              med servern <code className="rounded bg-card px-1">{server}</code>
            </>
          )}
          .
        </li>
        <li>Spara här och tryck <b>Skicka test</b>.</li>
      </ol>
    </div>
  );
}

function TestDialog({ connection, onClose }: { connection: IntegrationConnection | null; onClose: () => void }) {
  const [to, setTo] = useState('');
  const qc = useQueryClient();
  const needsTo = connection?.type === 'email' || connection?.type === 'sms';
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; simulated: boolean; error?: string; destination: string; responseCode?: number }>(`/integrations/${connection!.id}/test`, {
        body: { action: needsTo ? { to: to.split(',').map((x) => x.trim()).filter(Boolean) } : {} },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['deliveries'] });
      if (r.ok) toast.success(r.simulated ? 'Simulerad leverans registrerad (inget skickades)' : `Testet skickades till ${r.destination}`);
      else toast.error(`Testet misslyckades: ${r.error}`);
      if (r.ok) onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  useEffect(() => setTo(''), [connection]);
  return (
    <Dialog open={!!connection} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Skicka test · {connection?.name}</DialogTitle>
          <DialogDescription>Testleveranser markeras som test i leveranshistoriken.</DialogDescription>
        </DialogHeader>
        {needsTo && (
          <Field label={connection?.type === 'sms' ? 'Telefonnummer (E.164)' : 'E-postadress'}>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={connection?.type === 'sms' ? '+46701234567' : 'du@foretag.se'} />
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Avbryt
          </Button>
          <Button loading={test.isPending} disabled={needsTo && !to} onClick={() => test.mutate()}>
            <Send /> Skicka test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function IntegrationsPage() {
  const qc = useQueryClient();
  const integrations = useIntegrations();
  const deliveries = useQuery({ queryKey: ['deliveries'], queryFn: () => api<{ data: Delivery[] }>('/deliveries?limit=30'), refetchInterval: 10_000 });
  const [dialog, setDialog] = useState<{ open: boolean; type: IntegrationType; connection?: IntegrationConnection | null }>({ open: false, type: 'email' });
  const [testing, setTesting] = useState<IntegrationConnection | null>(null);
  const [confirm, setConfirm] = useState<IntegrationConnection | null>(null);
  const remove = useMutation({
    mutationFn: (c: IntegrationConnection) => api(`/integrations/${c.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (e) => {
      setConfirm(null);
      toast.error(e.message);
    },
  });
  const list = integrations.data?.data ?? [];

  return (
    <>
      <PageHeader title="Integrationer" description="Återanvändbara anslutningar som automatiseringar skickar notiser via." />
      {integrations.data?.notificationsMode === 'simulate' && (
        <div className="mb-4 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 text-sm text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200">
          Servern körs med NOTIFICATIONS_MODE=simulate — inga notiser skickas, alla leveranser registreras som simulerade.
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {integrationTypes.map((t) => {
          const Icon = icons[t];
          const count = list.filter((c) => c.type === t).length;
          return (
            <Card key={t} className="flex flex-col p-4">
              <Icon className="size-5 text-primary" />
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm font-medium">
                {integrationMeta[t].label}
                {t === 'ntfy' && <Badge>Enklast</Badge>}
                {integrationMeta[t].experimental && (
                  <Badge variant="warning" title="Byggd enligt tjänstens dokumentation men inte testad mot ett riktigt konto än. Använd Skicka test.">
                    Experimentell
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">{integrationMeta[t].description}</div>
              <div className="mt-3 flex flex-1 items-end justify-between">
                {count ? <Badge variant="success">{count} ansluten</Badge> : <Badge variant="neutral">Ej konfigurerad</Badge>}
                <Button size="icon-sm" variant="ghost" onClick={() => setDialog({ open: true, type: t, connection: null })} aria-label={`Lägg till ${integrationMeta[t].label}`}>
                  <Plus />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold">Anslutningar</h2>
      {integrations.isLoading ? (
        <Skeleton className="h-32" />
      ) : integrations.isError ? (
        <ErrorState error={integrations.error} onRetry={() => integrations.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Inga anslutningar ännu. Klicka + på en integration ovan.</p>
      ) : (
        <Card className="divide-y divide-border">
          {list.map((c) => {
            const Icon = icons[c.type];
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Icon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {c.name}
                    {c.mode === 'simulated' && <Badge variant="demo">Simulerad</Badge>}
                    {!c.enabled && <Badge variant="neutral">Inaktiv</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {integrationMeta[c.type].label}
                    {typeof c.config.topic === 'string' && ` · ämne: ${c.config.topic}`}
                    {typeof c.config.host === 'string' && ` · ${c.config.host}`}
                    {typeof c.config.url === 'string' && ` · ${new URL(c.config.url).host}`}
                    {typeof c.config.baseUrl === 'string' && ` · ${c.config.baseUrl}`}
                    {typeof c.config.from === 'string' && ` · från ${c.config.from}`}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => setTesting(c)}>
                  <Send /> Skicka test
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setDialog({ open: true, type: c.type, connection: c })} aria-label="Redigera">
                  <Pencil />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(c)} aria-label="Ta bort">
                  <Trash2 className="text-danger" />
                </Button>
              </div>
            );
          })}
        </Card>
      )}

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-sm">Leveranshistorik</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-y border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Tid</th>
                <th className="px-4 py-2 font-medium">Integration</th>
                <th className="px-4 py-2 font-medium">Mottagare</th>
                <th className="px-4 py-2 font-medium">Regel</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Försök</th>
                <th className="px-4 py-2 font-medium">Svar / fel</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.data?.data.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 text-xs">{formatDateTime(d.createdAt)}</td>
                  <td className="px-4 py-2">{d.connectionName ?? integrationMeta[d.integrationType].label}</td>
                  <td className="max-w-48 truncate px-4 py-2 text-xs text-muted-foreground">{d.destination ?? '–'}</td>
                  <td className="px-4 py-2 text-xs">{d.isTest && !d.ruleName ? 'Test' : (d.ruleName ?? '–')}</td>
                  <td className="px-4 py-2">
                    <DeliveryBadge status={d.status} simulated={d.simulated} isTest={d.isTest} />
                  </td>
                  <td className="px-4 py-2 text-xs">{d.attempts}</td>
                  <td className="max-w-72 truncate px-4 py-2 text-xs" title={d.errorMessage ?? ''}>
                    {d.errorMessage ? <span className="text-danger">{d.errorMessage}</span> : (d.responseCode ?? '–')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {deliveries.data?.data.length === 0 && <p className="p-4 text-sm text-muted-foreground">Inga leveranser ännu.</p>}
        </CardContent>
      </Card>

      <IntegrationDialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} type={dialog.type} connection={dialog.connection} />
      <TestDialog connection={testing} onClose={() => setTesting(null)} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Ta bort integration?"
        description={`"${confirm?.name}" tas bort. Integrationer som används av en automatisering kan inte tas bort.`}
        loading={remove.isPending}
        onConfirm={() => confirm && remove.mutate(confirm)}
      />
    </>
  );
}

