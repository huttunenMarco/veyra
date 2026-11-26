import { Plus, Radar } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SensorDialog } from '@/components/SensorDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/feedback';
import { Field, Select } from '@/components/ui/input';
import { useCamera, useCameras, useSensors } from '@/hooks/queries';
import { StateStatusBadge, stateTone } from '@/lib/labels';
import { cn, formatInterval, timeAgo } from '@/lib/utils';

export function SensorsPage() {
  const sensors = useSensors();
  const cameras = useCameras();
  const [params, setParams] = useSearchParams();
  const [pickCamera, setPickCamera] = useState(params.get('new') === '1');
  const [cameraId, setCameraId] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const camera = useCamera(cameraId);

  const startNew = () => {
    setPickCamera(true);
    if (params.has('new')) setParams({}, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Sensorer"
        description="AI-sensorer definierade med naturligt språk. Status bekräftas av en deterministisk tillståndsmotor."
        actions={
          <Button onClick={startNew}>
            <Plus /> Skapa sensor
          </Button>
        }
      />
      {sensors.isLoading ? (
        <Skeleton className="h-64" />
      ) : sensors.isError ? (
        <ErrorState error={sensors.error} onRetry={() => sensors.refetch()} />
      ) : sensors.data?.length === 0 ? (
        <EmptyState icon={Radar} title="Inga sensorer" description="Skapa en sensor genom att välja en kamera och beskriva vad som ska övervakas." action={<Button onClick={startNew}>Skapa sensor</Button>} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Sensor</th>
                <th className="px-4 py-2.5 font-medium">Kamera / zon</th>
                <th className="px-4 py-2.5 font-medium">Läge</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Intervall</th>
                <th className="px-4 py-2.5 font-medium">Senaste analys</th>
              </tr>
            </thead>
            <tbody>
              {sensors.data?.map((s) => {
                const tone = stateTone(s.state.status);
                return (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link to={`/sensors/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      {!s.enabled && <Badge variant="neutral" className="ml-2">Pausad</Badge>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {s.cameraName}
                      {s.zone && (
                        <span className="ml-1 inline-flex items-center gap-1">
                          · <span className="size-2 rounded-sm" style={{ background: s.zone.color }} /> {s.zone.name}
                        </span>
                      )}
                    </td>
                    <td className={cn('px-4 py-3 font-semibold', tone === 'warn' && 'text-warning', tone === 'bad' && 'text-danger', tone === 'none' && 'text-muted-foreground')}>
                      {s.state.valueLabel}
                    </td>
                    <td className="px-4 py-3">
                      <StateStatusBadge status={s.state.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatInterval(s.intervalSeconds)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{timeAgo(s.state.lastObservationAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <Dialog open={pickCamera} onOpenChange={setPickCamera}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Välj kamera</DialogTitle>
          </DialogHeader>
          <Field label="Kamera">
            <Select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
              <option value="">Välj…</option>
              {cameras.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-xs text-muted-foreground">Tips: rita zoner först under kamerans flik "Zoner &amp; sensorer" för att analysera ett specifikt område.</p>
          <div className="flex justify-end">
            <Button
              disabled={!cameraId || camera.isLoading}
              onClick={() => {
                setPickCamera(false);
                setDialogOpen(true);
              }}
            >
              Fortsätt
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {camera.data && <SensorDialog open={dialogOpen} onOpenChange={setDialogOpen} cameraId={camera.data.id} zones={camera.data.zones} />}
    </>
  );
}
