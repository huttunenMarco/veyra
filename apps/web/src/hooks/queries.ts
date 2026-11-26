import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  Agent,
  Automation,
  CameraDetail,
  CameraListItem,
  IntegrationConnection,
  Instance,
  Paged,
  Sensor,
  VeyraEvent,
} from '@/lib/types';

export const qk = {
  instance: ['instance'] as const,
  dashboard: ['dashboard'] as const,
  cameras: ['cameras'] as const,
  camera: (id: string) => ['cameras', id] as const,
  sensors: ['sensors'] as const,
  sensor: (id: string) => ['sensors', id] as const,
  events: (params: Record<string, string | undefined> = {}) => ['events', params] as const,
  automations: ['automations'] as const,
  integrations: ['integrations'] as const,
  agents: ['agents'] as const,
};

export const useInstance = () => useQuery({ queryKey: qk.instance, queryFn: () => api<Instance>('/instance'), staleTime: 30_000 });

export const useCameras = () =>
  useQuery({ queryKey: qk.cameras, queryFn: () => api<Paged<CameraListItem>>('/cameras').then((r) => r.data), refetchInterval: 15_000 });

export const useCamera = (id: string) =>
  useQuery({ queryKey: qk.camera(id), queryFn: () => api<CameraDetail>(`/cameras/${id}`), refetchInterval: 10_000, enabled: !!id });

export const useSensors = () =>
  useQuery({ queryKey: qk.sensors, queryFn: () => api<Paged<Sensor>>('/sensors').then((r) => r.data), refetchInterval: 15_000 });

export const useSensor = (id: string) =>
  useQuery({ queryKey: qk.sensor(id), queryFn: () => api<Sensor>(`/sensors/${id}`), refetchInterval: 10_000 });

export function useEvents(params: Record<string, string | undefined> = {}, refetchInterval = 15_000) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({
    queryKey: qk.events(params),
    queryFn: () => api<Paged<VeyraEvent>>(`/events${qs ? `?${qs}` : ''}`),
    refetchInterval,
  });
}

export const useAutomations = () =>
  useQuery({ queryKey: qk.automations, queryFn: () => api<Paged<Automation>>('/automations').then((r) => r.data) });

export const useIntegrations = () =>
  useQuery({
    queryKey: qk.integrations,
    queryFn: () => api<{ data: IntegrationConnection[]; notificationsMode: 'live' | 'simulate' }>('/integrations'),
  });

export const useAgents = () =>
  useQuery({ queryKey: qk.agents, queryFn: () => api<Paged<Agent>>('/agents').then((r) => r.data), refetchInterval: 10_000 });
