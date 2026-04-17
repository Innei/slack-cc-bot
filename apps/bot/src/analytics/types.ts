import type { SessionUsageInfo } from '~/agent/types.js';

export interface SessionAnalyticsRecord {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  createdAt: string;
  durationMs: number;
  id: string;
  inputTokens: number;
  modelUsageJson: string;
  outputTokens: number;
  threadTs: string;
  totalCostUSD: number;
  userId?: string;
}

export interface AnalyticsOverview {
  avgDurationMs: number;
  cacheHitRate: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
}

export interface ModelAnalyticsRow {
  cacheHitRate: number;
  cacheReadTokens: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  sessions: number;
  totalCostUSD: number;
}

export interface SessionAnalyticsStore {
  getByModel: () => ModelAnalyticsRow[];
  getOverview: () => AnalyticsOverview;
  getRecentSessions: (limit: number) => SessionAnalyticsRecord[];
  upsert: (threadTs: string, userId: string | undefined, usage: SessionUsageInfo) => void;
}
