import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppDatabase } from '~/db/index.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionStore } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';

export interface HttpServerDeps {
  analyticsStore: SessionAnalyticsStore;
  db: AppDatabase;
  logger: AppLogger;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  workspaceResolver: WorkspaceResolver;
}

export interface BuildInfo {
  commitDate: string;
  gitHash: string;
  nodeEnv: string;
  version: string;
}
