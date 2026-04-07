import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '~/lib/api-client';
import type { AppSettings, BotStatus, Session, Workspace } from '~/lib/types';

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => apiFetch<BotStatus>('/status'),
    refetchInterval: 5_000,
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => apiFetch<Session[]>('/sessions'),
  });
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiFetch<Workspace[]>('/workspaces'),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<AppSettings>('/settings'),
  });
}
