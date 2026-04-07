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

export interface SessionAnalyticsStore {
  upsert: (threadTs: string, userId: string | undefined, usage: SessionUsageInfo) => void;
}
