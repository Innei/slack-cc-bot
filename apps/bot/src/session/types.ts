export interface SessionRecord {
  agentProvider?: string | undefined;
  bootstrapMessageTs?: string | undefined;
  channelId: string;
  createdAt: string;
  providerSessionId?: string | undefined;
  rootMessageTs: string;
  streamMessageTs?: string | undefined;
  threadTs: string;
  updatedAt: string;
  workspaceLabel?: string | undefined;
  workspacePath?: string | undefined;
  workspaceRepoId?: string | undefined;
  workspaceRepoPath?: string | undefined;
  workspaceSource?: 'auto' | 'manual' | undefined;
}

export type SessionState = 'registered' | 'bootstrapped' | 'streaming' | 'completed' | 'failed';

export function getSessionState(record: SessionRecord): SessionState {
  if (record.streamMessageTs) return 'streaming';
  if (record.bootstrapMessageTs) return 'bootstrapped';
  return 'registered';
}

export interface SessionStore {
  countAll: () => number;
  get: (threadTs: string) => SessionRecord | undefined;
  patch: (threadTs: string, patch: Partial<SessionRecord>) => SessionRecord | undefined;
  upsert: (record: SessionRecord) => SessionRecord;
}
