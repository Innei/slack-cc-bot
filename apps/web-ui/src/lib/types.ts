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

export interface SessionAnalyticsRecord {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  createdAt: string;
  durationMs: number;
  id: string;
  inputTokens: number;
  modelUsage?: Array<{
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    costUSD: number;
    inputTokens: number;
    model: string;
    outputTokens: number;
  }>;
  modelUsageJson: string;
  outputTokens: number;
  threadTs: string;
  totalCostUSD: number;
  userId?: string | null;
}

export interface SessionRow {
  agentProvider: string | null;
  bootstrapMessageTs: string | null;
  channelId: string;
  createdAt: string;
  providerSessionId: string | null;
  rootMessageTs: string;
  streamMessageTs: string | null;
  threadTs: string;
  updatedAt: string;
  workspaceLabel: string | null;
  workspacePath: string | null;
  workspaceRepoId: string | null;
  workspaceRepoPath: string | null;
  workspaceSource: 'auto' | 'manual' | null;
}

export interface MemoryRecord {
  category: 'task_completed' | 'decision' | 'context' | 'observation' | 'preference';
  content: string;
  createdAt: string;
  expiresAt?: string | null;
  id: string;
  metadata?: Record<string, unknown> | null;
  repoId?: string | null;
  scope: 'global' | 'workspace';
  threadTs?: string | null;
}

export interface ContextMemories {
  global: MemoryRecord[];
  preferences: MemoryRecord[];
  workspace: MemoryRecord[];
}

export interface WorkspaceRepo {
  aliases: string[];
  id: string;
  label: string;
  name: string;
  relativePath: string;
  repoPath: string;
}

export interface VersionInfo {
  commitDate: string;
  gitHash: string;
  nodeEnv: string;
  version: string;
}
