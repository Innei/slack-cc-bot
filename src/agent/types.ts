import type { ContextMemories } from '~/memory/types.js';
import type { NormalizedThreadContext } from '~/slack/context/thread-context-loader.js';

export interface GeneratedImageFile {
  fileName: string;
  path: string;
  providerFileId: string;
}

export interface AgentExecutionRequest {
  abortSignal?: AbortSignal;
  channelId: string;
  contextMemories?: ContextMemories;
  mentionText: string;
  resumeHandle?: string;
  threadContext: NormalizedThreadContext;
  threadTs: string;
  userId: string;
  workspaceLabel?: string;
  workspacePath?: string;
  workspaceRepoId?: string;
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
      reason: 'user_stop';
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
