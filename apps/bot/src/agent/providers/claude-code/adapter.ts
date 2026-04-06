import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentExecutionRequest,
  AgentExecutionSink,
  AgentExecutor,
  AgentUserInputOption,
  AgentUserInputQuestion,
  AgentUserInputRequest,
} from '~/agent/types.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import { extractImplicitMemories } from '~/memory/memory-extractor.js';
import type { MemoryStore } from '~/memory/types.js';

import type { ClaudeExecutionProbe, ClaudeExecutionProbeRecord } from './execution-probe.js';
import { createAnthropicAgentSdkMcpServer } from './mcp-server.js';
import { handleClaudeSdkMessage } from './messages.js';
import { createClaudePromptInput } from './prompt-input.js';
import { buildRuntimeUiState, createRuntimeUiStateTracker } from './runtime-ui.js';
import type { MessageHandlers, RuntimeUiStateTracker } from './types.js';

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const execFileAsync = promisify(execFile);

interface ClaudeAuthStatus {
  apiProvider?: string;
  authMethod?: string;
  email?: string;
  loggedIn?: boolean;
  orgName?: string;
  subscriptionType?: string;
}

interface ClaudeRuntimeConfigSummary {
  anthropicBaseUrl: string | undefined;
  anthropicDefaultHaikuModel: string | undefined;
  anthropicDefaultOpusModel: string | undefined;
  anthropicDefaultSonnetModel: string | undefined;
  anthropicModel: string | undefined;
  claudeModel: string | undefined;
}

function getClaudeRuntimeConfigSummary(): ClaudeRuntimeConfigSummary {
  return {
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    anthropicDefaultHaikuModel: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || undefined,
    anthropicDefaultOpusModel: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || undefined,
    anthropicDefaultSonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || undefined,
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || undefined,
    claudeModel: env.CLAUDE_MODEL,
  };
}

