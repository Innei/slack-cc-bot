import type { ClaudeUiState } from '../../schemas/claude/publish-state.js';
import type { NormalizedThreadContext } from '../../slack/context/thread-context-loader.js';

export interface ClaudeExecutionRequest {
  channelId: string;
  mentionText: string;
  resumeSessionId?: string;
  threadContext: NormalizedThreadContext;
  threadTs: string;
  userId: string;
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
  execute: (request: ClaudeExecutionRequest, sink: ClaudeExecutionSink) => Promise<void>;
}
