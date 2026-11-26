import { useQuery } from '@tanstack/react-query';
import { Bell, Camera, CameraOff, CheckCircle2, Circle, CircleHelp, Plus, Radar, ScanEye, Workflow, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EventRow } from '@/components/EventList';
import { Snapshot } from '@/components/Snapshot';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/feedback';
import { useCameras, useEvents, useInstance } from '@/hooks/queries';
import { api } from '@/lib/api';
import { CameraStatusBadge } from '@/lib/labels';
import { cn, timeAgo } from '@/lib/utils';

interface DashboardStats {
  cameras: { total: number; online: number; offline: number };
  sensors: { active: number; unknown: number };
  events: { last24h: number };
  analyses: { total: number; failures: number };
  deliveries: { failed24h: number };
  automationsTriggered24h: number;
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: number | undefined; icon: React.ElementType; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={cn('size-4 text-muted-foreground', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning', tone === 'success' && 'text-success')} />
      </div>
      {value === undefined ? <Skeleton className="mt-2 h-7 w-12" /> : <div className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString('sv-SE')}</div>}
    </Card>
  );
}

export function DashboardPage() {
  const stats = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardStats>('/dashboard'), refetchInterval: 15_000 });
  const cameras = useCameras();
  const events = useEvents({ limit: '8' });
  const instance = useInstance();
  const s = stats.data;
  const steps = [
    { done: !!instance.data?.aiConfigured, label: 'Lägg in din OpenAI-nyckel', hint: 'Utan nyckel blir analyserna simulerade.', to: '/settings?tab=ai' },
    { done: (s?.cameras.total ?? 0) > 0, label: 'Lägg till en kamera', hint: 'RTSP-adress, användarnamn och lösenord.', to: '/cameras/new' },
    { done: (s?.sensors.active ?? 0) > 0, label: 'Rita en zon och skapa en sensor', hint: 'Beskriv med vanliga ord vad som ska övervakas.', to: '/cameras' },
  ];
  const showGettingStarted = !!s && instance.data && steps.some((x) => !x.done);

  return (
    <>
      <PageHeader
        title="Översikt"
        description="Status för kameror, sensorer och automatiseringar."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/automations?new=1">
                <Workflow /> Skapa automatisering
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/sensors?new=1">
                <Radar /> Skapa sensor
              </Link>
            </Button>
            <Button asChild>
              <Link to="/cameras/new">
                <Plus /> Lägg till kamera
              </Link>
            </Button>
          </>
        }
      />

      {showGettingStarted && (
        <Card className="mb-6 p-5">
          <div className="mb-3 font-semibold">Kom igång</div>
          <ol className="space-y-2">
            {steps.map((step, i) => (
              <li key={i}>
                <Link to={step.to} className="flex items-start gap-3 rounded-lg p-2 hover:bg-muted">
                  {step.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
                  <span>
                    <span className={step.done ? 'text-muted-foreground line-through' : 'font-medium'}>{step.label}</span>
                    {!step.done && <span className="block text-xs text-muted-foreground">{step.hint}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Anslutna kameror" value={s?.cameras.online} icon={Camera} tone="success" />
          <Stat label="Offline-kameror" value={s?.cameras.offline} icon={CameraOff} tone={s?.cameras.offline ? 'danger' : undefined} />
          <Stat label="Aktiva sensorer" value={s?.sensors.active} icon={Radar} />
          <Stat label="Sensorer utan bekräftat läge" value={s?.sensors.unknown} icon={CircleHelp} tone={s?.sensors.unknown ? 'warning' : undefined} />
          <Stat label="Utlösta automatiseringar (24 h)" value={s?.automationsTriggered24h} icon={Workflow} />
          <Stat label="Händelser (24 h)" value={s?.events.last24h} icon={Bell} />
          <Stat label="Analyser totalt" value={s?.analyses.total} icon={ScanEye} />
          <Stat label="Misslyckade analyser" value={s?.analyses.failures} icon={XCircle} tone={s?.analyses.failures ? 'warning' : undefined} />
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_420px]">
        <section>
          <h2 className="mb-3 text-sm font-semibold">Kameror</h2>
          {cameras.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="aspect-[4/3]" />
              ))}
            </div>
          ) : cameras.isError ? (
            <ErrorState error={cameras.error} onRetry={() => cameras.refetch()} />
          ) : cameras.data?.length === 0 ? (
            <EmptyState
              icon={Camera}
              title="Inga kameror ännu"
              description="Anslut en IP-kamera via den lokala agenten, eller börja med en demokamera."
              action={
                <Button asChild>
                  <Link to="/cameras/new">
                    <Plus /> Lägg till kamera
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {cameras.data?.map((c) => (
                <Link key={c.id} to={`/cameras/${c.id}`} className="group">
                  <Card className="overflow-hidden transition-shadow group-hover:shadow-md">
                    <Snapshot frameId={c.latestFrame?.id} demo={c.connectionType === 'demo'} />
                    <div className="space-y-2 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{c.name}</span>
                        <CameraStatusBadge status={c.status} />
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{c.zoneCount} zoner</span>
                        <span>{c.sensorCount} sensorer</span>
                        <span>Bild {timeAgo(c.lastFrameAt)}</span>
                        <span>Analys {timeAgo(c.lastAnalysisAt)}</span>
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Senaste händelser</CardTitle>
              <Button variant="link" size="sm" asChild>
                <Link to="/events">Visa alla</Link>
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {events.isLoading ? (
                <div className="space-y-2 p-4">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : events.data?.data.length === 0 ? (
                <p className="px-4 pb-6 pt-2 text-sm text-muted-foreground">Inga händelser ännu. Händelser skapas när en sensor bekräftar en statusändring.</p>
              ) : (
                events.data?.data.map((e) => <EventRow key={e.id} event={e} compact />)
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </>
  );
}
