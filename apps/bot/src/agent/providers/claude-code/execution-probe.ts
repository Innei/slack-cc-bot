export interface ClaudeExecutionProbeRequestRecord {
  executionId: string;
  kind: 'request';
  recordedAt: string;
  resumeHandle?: string;
  threadTs: string;
  workspacePath?: string;
}

export interface ClaudeExecutionProbeSessionRecord {
  executionId: string;
  kind: 'session';
  recordedAt: string;
  sessionCwd?: string;
  sessionId: string;
  threadTs: string;
}

export interface ClaudeExecutionProbeLifecycleRecord {
  executionId: string;
  kind: 'lifecycle';
  phase: 'completed' | 'failed' | 'started' | 'stopped';
  reason?: 'superseded' | 'user_stop';
  recordedAt: string;
  resumeHandle?: string;
  threadTs: string;
}

export type ClaudeExecutionProbeRecord =
  | ClaudeExecutionProbeRequestRecord
  | ClaudeExecutionProbeSessionRecord
  | ClaudeExecutionProbeLifecycleRecord;

export interface ClaudeExecutionProbe {
  record: (record: ClaudeExecutionProbeRecord) => Promise<void>;
}
