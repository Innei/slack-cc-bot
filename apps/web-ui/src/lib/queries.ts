import { useQuery } from '@tanstack/react-query';

import { apiGet } from './api';
import type {
  AnalyticsOverview,
  ContextMemories,
  MemoryRecord,
  ModelAnalyticsRow,
  SessionAnalyticsRecord,
  SessionRow,
  VersionInfo,
  WorkspaceRepo,
} from './types';

export const queryKeys = {
  analyticsOverview: ['analytics', 'overview'] as const,
  analyticsModels: ['analytics', 'models'] as const,
  analyticsSessions: (limit: number) => ['analytics', 'sessions', { limit }] as const,
  sessions: (limit: number) => ['sessions', { limit }] as const,
  session: (threadTs: string) => ['sessions', threadTs] as const,
  memory: (params: { category?: string; limit: number; query?: string; repoId?: string }) =>
    ['memory', params] as const,
  memoryContext: (repoId?: string) => ['memory', 'context', repoId ?? null] as const,
  workspaces: ['workspaces'] as const,
  version: ['version'] as const,
};

export function useOverview() {
  return useQuery({
    queryFn: () => apiGet<AnalyticsOverview>('/api/analytics/overview'),
    queryKey: queryKeys.analyticsOverview,
  });
}

export function useModelAnalytics() {
  return useQuery({
    queryFn: () => apiGet<{ rows: ModelAnalyticsRow[] }>('/api/analytics/models'),
    queryKey: queryKeys.analyticsModels,
    select: (data) => data.rows,
  });
}

export function useRecentSessions(limit = 20) {
  return useQuery({
    queryFn: () =>
      apiGet<{ rows: SessionAnalyticsRecord[] }>(`/api/analytics/sessions?limit=${limit}`),
    queryKey: queryKeys.analyticsSessions(limit),
    select: (data) => data.rows,
  });
}

export function useSessions(limit = 50) {
  return useQuery({
    queryFn: () => apiGet<{ rows: SessionRow[]; total: number }>(`/api/sessions?limit=${limit}`),
    queryKey: queryKeys.sessions(limit),
  });
}

export function useSession(threadTs: string | undefined) {
  return useQuery({
    enabled: !!threadTs,
    queryFn: () => apiGet<SessionRow>(`/api/sessions/${threadTs}`),
    queryKey: queryKeys.session(threadTs ?? ''),
  });
}

export function useMemory(params: {
  category?: string;
  limit?: number;
  query?: string;
  repoId?: string;
}) {
  const { category, limit = 50, query, repoId } = params;
  const search = new URLSearchParams();
  if (category) search.set('category', category);
  if (query) search.set('q', query);
  if (repoId) search.set('repoId', repoId);
  search.set('limit', String(limit));

  return useQuery({
    queryFn: () =>
      apiGet<{ rows: MemoryRecord[]; total: number }>(`/api/memory?${search.toString()}`),
    queryKey: queryKeys.memory({ category, limit, query, repoId }),
  });
}

export function useMemoryContext(repoId?: string) {
  const search = new URLSearchParams();
  if (repoId) search.set('repoId', repoId);
  return useQuery({
    queryFn: () => apiGet<ContextMemories>(`/api/memory/context?${search.toString()}`),
    queryKey: queryKeys.memoryContext(repoId),
  });
}

export function useWorkspaces() {
  return useQuery({
    queryFn: () => apiGet<{ rows: WorkspaceRepo[] }>('/api/workspaces'),
    queryKey: queryKeys.workspaces,
    select: (data) => data.rows,
  });
}

export function useVersion() {
  return useQuery({
    queryFn: () => apiGet<VersionInfo>('/api/version'),
    queryKey: queryKeys.version,
    staleTime: 5 * 60 * 1000,
  });
}
