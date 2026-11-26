import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Code2,
  MoreHorizontal,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Power,
  Radar,
  ScanEye,
  Square,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { RectangleGeometry } from '@veyra/shared';
import { CameraForm } from '@/components/CameraForm';
import { EventRow } from '@/components/EventList';
import { SensorDialog } from '@/components/SensorDialog';
import { Snapshot } from '@/components/Snapshot';
import { ZoneEditor, type ZoneOverlayState } from '@/components/ZoneEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { ConfirmDialog, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { qk, useCamera, useEvents } from '@/hooks/queries';
import { api, frameUrl } from '@/lib/api';
import { CameraStatusBadge, connectionTypeLabels, observationStatusMeta, StateStatusBadge, stateTone } from '@/lib/labels';
import { useCrumb } from '@/lib/store';
import type { CameraDetail, FrameMeta, Observation, Sensor, Zone } from '@/lib/types';
import { cn, formatDateTime, formatInterval, timeAgo } from '@/lib/utils';

const ZONE_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#22c55e', '#ec4899', '#3b82f6', '#ef4444', '#14b8a6'];

type TestResult = { ok: true; durationMs: number; frame: FrameMeta } | { ok: false; durationMs: number; error: string; code: string };

function zoneStates(sensors: Sensor[]): Record<string, ZoneOverlayState> {
  const out: Record<string, ZoneOverlayState> = {};
  for (const s of sensors) {
    if (!s.zoneId || out[s.zoneId]) continue;
    const st = s.state;
    const label = st.status === 'confirmed' ? st.valueLabel : st.status === 'unknown' ? 'Okänd' : `${st.valueLabel} (${st.status === 'stale' ? 'inaktuell' : st.status === 'uncertain' ? 'osäker' : 'otillgänglig'})`;
    out[s.zoneId] = { label, tone: stateTone(st.status) };
  }
  return out;
}

function SensorStateCard({ sensor }: { sensor: Sensor }) {
  const tone = stateTone(sensor.state.status);
  return (
    <Link to={`/sensors/${sensor.id}`} className="block rounded-lg border border-border p-3 transition-colors hover:bg-muted/50">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {sensor.zone && <span className="size-2.5 shrink-0 rounded-sm" style={{ background: sensor.zone.color }} />}
          <span className="truncate">{sensor.name}</span>
        </span>
        <StateStatusBadge status={sensor.state.status} />
      </div>
      <div
        className={cn(
          'mt-1 text-xl font-semibold',
          tone === 'warn' && 'text-warning',
          tone === 'bad' && 'text-danger',
          tone === 'none' && 'text-muted-foreground',
        )}
      >
        {sensor.state.valueLabel}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {sensor.zone?.name ?? 'Hela bilden'} · senast {timeAgo(sensor.state.lastObservationAt)}
        {sensor.state.pendingCount > 0 && sensor.state.pendingValue !== null && ` · väntar på bekräftelse (${sensor.state.pendingCount}/${sensor.stabilization.requiredConsecutive})`}
        {!sensor.enabled && ' · pausad'}
      </div>
    </Link>
  );
}