async function nextMessageOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (!signal) {
    return iterator.next();
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  let onAbort: (() => void) | undefined;
  const nextPromise = iterator.next();
  const abortPromise = new Promise<IteratorResult<T>>((_, reject) => {
    onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([nextPromise, abortPromise]);
  } catch (error) {
    if (isAbortError(error)) {
      void nextPromise.catch(() => {
        /* avoid unhandled rejection when abort wins the race */
      });
    }
    throw error;
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function disposeAsyncIterator(
  iterator: AsyncIterator<SDKMessage> | undefined,
): Promise<void> {
  if (!iterator?.return) {
    return;
  }
  try {
    await iterator.return();
  } catch {
    /* ignore teardown errors */
  }
}

export class ClaudeAgentSdkExecutor implements AgentExecutor {
  readonly providerId = 'claude-code';
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    private readonly logger: AppLogger,
    private readonly memoryStore: MemoryStore,
    private readonly executionProbe?: ClaudeExecutionProbe,
  ) {
    void this.logClaudeAuthStatus();
    this.logClaudeRuntimeConfig();
  }

  async drain(): Promise<void> {
    if (this.activeExecutions.size > 0) {
      this.logger.info('Draining %d active Claude execution(s)...', this.activeExecutions.size);
      await Promise.allSettled(this.activeExecutions);
    }
  }

  async execute(request: AgentExecutionRequest, sink: AgentExecutionSink): Promise<void> {
    const execution = this.executeInternal(request, sink);
    this.activeExecutions.add(execution);
    try {
      await execution;
    } finally {
      this.activeExecutions.delete(execution);
    }
  }

  private async executeInternal(
    request: AgentExecutionRequest,
    sink: AgentExecutionSink,
  ): Promise<void> {
    this.logger.info('Claude Agent SDK execution requested for thread %s', request.threadTs);
    const probeExecutionId = request.executionId ?? 'unknown';
    await this.recordExecutionProbe({
      executionId: probeExecutionId,
      kind: 'request',
      recordedAt: new Date().toISOString(),
      ...(request.resumeHandle ? { resumeHandle: request.resumeHandle } : {}),
      threadTs: request.threadTs,
      ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
    });

    const mcpServer = createAnthropicAgentSdkMcpServer(
      this.logger,
      this.memoryStore,
      request,
      sink,
    );
    const { systemPrompt, userPrompt } = createClaudePromptInput(request);

    this.logger.info(
      'Creating Claude SDK query (thread %s, model=%s, permissionMode=%s, resume=%s, cwd=%s)',
      request.threadTs,
      env.CLAUDE_MODEL ?? 'default',
      env.CLAUDE_PERMISSION_MODE,
      request.resumeHandle ?? 'none',
      request.workspacePath ?? '(none)',
    );

    let session: ReturnType<typeof query>;
    try {
      const skillOptions = this.buildSkillOptions(sink);
      session = query({
        prompt: userPrompt,
        options: {
          ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
          agentProgressSummaries: true,
          includeHookEvents: true,
          includePartialMessages: true,
          ...(request.workspacePath ? { cwd: request.workspacePath } : {}),
          systemPrompt,
          mcpServers: {
            'slack-ui': mcpServer,
          },
          permissionMode: env.CLAUDE_PERMISSION_MODE,
          ...(env.CLAUDE_PERMISSION_MODE === 'bypassPermissions'
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          persistSession: true,
          ...skillOptions,
          ...(request.resumeHandle ? { resume: request.resumeHandle } : {}),
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
    let sessionCwd: string | undefined;
    let recordedSessionId: string | undefined;
    const runtimeUi = createRuntimeUiStateTracker();
    const collectedAssistantTexts: string[] = [];
    const handlers: MessageHandlers = {
      collectAssistantText: (text) => {
        collectedAssistantTexts.push(text);
      },
      getSessionCwd: () => sessionCwd,
      publishUiState: async () => {
        await this.publishRuntimeUiState(request.threadTs, sink, runtimeUi);
      },
      runtimeUi,
      setSessionCwd: (cwd) => {
        sessionCwd = cwd;
      },
      setSessionId: (id) => {
        sessionId = id;
        if (recordedSessionId === id) {
          return;
        }
        recordedSessionId = id;
        void this.recordExecutionProbe({
          executionId: probeExecutionId,
          kind: 'session',
          recordedAt: new Date().toISOString(),
          ...(sessionCwd ? { sessionCwd } : {}),
          sessionId: id,
          threadTs: request.threadTs,
        });
      },
    };

    let iterator: AsyncIterator<SDKMessage> | undefined;
    try {
      await sink.onEvent({ type: 'lifecycle', phase: 'started' });
      await this.recordExecutionProbe({
        executionId: probeExecutionId,
        kind: 'lifecycle',
        phase: 'started',
        recordedAt: new Date().toISOString(),
        threadTs: request.threadTs,
      });

      let firstMessage = true;
      this.logger.info('Waiting for Claude SDK output (thread %s)...', request.threadTs);

      iterator = (session as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextMessageOrAbort(iterator, request.abortSignal);
        if (next.done) {
          break;
        }
        const message = next.value as SDKMessage;
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
        ...(sessionId ? { resumeHandle: sessionId } : {}),
      });
      await this.recordExecutionProbe({
        executionId: probeExecutionId,
        kind: 'lifecycle',
        phase: 'completed',
        recordedAt: new Date().toISOString(),
        ...(sessionId ? { resumeHandle: sessionId } : {}),
        threadTs: request.threadTs,
      });
    } catch (error) {
      if (isAbortError(error)) {
        const stopReason =
          request.abortSignal?.reason === 'superseded' ? 'superseded' : 'user_stop';
        this.logger.info(
          'Claude Agent SDK execution stopped (reason=%s, thread %s)',
          stopReason,
          request.threadTs,
        );
        await disposeAsyncIterator(iterator);
        try {
          await sink.onEvent({
            type: 'lifecycle',
            phase: 'stopped',
            reason: stopReason,
            ...(sessionId ? { resumeHandle: sessionId } : {}),
          });
          await this.recordExecutionProbe({
            executionId: probeExecutionId,
            kind: 'lifecycle',
            phase: 'stopped',
            reason: stopReason,
            recordedAt: new Date().toISOString(),
            ...(sessionId ? { resumeHandle: sessionId } : {}),
            threadTs: request.threadTs,
          });
        } catch (publishError) {
          const msg = this.describeUnknownError(publishError);
          this.logger.warn(
            'Failed to publish stopped lifecycle (thread %s): %s',
            request.threadTs,
            redact(msg),
          );
        }
        return;
      }
      const errorMessage = this.describeUnknownError(error);
      this.logger.error('Claude Agent SDK execution failed: %s', redact(errorMessage));
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'failed',
        ...(sessionId ? { resumeHandle: sessionId } : {}),
        error: errorMessage,
      });
      await this.recordExecutionProbe({
        executionId: probeExecutionId,
        kind: 'lifecycle',
        phase: 'failed',
        recordedAt: new Date().toISOString(),
        ...(sessionId ? { resumeHandle: sessionId } : {}),
        threadTs: request.threadTs,
      });
    }
  }

  private async logClaudeAuthStatus(): Promise<void> {
    try {
      const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
        env: process.env,
        timeout: 5_000,
      });
      const status = JSON.parse(stdout) as ClaudeAuthStatus;
      this.logger.info(
        'Claude Code auth status at executor startup: loggedIn=%s authMethod=%s apiProvider=%s subscriptionType=%s email=%s orgName=%s',
        status.loggedIn === true ? 'true' : 'false',
        status.authMethod ?? '(unknown)',
        status.apiProvider ?? '(unknown)',
        status.subscriptionType ?? '(unknown)',
        status.email ?? '(unknown)',
        status.orgName ?? '(unknown)',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to query Claude Code auth status at executor startup: %s', message);
    }
  }

  private logClaudeRuntimeConfig(): void {
    const config = getClaudeRuntimeConfigSummary();
    this.logger.info(
      'Claude Code runtime config at executor startup: CLAUDE_MODEL=%s ANTHROPIC_MODEL=%s ANTHROPIC_DEFAULT_SONNET_MODEL=%s ANTHROPIC_DEFAULT_HAIKU_MODEL=%s ANTHROPIC_DEFAULT_OPUS_MODEL=%s ANTHROPIC_BASE_URL=%s',
      config.claudeModel ?? '(unset)',
      config.anthropicModel ?? '(unset)',
      config.anthropicDefaultSonnetModel ?? '(unset)',
      config.anthropicDefaultHaikuModel ?? '(unset)',
      config.anthropicDefaultOpusModel ?? '(unset)',
      config.anthropicBaseUrl ?? '(unset)',
    );
  }

  private describeUnknownError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async recordExecutionProbe(record: ClaudeExecutionProbeRecord): Promise<void> {
    if (!this.executionProbe) {
      return;
    }
    try {
      await this.executionProbe.record(record);
    } catch (error) {
      this.logger.warn(
        'Failed to record Claude execution probe for thread %s: %s',
        record.threadTs,
        this.describeUnknownError(error),
      );
    }
  }

  private buildSkillOptions(sink: AgentExecutionSink): {
    allowedTools?: string[];
    canUseTool?: CanUseTool;
    settingSources?: Array<'user' | 'project'>;
  } {
    if (!env.CLAUDE_ENABLE_SKILLS) {
      return {};
    }

    return {
      settingSources: ['user', 'project'],
      allowedTools: ['Skill'],
      canUseTool: async (toolName, input, options) => {
        if (toolName === 'Skill') {
          return {
            behavior: 'allow',
            updatedInput: input,
          };
        }

        if (toolName === 'AskUserQuestion') {
          const userInputRequest = parseAgentUserInputRequest(input);
          if (!userInputRequest) {
            return {
              behavior: 'deny',
              message: 'The Slack host received an invalid AskUserQuestion payload.',
            };
          }

          if (!sink.requestUserInput) {
            return {
              behavior: 'deny',
              message:
                'The Slack host does not yet bridge AskUserQuestion. Ask the user your clarifying questions in normal assistant text instead.',
            };
          }

          const response = await sink.requestUserInput(userInputRequest, {
            description: options.description,
            displayName: options.displayName,
            signal: options.signal,
            title: options.title,
            toolUseId: options.toolUseID,
          });

          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              answers: response.answers,
              ...(response.annotations ? { annotations: response.annotations } : {}),
            },
          };
        }

        return {
          behavior: 'deny',
          message:
            'The Slack host only bridges Skill dispatch and AskUserQuestion right now. Other tool permission requests inside skills are not yet supported here.',
        };
      },
    };
  }
  private async extractAndSaveImplicitMemories(
    request: AgentExecutionRequest,
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
    sink: AgentExecutionSink,
    runtimeUi: RuntimeUiStateTracker,
  ): Promise<void> {
    const state = buildRuntimeUiState(threadTs, runtimeUi);
    if (!state) {
      return;
    }

    await sink.onEvent({
      type: 'activity-state',
      state,
    });
  }
}

function parseAgentUserInputRequest(
  input: Record<string, unknown>,
): AgentUserInputRequest | undefined {
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return undefined;
  }

  const questions: AgentUserInputQuestion[] = [];
  for (const rawQuestion of input.questions) {
    if (!rawQuestion || typeof rawQuestion !== 'object') {
      return undefined;
    }

    const question = readString((rawQuestion as Record<string, unknown>).question);
    const header = readString((rawQuestion as Record<string, unknown>).header);
    const options = parseAgentUserInputOptions((rawQuestion as Record<string, unknown>).options);
    if (!question || !header || options.length === 0) {
      return undefined;
    }

    questions.push({
      header,
      multiSelect:
        typeof (rawQuestion as Record<string, unknown>).multiSelect === 'boolean'
          ? ((rawQuestion as Record<string, unknown>).multiSelect as boolean)
          : undefined,
      options,
      question,
    });
  }

  const request: AgentUserInputRequest = { questions };
  if (input.metadata && typeof input.metadata === 'object') {
    const source = readString((input.metadata as Record<string, unknown>).source);
    if (source) {
      request.metadata = { source };
    }
  }
  return request;
}

function parseAgentUserInputOptions(value: unknown): AgentUserInputOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options: AgentUserInputOption[] = [];
  for (const rawOption of value) {
    if (!rawOption || typeof rawOption !== 'object') {
      return [];
    }

    const label = readString((rawOption as Record<string, unknown>).label);
    const description = readString((rawOption as Record<string, unknown>).description);
    if (!label || !description) {
      return [];
    }

    const preview = readString((rawOption as Record<string, unknown>).preview);
    options.push({
      description,
      label,
      ...(preview ? { preview } : {}),
    });
  }

  return options;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
