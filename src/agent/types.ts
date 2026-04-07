import type { ContextMemories } from '~/memory/types.js';
import type { NormalizedThreadContext } from '~/slack/context/thread-context-loader.js';

export interface GeneratedOutputFile {
  fileName: string;
  path: string;
  providerFileId: string;
}

export type GeneratedImageFile = GeneratedOutputFile;

export interface AgentExecutionRequest {
  abortSignal?: AbortSignal;
  channelId: string;
  contextMemories?: ContextMemories;
  executionId?: string;
  mentionText: string;
  resumeHandle?: string;
  threadContext: NormalizedThreadContext;
  threadTs: string;
  userId: string;
  workspaceLabel?: string;
  workspacePath?: string;
  workspaceRepoId?: string;
}

export interface ModelUsageInfo {
  cacheCreationInputTokens: number;
  cacheHitRate: number;
  cacheReadInputTokens: number;
  costUSD: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
}

export interface SessionUsageInfo {
  durationMs: number;
  modelUsage: ModelUsageInfo[];
  totalCostUSD: number;
}

export type AgentExecutionEvent =
  | {
      type: 'lifecycle';
      phase: 'started';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'completed';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'stopped';
      reason: 'superseded' | 'user_stop';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'failed';
      resumeHandle?: string;
      error: string;
    }
  | {
      type: 'assistant-message';
      text: string;
    }
  | {
      type: 'activity-state';
      state: AgentActivityState;
    }
  | {
      type: 'task-update';
      taskId: string;
      title: string;
      status: 'pending' | 'in_progress' | 'complete' | 'error';
      details?: string;
      output?: string;
    }
  | {
      type: 'generated-images';
      files: GeneratedImageFile[];
    }
  | {
      type: 'generated-files';
      files: GeneratedOutputFile[];
    }
  | {
      type: 'usage-info';
      usage: SessionUsageInfo;
    };

export interface AgentActivityState {
  activities?: string[] | undefined;
  clear?: boolean | undefined;
  composing?: boolean | undefined;
  status?: string | undefined;
  threadTs: string;
}

export interface AgentExecutionSink {
  onEvent: (event: AgentExecutionEvent) => Promise<void>;
}

export interface AgentExecutor {
  drain: () => Promise<void>;
  execute: (request: AgentExecutionRequest, sink: AgentExecutionSink) => Promise<void>;
  readonly providerId: string;
}