export function CameraDetailPage() {
  const { cameraId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const camera = useCamera(cameraId);
  const cam = camera.data;
  useCrumb(cameraId, cam?.name);

  const [tab, setTab] = useState(params.get('tab') ?? 'overview');
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [sensorDialog, setSensorDialog] = useState<{ open: boolean; sensor?: Sensor | null; zoneId?: string | null }>({ open: false });
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<null | 'camera' | 'zone'>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setCamera = (fn: (c: CameraDetail) => CameraDetail) => qc.setQueryData<CameraDetail>(qk.camera(cameraId), (c) => (c ? fn(c) : c));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.camera(cameraId) });
    qc.invalidateQueries({ queryKey: ['events'] });
  };

  const testConnection = useMutation({
    mutationFn: () => api<TestResult>(`/cameras/${cameraId}/test`, { method: 'POST' }),
    onSuccess: (r) => {
      setTestResult(r);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  useEffect(() => {
    if (params.get('test') === '1' && cam && !testConnection.isPending && !testResult) {
      params.delete('test');
      setParams(params, { replace: true });
      testConnection.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam?.id]);

  const analyze = useMutation({
    mutationFn: () => api<{ observations: Observation[] }>(`/cameras/${cameraId}/analyze`, { method: 'POST' }),
    onSuccess: (r) => {
      const failed = r.observations.filter((o) => o.status === 'unavailable').length;
      if (r.observations.length === 0) toast.info('Ny bild hämtad. Kameran har inga aktiva sensorer.');
      else if (failed) toast.warning(`${r.observations.length} sensorer analyserade, ${failed} utan resultat`);
      else toast.success(`${r.observations.length} sensorer analyserade`);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const upload = useMutation({
    mutationFn: (file: File) => api<{ observations: Observation[] }>(`/cameras/${cameraId}/upload`, { raw: file }),
    onSuccess: (r) => {
      toast.success(`Bilden laddades upp${r.observations.length ? ` och ${r.observations.length} sensorer analyserades` : ''}`);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleAuto = useMutation({
    mutationFn: (autoCapture: boolean) => api(`/cameras/${cameraId}`, { method: 'PATCH', body: { autoCapture } }),
    onSuccess: (_d, autoCapture) => {
      toast.success(autoCapture ? 'Automatisk analys återupptagen' : 'Automatisk analys pausad – använd "Analysera nu"');
      refresh();
      qc.invalidateQueries({ queryKey: ['cameras'] });
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => api(`/cameras/${cameraId}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e.message),
  });

  const deleteCamera = useMutation({
    mutationFn: () => api(`/cameras/${cameraId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Kameran och all tillhörande data togs bort');
      qc.invalidateQueries({ queryKey: ['cameras'] });
      navigate('/cameras');
    },
    onError: (e) => toast.error(e.message),
  });

  const createZone = useMutation({
    mutationFn: (geometry: RectangleGeometry) =>
      api<Zone>(`/cameras/${cameraId}/zones`, {
        body: { name: `Zon ${(cam?.zones.length ?? 0) + 1}`, geometry, color: ZONE_COLORS[(cam?.zones.length ?? 0) % ZONE_COLORS.length] },
      }),
    onSuccess: (z) => {
      setCamera((c) => ({ ...c, zones: [...c.zones, z] }));
      setSelectedZone(z.id);
      setDrawMode(false);
      toast.success('Zonen skapades — ge den ett namn till höger');
    },
    onError: (e) => toast.error(e.message),
  });

  const updateZone = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Zone> }) => api<Zone>(`/zones/${id}`, { method: 'PATCH', body: patch }),
    onMutate: ({ id, patch }) => setCamera((c) => ({ ...c, zones: c.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) })),
    onError: (e) => {
      toast.error(e.message);
      refresh();
    },
  });

  const deleteZone = useMutation({
    mutationFn: (id: string) => api(`/zones/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedZone(null);
      setConfirmDelete(null);
      toast.success('Zonen togs bort');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const states = useMemo(() => zoneStates(cam?.sensors ?? []), [cam?.sensors]);

  if (camera.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16" />
        <Skeleton className="aspect-video max-w-4xl" />
      </div>
    );
  }
  if (camera.isError || !cam) return <ErrorState error={camera.error} onRetry={() => camera.refetch()} />;

  const zone = cam.zones.find((z) => z.id === selectedZone) ?? null;
  const imageUrl = cam.latestFrame ? frameUrl(cam.latestFrame.id) : null;
  const imageSize = cam.latestFrame ? { width: cam.latestFrame.width, height: cam.latestFrame.height } : null;

  return (
    <>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{cam.name}</h1>
            <CameraStatusBadge status={cam.status} />
            {cam.connectionType === 'demo' && <Badge variant="demo">Demokälla — syntetiska bilder</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              {connectionTypeLabels[cam.connectionType]}
              {cam.connection.host ? ` · ${cam.connection.host}` : ''}
            </span>
            {cam.agent && (
              <span>
                Via fjärragent: {cam.agent.name} ({cam.agent.status === 'online' ? 'online' : cam.agent.status})
              </span>
            )}
            <span>Senaste bild: {cam.lastFrameAt ? `${timeAgo(cam.lastFrameAt)}` : 'ingen'}</span>
            {cam.connectionType === 'manual' ? null : cam.autoCapture ? (
              <span>Intervall: {formatInterval(cam.captureIntervalSeconds)}</span>
            ) : (
              <span className="font-medium text-warning">Automatik pausad – endast "Analysera nu"</span>
            )}
          </div>
          {cam.statusMessage && cam.status !== 'online' && (
            <p className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">{cam.statusMessage}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {cam.connectionType === 'manual' && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = '';
                }}
              />
              <Button variant="outline" loading={upload.isPending} onClick={() => fileRef.current?.click()}>
                <Upload /> Ladda upp bild
              </Button>
            </>
          )}
          {cam.connectionType !== 'manual' && (
            <Button variant="outline" loading={testConnection.isPending} onClick={() => testConnection.mutate()}>
              <Plug /> Testa anslutning
            </Button>
          )}
          <Button loading={analyze.isPending} onClick={() => analyze.mutate()} disabled={!cam.enabled && cam.connectionType !== 'manual'}>
            <ScanEye /> Analysera nu
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Fler åtgärder">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setTab('settings')}>
                <Pencil /> Redigera kamera
              </DropdownMenuItem>
              {cam.connectionType !== 'manual' && (
                <DropdownMenuItem onSelect={() => toggleAuto.mutate(!cam.autoCapture)}>
                  {cam.autoCapture ? <Pause /> : <Play />}
                  {cam.autoCapture ? 'Pausa automatisk analys' : 'Återuppta automatisk analys'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => toggleEnabled.mutate(!cam.enabled)}>
                <Power /> {cam.enabled ? 'Inaktivera kamera' : 'Aktivera kamera'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setConfirmDelete('camera')}>
                <Trash2 /> Ta bort kamera
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Översikt</TabsTrigger>
          <TabsTrigger value="zones">Zoner &amp; sensorer</TabsTrigger>
          <TabsTrigger value="events">Händelser</TabsTrigger>
          <TabsTrigger value="history">Historik</TabsTrigger>
          <TabsTrigger value="settings">Inställningar</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview">
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="space-y-2">
              <Card className="overflow-hidden p-2">
                {cam.latestFrame ? (
                  <ZoneEditor imageUrl={imageUrl} imageSize={imageSize} zones={cam.zones} states={states} selectedId={null} onSelect={() => {}} />
                ) : (
                  <NoImage cam={cam} onTest={() => testConnection.mutate()} onUpload={() => fileRef.current?.click()} />
                )}
              </Card>
              {cam.latestFrame && (
                <p className="text-xs text-muted-foreground">
                  Bild från {formatDateTime(cam.latestFrame.capturedAt)} · {cam.latestFrame.width}×{cam.latestFrame.height} ·{' '}
                  {cam.latestFrame.source === 'demo' ? 'syntetisk demobild' : cam.latestFrame.source === 'upload' ? 'uppladdad' : 'från kameran'}
                </p>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Sensorer</h2>
                <Button size="sm" variant="outline" onClick={() => setSensorDialog({ open: true })}>
                  <Plus /> Ny sensor
                </Button>
              </div>
              {cam.sensors.length === 0 ? (
                <EmptyState
                  icon={Radar}
                  title="Inga sensorer"
                  description="Rita en zon och beskriv vad som ska övervakas."
                  action={
                    <Button size="sm" onClick={() => setTab('zones')}>
                      Gå till zoner
                    </Button>
                  }
                />
              ) : (
                cam.sensors.map((s) => <SensorStateCard key={s.id} sensor={s} />)
              )}
            </div>
          </div>
          {cam.sensors.length > 0 && <ApiPreview sensors={cam.sensors} />}
        </TabsContent>

        {/* Zones & sensors */}
        <TabsContent value="zones">
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
                  <Button size="sm" variant={drawMode ? 'ghost' : 'secondary'} onClick={() => setDrawMode(false)} className="border-0">
                    <MousePointer2 /> Välj
                  </Button>
                  <Button size="sm" variant={drawMode ? 'secondary' : 'ghost'} onClick={() => setDrawMode(true)} className="border-0" disabled={!cam.latestFrame}>
                    <Square /> Rita zon
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  {drawMode ? 'Dra en rektangel över bilden.' : 'Klicka på en zon för att välja, flytta eller ändra storlek.'}
                </span>
              </div>
              <Card className="overflow-hidden p-2">
                {cam.latestFrame ? (
                  <ZoneEditor
                    imageUrl={imageUrl}
                    imageSize={imageSize}
                    zones={cam.zones}
                    states={states}
                    selectedId={selectedZone}
                    onSelect={setSelectedZone}
                    editable
                    drawMode={drawMode}
                    onCreate={(g) => createZone.mutate(g)}
                    onUpdate={(id, geometry) => updateZone.mutate({ id, patch: { geometry } })}
                  />
                ) : (
                  <NoImage cam={cam} onTest={() => testConnection.mutate()} onUpload={() => fileRef.current?.click()} />
                )}
              </Card>
              <p className="text-xs text-muted-foreground">Zoner sparas automatiskt i normaliserade koordinater och följer med om kamerans upplösning ändras.</p>
            </div>

            <div className="space-y-4">
              {zone ? (
                <ZonePanel
                  key={zone.id}
                  zone={zone}
                  sensors={cam.sensors.filter((s) => s.zoneId === zone.id)}
                  onChange={(patch) => updateZone.mutate({ id: zone.id, patch })}
                  onDelete={() => setConfirmDelete('zone')}
                  onAddSensor={() => setSensorDialog({ open: true, zoneId: zone.id })}
                  onEditSensor={(s) => setSensorDialog({ open: true, sensor: s })}
                />
              ) : (
                <Card className="p-5 text-sm text-muted-foreground">Välj en zon i bilden, eller rita en ny med <b>Rita zon</b>.</Card>
              )}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Alla zoner</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  {cam.zones.length === 0 && <p className="text-sm text-muted-foreground">Inga zoner ännu.</p>}
                  {cam.zones.map((z) => (
                    <button
                      key={z.id}
                      onClick={() => setSelectedZone(z.id)}
                      className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted', z.id === selectedZone && 'bg-muted')}
                    >
                      <span className="flex items-center gap-2">
                        <span className="size-2.5 rounded-sm" style={{ background: z.color }} />
                        {z.name}
                        {!z.enabled && <Badge variant="neutral">Inaktiv</Badge>}
                      </span>
                      <span className="text-xs text-muted-foreground">{cam.sensors.filter((s) => s.zoneId === z.id).length} sensorer</span>
                    </button>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="text-sm">Sensorer för hela bilden</CardTitle>
                  <Button size="sm" variant="ghost" onClick={() => setSensorDialog({ open: true, zoneId: null })}>
                    <Plus /> Ny
                  </Button>
                </CardHeader>
                <CardContent className="space-y-2">
                  {cam.sensors.filter((s) => !s.zoneId).length === 0 && <p className="text-sm text-muted-foreground">Inga.</p>}
                  {cam.sensors
                    .filter((s) => !s.zoneId)
                    .map((s) => (
                      <SensorStateCard key={s.id} sensor={s} />
                    ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="events">
          <CameraEvents cameraId={cam.id} />
        </TabsContent>

        <TabsContent value="history">
          <CameraHistory sensors={cam.sensors} />
        </TabsContent>

        <TabsContent value="settings">
          <Card className="max-w-4xl p-6">
            <CameraForm camera={cam} onSaved={() => refresh()} />
          </Card>
        </TabsContent>
      </Tabs>

      <SensorDialog
        open={sensorDialog.open}
        onOpenChange={(open) => setSensorDialog((s) => ({ ...s, open }))}
        cameraId={cam.id}
        zones={cam.zones}
        sensor={sensorDialog.sensor}
        defaultZoneId={sensorDialog.zoneId}
      />

      <Dialog open={!!testResult} onOpenChange={(o) => !o && setTestResult(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {testResult?.ok ? <CheckCircle2 className="size-5 text-success" /> : <XCircle className="size-5 text-danger" />}
              {testResult?.ok ? 'Anslutningen fungerar' : 'Anslutningen misslyckades'}
            </DialogTitle>
            <DialogDescription>
              {testResult?.ok
                ? `Bild mottagen på ${(testResult.durationMs / 1000).toFixed(1)} s (${testResult.frame.width}×${testResult.frame.height}).`
                : testResult?.error}
            </DialogDescription>
          </DialogHeader>
          {testResult?.ok ? (
            <Snapshot frameId={testResult.frame.id} className="rounded-lg" />
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Kontrollera IP-adress, port och sökväg (t.ex. /stream1).</li>
              <li>Kontrollera kamerans användarnamn och lösenord.</li>
              <li>Kameran måste vara nåbar från datorn där Veyra körs (samma nätverk).</li>
              {cam.agent && <li>Kontrollera att fjärragenten körs och är online under Inställningar → Fjärragenter.</li>}
            </ul>
          )}
          <DialogFooter>
            {testResult?.ok ? (
              <Button
                onClick={() => {
                  setTestResult(null);
                  setTab('zones');
                  setDrawMode(true);
                }}
              >
                Rita zoner
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setTab('settings')}>
                Ändra inställningar
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete === 'camera'}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Ta bort kamera?"
        description={`"${cam.name}" tas bort tillsammans med ${cam.zones.length} zoner, ${cam.sensors.length} sensorer, all historik, alla bilder och kopplade automatiseringar. Detta kan inte ångras.`}
        loading={deleteCamera.isPending}
        onConfirm={() => deleteCamera.mutate()}
      />
      <ConfirmDialog
        open={confirmDelete === 'zone' && !!zone}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Ta bort zon?"
        description={`Zonen "${zone?.name}" och dess ${cam.sensors.filter((s) => s.zoneId === zone?.id).length} sensorer (med historik och automatiseringar) tas bort.`}
        loading={deleteZone.isPending}
        onConfirm={() => zone && deleteZone.mutate(zone.id)}
      />
    </>
  );
}

function NoImage({ cam, onTest, onUpload }: { cam: CameraDetail; onTest: () => void; onUpload: () => void }) {
  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-3 rounded-lg bg-muted text-center">
      <p className="text-sm text-muted-foreground">Ingen bild har tagits emot ännu.</p>
      {cam.connectionType === 'manual' ? (
        <Button size="sm" onClick={onUpload}>
          <Upload /> Ladda upp bild
        </Button>
      ) : (
        <Button size="sm" onClick={onTest}>
          <Plug /> Hämta bild
        </Button>
      )}
    </div>
  );
}

function ZonePanel({
  zone,
  sensors,
  onChange,
  onDelete,
  onAddSensor,
  onEditSensor,
}: {
  zone: Zone;
  sensors: Sensor[];
  onChange: (patch: Partial<Zone>) => void;
  onDelete: () => void;
  onAddSensor: () => void;
  onEditSensor: (s: Sensor) => void;
}) {
  const [name, setName] = useState(zone.name);
  return (
    <Card className="animate-in">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-sm">Vald zon</CardTitle>
        <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label="Ta bort zon">
          <Trash2 className="text-danger" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Namn">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== zone.name && onChange({ name: name.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </Field>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Färg</span>
          <div className="flex flex-wrap gap-2">
            {ZONE_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => onChange({ color: c })}
                className={cn('size-7 rounded-md ring-offset-2 ring-offset-card', zone.color === c && 'ring-2 ring-foreground')}
                style={{ background: c }}
                aria-label={`Färg ${c}`}
              />
            ))}
          </div>
        </div>
        <label className="flex items-center justify-between">
          <span className="text-sm">Zonen är aktiv</span>
          <Switch checked={zone.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
        </label>
        <div className="text-xs text-muted-foreground">
          x {zone.geometry.x.toFixed(3)} · y {zone.geometry.y.toFixed(3)} · b {zone.geometry.width.toFixed(3)} · h {zone.geometry.height.toFixed(3)}
        </div>
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Sensorer i zonen</span>
            <Button size="sm" onClick={onAddSensor}>
              <Plus /> Lägg till sensor
            </Button>
          </div>
          {sensors.length === 0 && <p className="text-sm text-muted-foreground">Ingen sensor ännu. Beskriv vad som ska övervakas i zonen.</p>}
          {sensors.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <Link to={`/sensors/${s.id}`} className="block truncate text-sm font-medium hover:underline">
                  {s.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {s.state.valueLabel} · var {formatInterval(s.intervalSeconds)}
                </span>
              </div>
              <Button size="icon-sm" variant="ghost" onClick={() => onEditSensor(s)} aria-label="Redigera sensor">
                <Pencil />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CameraEvents({ cameraId }: { cameraId: string }) {
  const events = useEvents({ cameraId, limit: '50' });
  if (events.isLoading) return <Skeleton className="h-40" />;
  if (events.isError) return <ErrorState error={events.error} onRetry={() => events.refetch()} />;
  if (!events.data?.data.length) return <EmptyState icon={ScanEye} title="Inga händelser" description="Händelser skapas när en sensor bekräftar en ny status." />;
  return (
    <Card className="overflow-hidden">
      {events.data.data.map((e) => (
        <EventRow key={e.id} event={e} />
      ))}
    </Card>
  );
}

function CameraHistory({ sensors }: { sensors: Sensor[] }) {
  const [sensorId, setSensorId] = useState(sensors[0]?.id ?? '');
  const history = useQuery({
    queryKey: ['history', sensorId, 'camera'],
    queryFn: () => api<{ data: Observation[] }>(`/sensors/${sensorId}/history?limit=30`),
    enabled: !!sensorId,
    refetchInterval: 15_000,
  });
  if (!sensors.length) return <EmptyState icon={Radar} title="Ingen historik" description="Lägg till en sensor för att se analyshistorik." />;
  const sensor = sensors.find((s) => s.id === sensorId);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {sensors.map((s) => (
          <Button key={s.id} size="sm" variant={s.id === sensorId ? 'secondary' : 'ghost'} onClick={() => setSensorId(s.id)}>
            {s.name}
          </Button>
        ))}
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Tid</th>
              <th className="px-4 py-2 font-medium">Observerat</th>
              <th className="px-4 py-2 font-medium">Säkerhet</th>
              <th className="px-4 py-2 font-medium">Bekräftat läge</th>
              <th className="px-4 py-2 font-medium">Förklaring</th>
            </tr>
          </thead>
          <tbody>
            {history.data?.data.map((o) => (
              <tr key={o.id} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2 text-xs">{formatDateTime(o.observedAt)}</td>
                <td className="px-4 py-2 font-medium">{o.value === null ? '–' : String(o.value)}</td>
                <td className="px-4 py-2">
                  <span className="inline-flex gap-1">
                    <Badge variant={observationStatusMeta[o.status].variant}>{observationStatusMeta[o.status].label}</Badge>
                    {o.simulated && <Badge variant="demo">Sim.</Badge>}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {o.stateValue === null ? '–' : String(o.stateValue)}
                  {o.causedTransition && <Badge className="ml-1">Ändring</Badge>}
                </td>
                <td className="max-w-md truncate px-4 py-2 text-xs text-muted-foreground" title={o.reason}>
                  {o.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {history.data?.data.length === 0 && <p className="p-4 text-sm text-muted-foreground">Inga observationer ännu.</p>}
      </Card>
      {sensor && (
        <Link to={`/sensors/${sensor.id}`} className="text-sm text-primary hover:underline">
          Visa full historik och diagram för {sensor.name} →
        </Link>
      )}
    </div>
  );
}

function ApiPreview({ sensors }: { sensors: Sensor[] }) {
  const s = sensors[0]!;
  const example = {
    sensorId: s.id,
    sensorName: s.name,
    value: s.state.value,
    valueLabel: s.state.valueLabel,
    status: s.state.status,
    confirmedAt: s.state.confirmedAt,
    lastObservationAt: s.state.lastObservationAt,
  };
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Code2 className="size-4" /> API-förhandsvisning
        </CardTitle>
        <CardDescription>
          Läs aktuellt läge från andra system: <code className="rounded bg-muted px-1">GET /api/v1/sensors/{'{id}'}/state</code>{' '}
          <Link to="/api" className="text-primary hover:underline">
            Fler exempel
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
          {`curl ${window.location.origin}/api/v1/sensors/${s.id}/state\n\n`}
          {JSON.stringify(example, null, 2)}
        </pre>
      </CardContent>
    </Card>
  );
}
