import { Camera, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Snapshot } from '@/components/Snapshot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/feedback';
import { useCameras } from '@/hooks/queries';
import { CameraStatusBadge, connectionTypeLabels } from '@/lib/labels';
import { formatInterval, timeAgo } from '@/lib/utils';

export function CamerasPage() {
  const { data, isLoading, isError, error, refetch } = useCameras();
  return (
    <>
      <PageHeader
        title="Kameror"
        description="Befintliga IP-kameror som används som AI-sensorer."
        actions={
          <Button asChild>
            <Link to="/cameras/new">
              <Plus /> Lägg till kamera
            </Link>
          </Button>
        }
      />
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : data?.length === 0 ? (
        <EmptyState
          icon={Camera}
          title="Inga kameror"
          description="Lägg till din första kamera för att börja övervaka."
          action={
            <Button asChild>
              <Link to="/cameras/new">
                <Plus /> Lägg till kamera
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {data?.map((c) => (
            <Link key={c.id} to={`/cameras/${c.id}`}>
              <Card className="flex items-center gap-4 p-3 transition-shadow hover:shadow-md">
                <Snapshot frameId={c.latestFrame?.id} className="w-32 shrink-0 rounded-lg sm:w-44" demo={c.connectionType === 'demo'} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <CameraStatusBadge status={c.status} />
                    {c.connectionType === 'demo' && <Badge variant="demo">Demokälla</Badge>}
                    {!c.autoCapture && c.connectionType !== 'manual' && <Badge variant="warning">Manuell analys</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {connectionTypeLabels[c.connectionType]}
                    {c.connection.host ? ` · ${c.connection.host}` : ''}
                    {c.location ? ` · ${c.location}` : ''}
                  </div>
                  {c.statusMessage && c.status !== 'online' && <div className="text-xs text-danger">{c.statusMessage}</div>}
                  <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    <span>{c.zoneCount} zoner</span>
                    <span>{c.sensorCount} sensorer</span>
                    <span>Senaste bild {timeAgo(c.lastFrameAt)}</span>
                    <span>{c.autoCapture ? `Intervall ${formatInterval(c.captureIntervalSeconds)}` : 'Endast "Analysera nu"'}</span>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
