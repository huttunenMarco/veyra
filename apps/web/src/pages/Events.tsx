import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { eventTypes } from '@veyra/shared';
import { EventRow } from '@/components/EventList';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/input';
import { useCameras, useSensors } from '@/hooks/queries';
import { api } from '@/lib/api';
import { eventTypeLabels } from '@/lib/labels';
import type { Paged, VeyraEvent } from '@/lib/types';

export function EventsPage() {
  const [params] = useSearchParams();
  const highlight = params.get('highlight');
  const cameras = useCameras();
  const sensors = useSensors();
  const [f, setF] = useState({ cameraId: '', zoneId: '', sensorId: '', type: '', from: '', to: '', deliveryStatus: '' });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const query = useInfiniteQuery({
    queryKey: ['events', 'page', f],
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '30' });
      for (const [k, v] of Object.entries(f)) {
        if (!v) continue;
        qs.set(k, k === 'from' || k === 'to' ? new Date(v).toISOString() : v);
      }
      if (pageParam) qs.set('cursor', pageParam);
      return api<Paged<VeyraEvent>>(`/events?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });

  const zones = Array.from(
    new Map((sensors.data ?? []).filter((s) => s.zone && (!f.cameraId || s.cameraId === f.cameraId)).map((s) => [s.zone!.id, s.zone!])).values(),
  );
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader title="Händelser" description="Bekräftade statusändringar, kamerastatus och automatiseringarnas leveranser." />
      <Card className="mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Select value={f.cameraId} onChange={(e) => setF((s) => ({ ...s, cameraId: e.target.value, zoneId: '', sensorId: '' }))}>
          <option value="">Alla kameror</option>
          {cameras.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={f.zoneId} onChange={(e) => set('zoneId', e.target.value)}>
          <option value="">Alla zoner</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
        <Select value={f.sensorId} onChange={(e) => set('sensorId', e.target.value)}>
          <option value="">Alla sensorer</option>
          {sensors.data
            ?.filter((s) => !f.cameraId || s.cameraId === f.cameraId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </Select>
        <Select value={f.type} onChange={(e) => set('type', e.target.value)}>
          <option value="">Alla typer</option>
          {eventTypes.map((t) => (
            <option key={t} value={t}>
              {eventTypeLabels[t]}
            </option>
          ))}
        </Select>
        <Select value={f.deliveryStatus} onChange={(e) => set('deliveryStatus', e.target.value)}>
          <option value="">Alla leveranser</option>
          <option value="delivered">Levererade</option>
          <option value="failed">Misslyckade</option>
          <option value="pending">Pågående</option>
        </Select>
        <Input type="datetime-local" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="Från" title="Från" />
        <Input type="datetime-local" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="Till" title="Till" />
      </Card>

      {query.isLoading ? (
        <Skeleton className="h-64" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title="Inga händelser" description="Inga händelser matchar filtret." />
      ) : (
        <>
          <Card className="overflow-hidden">
            {items.map((e) => (
              <EventRow key={e.id} event={e} highlight={e.id === highlight} />
            ))}
          </Card>
          {query.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                Visa fler
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
