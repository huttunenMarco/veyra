import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, Globe, Info, Network, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { ConnectionType } from '@veyra/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAgents } from '@/hooks/queries';
import { api, ApiError } from '@/lib/api';
import type { Camera } from '@/lib/types';
import { cn } from '@/lib/utils';

const types: Array<{ type: ConnectionType; label: string; desc: string; icon: React.ElementType }> = [
  { type: 'rtsp', label: 'IP-kamera (RTSP)', desc: 'Rekommenderat. Fungerar med de flesta IP-kameror.', icon: Network },
  { type: 'http_snapshot', label: 'HTTP-snapshot', desc: 'Kameran exponerar en JPEG-URL.', icon: Globe },
  { type: 'manual', label: 'Manuell bild', desc: 'Ladda upp bilder för test utan kamera.', icon: Upload },
  { type: 'demo', label: 'Demokamera', desc: 'Syntetiska bilder som ändras över tid.', icon: Clapperboard },
];

interface Values {
  name: string;
  description: string;
  location: string;
  connectionType: ConnectionType;
  rtspUrl: string;
  httpUrl: string;
  username: string;
  password: string;
  rtspTransport: 'tcp' | 'udp';
  demoScene: 'warehouse' | 'garage' | 'production';
  agentId: string;
  captureIntervalSeconds: number;
  autoCapture: boolean;
  enabled: boolean;
}

