import { query } from '@anthropic-ai/claude-agent-sdk';

import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import { extractImplicitMemories } from '~/memory/memory-extractor.js';
import type { MemoryStore } from '~/memory/types.js';

import { createAnthropicAgentSdkMcpServer } from './anthropic-agent-sdk-mcp-server.js';
import { handleClaudeSdkMessage } from './anthropic-agent-sdk-messages.js';
import { buildPrompt, buildSystemPrompt } from './anthropic-agent-sdk-prompts.js';
import {
  buildRuntimeUiState,
  createRuntimeUiStateTracker,
} from './anthropic-agent-sdk-runtime-ui.js';
import type {
  ClaudeExecutionRequest,
  ClaudeExecutionSink,
  ClaudeExecutor,
  MessageHandlers,
  RuntimeUiStateTracker,
} from './types.js';

export class ClaudeAgentSdkExecutor implements ClaudeExecutor {
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly logger: AppLogger,
    private readonly memoryStore: MemoryStore,
  ) {}

  async drain(): Promise<void> {
    if (this.activeExecutions.size > 0) {
      this.logger.info('Draining %d active Claude execution(s)...', this.activeExecutions.size);
      await Promise.allSettled(this.activeExecutions);
    }
  }

  async execute(request: ClaudeExecutionRequest, sink: ClaudeExecutionSink): Promise<void> {
    const execution = this.executeInternal(request, sink);
    this.activeExecutions.add(execution);
    try {
      await execution;
    } finally {
      this.activeExecutions.delete(execution);
    }
  }

  private async executeInternal(
    request: ClaudeExecutionRequest,
    sink: ClaudeExecutionSink,
  ): Promise<void> {
    this.logger.info('Claude Agent SDK execution requested for thread %s', request.threadTs);

    const mcpServer = createAnthropicAgentSdkMcpServer(
      this.logger,
      this.memoryStore,
      request,
      sink,
    );
    const prompt = buildPrompt(request);

    this.logger.info(
      'Creating Claude SDK query (thread %s, model=%s, maxTurns=%d, permissionMode=%s, resume=%s, cwd=%s)',
      request.threadTs,
      env.CLAUDE_MODEL ?? 'default',
      env.CLAUDE_MAX_TURNS,
      env.CLAUDE_PERMISSION_MODE,
      request.resumeSessionId ?? 'none',
      request.workspacePath ?? '(none)',
    );

    let session: ReturnType<typeof query>;
    try {
      session = query({
        prompt,
        options: {
          ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
          agentProgressSummaries: true,
          includeHookEvents: true,
          includePartialMessages: true,
          maxTurns: env.CLAUDE_MAX_TURNS,
          ...(request.workspacePath ? { cwd: request.workspacePath } : {}),
          systemPrompt: buildSystemPrompt(request),
          mcpServers: {
            'slack-ui': mcpServer,
          },
          permissionMode: env.CLAUDE_PERMISSION_MODE,
          ...(env.CLAUDE_PERMISSION_MODE === 'bypassPermissions'
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          persistSession: true,
          ...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
        },
      });
      this.logger.info('Claude SDK query created (thread %s)', request.threadTs);
    } catch (error) {
      const message = this.describeUnknownError(error);
      this.logger.error(
        'Failed to create Claude SDK query (thread %s): %s',
        request.threadTs,
        message,
      );
      throw error;
    }

    let sessionId: string | undefined;
    const runtimeUi = createRuntimeUiStateTracker();
    const collectedAssistantTexts: string[] = [];
    const handlers: MessageHandlers = {
      collectAssistantText: (text) => {
        collectedAssistantTexts.push(text);
      },
      publishUiState: async () => {
        await this.publishRuntimeUiState(request.threadTs, sink, runtimeUi);
      },
      runtimeUi,
      setSessionId: (id) => {
        sessionId = id;
      },
    };

    try {
      await sink.onEvent({ type: 'lifecycle', phase: 'started' });

      let firstMessage = true;
      this.logger.info('Waiting for Claude SDK output (thread %s)...', request.threadTs);

      for await (const message of session) {
        if (firstMessage) {
          firstMessage = false;
          this.logger.info(
            'First Claude SDK message (thread %s, type=%s)',
            request.threadTs,
            message.type,
          );
        }

        await handleClaudeSdkMessage(this.logger, message, sink, handlers);
      }

      this.logger.info('Claude SDK message stream ended (thread %s)', request.threadTs);
      await this.extractAndSaveImplicitMemories(request, collectedAssistantTexts.join('\n'));

      await sink.onEvent({
        type: 'lifecycle',
        phase: 'completed',
        ...(sessionId ? { sessionId } : {}),
      });
    } catch (error) {
      const errorMessage = this.describeUnknownError(error);
      this.logger.error('Claude Agent SDK execution failed: %s', redact(errorMessage));
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: errorMessage,
      });
    }
  }

  private describeUnknownError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async extractAndSaveImplicitMemories(
    request: ClaudeExecutionRequest,
    assistantText: string,
  ): Promise<void> {
    try {
      const existingMemories = this.memoryStore.search(undefined, {
        category: 'preference',
        limit: 50,
      });
      const workspacePrefs = request.workspaceRepoId
        ? this.memoryStore.search(request.workspaceRepoId, {
            category: 'preference',
            limit: 50,
          })
        : [];

      const allExisting = [...existingMemories, ...workspacePrefs];
      const extracted = await extractImplicitMemories({
        userMessage: request.mentionText,
        assistantResponse: assistantText,
        existingMemories: allExisting,
        logger: this.logger,
      });

      if (extracted.length === 0) {
        return;
      }

      this.logger.info(
        'Memory extractor found %d implicit memories for thread %s',
        extracted.length,
        request.threadTs,
      );

      for (const memory of extracted) {
        this.memoryStore.saveWithDedup(
          {
            category: memory.category,
            content: memory.content,
            threadTs: request.threadTs,
            ...(memory.expiresAt ? { expiresAt: memory.expiresAt } : {}),
          },
          memory.supersedesId,
        );
      }
    } catch (error) {
      const message = this.describeUnknownError(error);
      this.logger.warn('Post-conversation memory extraction failed: %s', message);
    }
  }

  private async publishRuntimeUiState(
    threadTs: string,
    sink: ClaudeExecutionSink,
    runtimeUi: RuntimeUiStateTracker,
  ): Promise<void> {
    const state = buildRuntimeUiState(threadTs, runtimeUi);
    if (!state) {
      return;
    }

    await sink.onEvent({
      type: 'ui-state',
      state,
    });
  }
}
