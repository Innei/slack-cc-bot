import type { ContextMemories, MemoryScope } from '~/memory/types.js';
import type { ClaudeUiState } from '~/schemas/claude/publish-state.js';
import type { NormalizedThreadContext } from '~/slack/context/thread-context-loader.js';

export interface ClaudeExecutionRequest {
  channelId: string;
  contextMemories?: ContextMemories;
  mentionText: string;
  resumeSessionId?: string;
  threadContext: NormalizedThreadContext;
  threadTs: string;
  userId: string;
  workspaceLabel?: string;
  workspacePath?: string;
  workspaceRepoId?: string;
}

export type ClaudeExecutionEvent =
  | {
      type: 'lifecycle';
      phase: 'started';
      sessionId?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'completed';
      sessionId?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'failed';
      sessionId?: string;
      error: string;
    }
  | {
      type: 'assistant-message';
      text: string;
    }
  | {
      type: 'ui-state';
      state: ClaudeUiState;
    }
  | {
      type: 'task-update';
      taskId: string;
      title: string;
      status: 'pending' | 'in_progress' | 'complete' | 'error';
      details?: string;
      output?: string;
    };

export interface ClaudeExecutionSink {
  onEvent: (event: ClaudeExecutionEvent) => Promise<void>;
}

export interface ClaudeExecutor {
  drain: () => Promise<void>;
  execute: (request: ClaudeExecutionRequest, sink: ClaudeExecutionSink) => Promise<void>;
}

export type RuntimeSystemStatusKey = 'auth' | 'compacting' | 'hook' | 'permission' | 'retry';

export interface RuntimeToolStatus {
  text: string;
  toolName?: string;
}

export interface RuntimeTaskStatus {
  taskId?: string;
  text: string;
}

export interface ActiveStreamToolUse {
  partialInput: string;
  toolName: string;
  updatedAt: number;
}

export interface RuntimeUiStateTracker {
  activeStreamToolUses: Map<number, ActiveStreamToolUse>;
  loadingMessages: string[];
  sessionStatus: string | undefined;
  systemStatuses: Partial<Record<RuntimeSystemStatusKey, string>>;
  taskStatus: RuntimeTaskStatus | undefined;
  textStreamingActive: boolean;
  toolStatus: RuntimeToolStatus | undefined;
}

export interface MessageHandlers {
  collectAssistantText: (text: string) => void;
  publishUiState: () => Promise<void>;
  runtimeUi: RuntimeUiStateTracker;
  setSessionId: (id: string) => void;
}

export interface ResolvedMemoryScope {
  missingWorkspace: boolean;
  repoId: string | undefined;
  scope: MemoryScope;
}