export function CameraForm({ camera, onSaved }: { camera?: Camera; onSaved: (c: Camera) => void }) {
  const qc = useQueryClient();
  const agents = useAgents();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [v, setV] = useState<Values>({
    name: camera?.name ?? '',
    description: camera?.description ?? '',
    location: camera?.location ?? '',
    connectionType: camera?.connectionType ?? 'rtsp',
    // When editing, URLs start empty: the stored URL is only shown masked and kept unless replaced.
    rtspUrl: '',
    httpUrl: '',
    username: '',
    password: '',
    rtspTransport: camera?.connection.rtspTransport ?? 'tcp',
    demoScene: (camera?.connection.demoScene as Values['demoScene']) ?? 'warehouse',
    agentId: camera?.agentId ?? '',
    captureIntervalSeconds: camera?.captureIntervalSeconds ?? 60,
    autoCapture: camera?.autoCapture ?? true,
    enabled: camera?.enabled ?? true,
  });
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((s) => ({ ...s, [k]: val }));
  const needsAgent = v.connectionType === 'rtsp' || v.connectionType === 'http_snapshot';
  const activeAgents = (agents.data ?? []).filter((a) => a.status !== 'revoked');
  const [remote, setRemote] = useState(!!camera?.agentId);

  const save = useMutation({
    mutationFn: () => {
      const connection: Record<string, unknown> = { rtspTransport: v.rtspTransport };
      if (v.connectionType === 'rtsp' && (v.rtspUrl || !camera)) connection.rtspUrl = v.rtspUrl;
      if (v.connectionType === 'http_snapshot' && (v.httpUrl || !camera)) connection.httpUrl = v.httpUrl;
      if (v.username) connection.username = v.username;
      if (v.password) connection.password = v.password;
      if (v.connectionType === 'demo') connection.demoScene = v.demoScene;
      const base = {
        name: v.name,
        description: v.description,
        location: v.location,
        agentId: needsAgent && remote ? v.agentId || null : null,
        captureIntervalSeconds: Number(v.captureIntervalSeconds),
        autoCapture: v.autoCapture,
        enabled: v.enabled,
        connection,
      };
      return camera
        ? api<Camera>(`/cameras/${camera.id}`, { method: 'PATCH', body: base })
        : api<Camera>('/cameras', { body: { ...base, connectionType: v.connectionType } });
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['cameras'] });
      toast.success(camera ? 'Kameran sparades' : 'Kameran skapades');
      onSaved(c);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.details) {
        setErrors(Object.fromEntries(e.details.map((d) => [d.path, d.message])));
      }
      toast.error(e.message);
    },
  });

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      {!camera && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {types.map(({ type, label, desc, icon: Icon }) => (
            <button
              type="button"
              key={type}
              onClick={() => set('connectionType', type)}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                v.connectionType === type ? 'border-primary bg-primary-soft ring-1 ring-primary' : 'border-border bg-card hover:bg-muted',
              )}
            >
              <Icon className="mb-2 size-5 text-primary" />
              <div className="text-sm font-medium">{label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kameranamn" error={errors.name}>
          <Input required value={v.name} onChange={(e) => set('name', e.target.value)} placeholder="t.ex. Lagerkamera 1" />
        </Field>
        <Field label="Plats">
          <Input value={v.location} onChange={(e) => set('location', e.target.value)} placeholder="t.ex. Lager A, kajsidan" />
        </Field>
        <Field label="Beskrivning" className="sm:col-span-2">
          <Textarea rows={2} value={v.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
      </div>

      {v.connectionType === 'rtsp' && (
        <div className="space-y-4 rounded-xl border border-border p-4">
          <div className="flex gap-2 rounded-lg bg-primary-soft/60 p-3 text-xs">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
              <b>TP-Link Tapo C210:</b> aktivera "Kamerakonto" i Tapo-appen (Avancerade inställningar). Adress:{' '}
              <code>rtsp://&lt;kamerans-ip&gt;:554/stream1</code> (hög upplösning) eller <code>/stream2</code> (låg). Använd kamerakontots
              användarnamn och lösenord — inte ditt TP-Link-konto.
            </div>
          </div>
          <Field
            label="RTSP-adress"
            error={errors['connection.rtspUrl']}
            hint={
              camera?.connection.url
                ? `Nuvarande: ${camera.connection.url} — lämna tomt för att behålla.`
                : 'Finns ofta i kamerans manual eller app. Vanliga format: /stream1, /Streaming/Channels/101, /h264.'
            }
          >
            <Input value={v.rtspUrl} onChange={(e) => set('rtspUrl', e.target.value)} placeholder={camera?.connection.url ?? 'rtsp://192.168.1.50:554/stream1'} />
          </Field>
          <CredentialFields v={v} set={set} camera={camera} />
          <Field label="RTSP-transport" hint="TCP är stabilast genom de flesta nätverk.">
            <Select value={v.rtspTransport} onChange={(e) => set('rtspTransport', e.target.value as 'tcp' | 'udp')}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </Select>
          </Field>
        </div>
      )}

      {v.connectionType === 'http_snapshot' && (
        <div className="space-y-4 rounded-xl border border-border p-4">
          <Field label="Snapshot-URL" error={errors['connection.httpUrl']} hint={camera?.connection.url ? `Nuvarande: ${camera.connection.url} — lämna tomt för att behålla.` : 'En adress som ger en JPEG-bild, t.ex. från kamerans webbgränssnitt.'}>
            <Input value={v.httpUrl} onChange={(e) => set('httpUrl', e.target.value)} placeholder={camera?.connection.url ?? 'http://192.168.1.60/cgi-bin/snapshot.cgi'} />
          </Field>
          <CredentialFields v={v} set={set} camera={camera} />
        </div>
      )}

      {needsAgent && (
        <div className="space-y-3 rounded-xl border border-dashed border-border p-4">
          <label className="flex items-start justify-between gap-4">
            <span className="text-sm">
              Kameran finns på ett annat nätverk
              <span className="block text-xs text-muted-foreground">
                Avancerat. Normalt hämtar Veyra bilden direkt. Välj detta bara om kameran inte nås från servern (t.ex. i sommarstugan) – då
                hämtas bilden av en fjärragent på kamerans nätverk.
              </span>
            </span>
            <Switch checked={remote} onCheckedChange={setRemote} />
          </label>
          {remote && (
            <Field
              label="Fjärragent"
              error={errors.agentId}
              hint={
                <Link to="/settings?tab=agents" className="text-primary hover:underline">
                  Skapa eller hantera fjärragenter
                </Link>
              }
            >
              <Select value={v.agentId} onChange={(e) => set('agentId', e.target.value)}>
                <option value="">Välj agent…</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.status === 'online' ? 'online' : a.status === 'pending' ? 'ej registrerad' : 'offline'})
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}

      {v.connectionType === 'demo' && !camera && (
        <Field label="Demoscen" hint="Demokameror är tydligt märkta och använder syntetiska bilder.">
          <Select value={v.demoScene} onChange={(e) => set('demoScene', e.target.value as Values['demoScene'])}>
            <option value="warehouse">Lager med två lastkajer</option>
            <option value="garage">Garageport</option>
            <option value="production">Pallar i produktion</option>
          </Select>
        </Field>
      )}

      {v.connectionType !== 'manual' && (
        <label className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
          <span className="text-sm">
            Automatisk bildtagning och analys
            <span className="block text-xs text-muted-foreground">
              {v.autoCapture
                ? 'Veyra hämtar bilder och kör AI-analys enligt intervallen.'
                : 'Pausat: bilder hämtas och analyseras bara när du trycker "Analysera nu". Inga AI-kostnader i bakgrunden.'}
            </span>
          </span>
          <Switch checked={v.autoCapture} onCheckedChange={(c) => set('autoCapture', c)} />
        </label>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bildintervall" hint="Hur ofta en ny bild hämtas för status och förhandsvisning. Sensorer har egna analysintervall.">
          <Select
            value={v.captureIntervalSeconds}
            disabled={!v.autoCapture || v.connectionType === 'manual'}
            onChange={(e) => set('captureIntervalSeconds', Number(e.target.value))}
          >
            <option value={30}>30 sekunder</option>
            <option value={60}>1 minut</option>
            <option value={300}>5 minuter</option>
            <option value={900}>15 minuter</option>
            <option value={3600}>1 timme</option>
          </Select>
        </Field>
        <label className="flex items-center justify-between rounded-lg border border-border px-3 py-2 sm:mt-6">
          <span className="text-sm">Kameran är aktiverad</span>
          <Switch checked={v.enabled} onCheckedChange={(c) => set('enabled', c)} />
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={save.isPending}>
          {camera ? 'Spara ändringar' : needsAgent ? 'Spara och testa anslutning' : 'Skapa kamera'}
        </Button>
      </div>
    </form>
  );
}

function CredentialFields({ v, set, camera }: { v: Values; set: <K extends keyof Values>(k: K, val: Values[K]) => void; camera?: Camera }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Användarnamn" hint={camera?.connection.hasUsername ? 'Sparat — lämna tomt för att behålla.' : undefined}>
        <Input autoComplete="off" value={v.username} onChange={(e) => set('username', e.target.value)} />
      </Field>
      <Field label="Lösenord" hint={camera?.connection.hasPassword ? 'Sparat krypterat — lämna tomt för att behålla.' : 'Lagras krypterat och visas aldrig igen.'}>
        <Input type="password" autoComplete="new-password" value={v.password} onChange={(e) => set('password', e.target.value)} />
      </Field>
    </div>
  );
}
