import path from 'node:path';

import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAuthStatusMessage,
  SDKHookProgressMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKToolProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';

import { env } from '../../env/server.js';
import type { AppLogger } from '../../logger/index.js';
import { redact } from '../../logger/redact.js';
import type { ClaudeUiState } from '../../schemas/claude/publish-state.js';
import { ClaudeUiStateToolInputShape } from '../../schemas/claude/publish-state.js';
import {
  parseSlackUiStateToolInput,
  SLACK_UI_STATE_TOOL_DESCRIPTION,
  SLACK_UI_STATE_TOOL_NAME,
} from '../tools/publish-state.js';
import type { ClaudeExecutionRequest, ClaudeExecutionSink, ClaudeExecutor } from './types.js';

type RuntimeSystemStatusKey = 'auth' | 'compacting' | 'hook' | 'permission' | 'retry';

interface RuntimeToolStatus {
  text: string;
  toolName?: string;
}

interface RuntimeTaskStatus {
  taskId?: string;
  text: string;
}

interface ActiveStreamToolUse {
  partialInput: string;
  toolName: string;
  updatedAt: number;
}

interface RuntimeUiStateTracker {
  activeStreamToolUses: Map<number, ActiveStreamToolUse>;
  loadingMessages: string[];
  sessionStatus: string | undefined;
  systemStatuses: Partial<Record<RuntimeSystemStatusKey, string>>;
  taskStatus: RuntimeTaskStatus | undefined;
  toolStatus: RuntimeToolStatus | undefined;
}

type StreamToolStartEvent = {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: string;
    name?: string;
  };
};

type StreamToolDeltaEvent = {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: string;
    partial_json?: string;
  };
};

type StreamToolStopEvent = {
  type: 'content_block_stop';
  index: number;
};

export class ClaudeAgentSdkExecutor implements ClaudeExecutor {
  constructor(private readonly logger: AppLogger) {}

  async execute(request: ClaudeExecutionRequest, sink: ClaudeExecutionSink): Promise<void> {
    this.logger.info('Claude Agent SDK execution requested for thread %s', request.threadTs);

    const mcpServer = this.createPublishStateMcpServer(request, sink);

    const prompt = this.buildPrompt(request);

    this.logger.info(
      'Creating Claude SDK query (thread %s, model=%s, maxTurns=%d, permissionMode=%s, resume=%s)',
      request.threadTs,
      env.CLAUDE_MODEL ?? 'default',
      env.CLAUDE_MAX_TURNS,
      env.CLAUDE_PERMISSION_MODE,
      request.resumeSessionId ?? 'none',
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
          systemPrompt: this.buildSystemPrompt(request),
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
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to create Claude SDK query (thread %s): %s', request.threadTs, msg);
      throw error;
    }

    let sessionId: string | undefined;
    const runtimeUi = this.createRuntimeUiStateTracker();

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
        await this.handleMessage(message, sink, {
          setSessionId: (id) => {
            sessionId = id;
          },
          publishUiState: async () => {
            await this.publishRuntimeUiState(request.threadTs, sink, runtimeUi);
          },
          runtimeUi,
        });
      }
      this.logger.info('Claude SDK message stream ended (thread %s)', request.threadTs);

      await sink.onEvent({
        type: 'lifecycle',
        phase: 'completed',
        ...(sessionId ? { sessionId } : {}),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Claude Agent SDK execution failed: %s', redact(errorMessage));
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: errorMessage,
      });
    }
  }

  private async handleMessage(
    message: SDKMessage,
    sink: ClaudeExecutionSink,
    handlers: {
      setSessionId: (id: string) => void;
      publishUiState: () => Promise<void>;
      runtimeUi: RuntimeUiStateTracker;
    },
  ): Promise<void> {
    switch (message.type) {
      case 'system': {
        const sub = (message as { subtype: string }).subtype;
        if (sub === 'init') {
          const sys = message as SDKSystemMessage;
          handlers.setSessionId(sys.session_id);
          this.logger.info(
            'Claude Code session init: id=%s model=%s cwd=%s',
            sys.session_id,
            sys.model,
            sys.cwd,
          );
        } else if (sub === 'api_retry') {
          const retry = message as SDKAPIRetryMessage;
          this.logger.warn(
            'Claude API retry %d/%d after %dms (http=%s error=%s)',
            retry.attempt,
            retry.max_retries,
            retry.retry_delay_ms,
            retry.error_status === null ? 'none' : String(retry.error_status),
            retry.error,
          );
          this.setSystemStatus(handlers.runtimeUi, 'retry', 'Retrying Claude API request...');
          this.rememberLoadingMessage(handlers.runtimeUi, 'Retrying Claude API request...');
          await handlers.publishUiState();
        } else if (sub === 'task_started') {
          const sys = message as SDKTaskStartedMessage;
          await sink.onEvent({
            type: 'task-update',
            taskId: sys.task_id,
            title: sys.description,
            status: 'in_progress',
          });
          this.clearSystemStatus(handlers.runtimeUi, 'hook');
          this.clearSystemStatus(handlers.runtimeUi, 'retry');
          this.setTaskStatus(handlers.runtimeUi, sys.description, sys.task_id);
          this.rememberLoadingMessage(handlers.runtimeUi, sys.description);
          await handlers.publishUiState();
        } else if (sub === 'task_progress') {
          const sys = message as SDKTaskProgressMessage;
          await sink.onEvent({
            type: 'task-update',
            taskId: sys.task_id,
            title: sys.description,
            status: 'in_progress',
            ...(sys.summary ? { details: sys.summary } : {}),
          });
          this.clearSystemStatus(handlers.runtimeUi, 'hook');
          this.clearSystemStatus(handlers.runtimeUi, 'retry');
          this.setTaskStatus(
            handlers.runtimeUi,
            sys.last_tool_name ? `Running ${sys.last_tool_name}...` : sys.description,
            sys.task_id,
          );
          this.rememberLoadingMessage(handlers.runtimeUi, sys.summary ?? sys.description);
          await handlers.publishUiState();
        } else if (sub === 'task_notification') {
          const sys = message as SDKTaskNotificationMessage;
          const status = sys.status === 'completed' ? ('complete' as const) : ('error' as const);
          await sink.onEvent({
            type: 'task-update',
            taskId: sys.task_id,
            title: sys.summary,
            status,
            ...(sys.output_file ? { output: sys.output_file } : {}),
          });
          this.clearTaskStatus(handlers.runtimeUi, sys.task_id);
          this.clearToolStatus(handlers.runtimeUi);
          await handlers.publishUiState();
        } else if (sub === 'status') {
          const sys = message as SDKStatusMessage;
          this.logger.info(
            'Claude session status update: status=%s permissionMode=%s',
            sys.status ?? 'idle',
            sys.permissionMode ?? 'unknown',
          );
          if (sys.status === 'compacting') {
            this.setSystemStatus(
              handlers.runtimeUi,
              'compacting',
              'Compacting conversation context...',
            );
            this.rememberLoadingMessage(handlers.runtimeUi, 'Compacting conversation context...');
          } else {
            this.clearSystemStatus(handlers.runtimeUi, 'compacting');
          }
          await handlers.publishUiState();
        } else if (sub === 'session_state_changed') {
          const sys = message as SDKSessionStateChangedMessage;
          this.logger.info('Claude session state changed: %s', sys.state);
          if (sys.state === 'running') {
            this.setSessionStatus(handlers.runtimeUi, 'Thinking...');
            this.clearSystemStatus(handlers.runtimeUi, 'permission');
          } else if (sys.state === 'requires_action') {
            this.setSystemStatus(handlers.runtimeUi, 'permission', 'Awaiting permission...');
            this.rememberLoadingMessage(handlers.runtimeUi, 'Waiting for permission approval...');
          } else {
            this.clearSystemStatus(handlers.runtimeUi, 'permission');
            this.clearSessionStatus(handlers.runtimeUi);
          }
          await handlers.publishUiState();
        } else if (sub === 'hook_progress') {
          const sys = message as SDKHookProgressMessage;
          const output = this.summarizeProgressOutput(sys.output || sys.stderr || sys.stdout);
          this.logger.info(
            'Claude hook progress: %s (%s)%s',
            sys.hook_name,
            sys.hook_event,
            output ? ` - ${redact(output)}` : '',
          );
          this.setSystemStatus(handlers.runtimeUi, 'hook', `Running ${sys.hook_name} hook...`);
          this.rememberLoadingMessage(
            handlers.runtimeUi,
            output || `Running ${sys.hook_name} hook...`,
          );
          await handlers.publishUiState();
        } else {
          this.logger.info('Unhandled Claude system message subtype: %s', sub);
        }
        break;
      }

      case 'assistant': {
        const assistant = message as SDKAssistantMessage;
        if (assistant.error) {
          this.logger.warn('Assistant message reported error=%s', assistant.error);
        }
        const completedText = this.extractAssistantText(assistant);
        if (completedText) {
          this.logger.info(
            'Assistant message completed; emitting Slack reply payload (%d chars)',
            completedText.length,
          );
          await sink.onEvent({ type: 'assistant-message', text: completedText });
        }
        break;
      }

      case 'auth_status': {
        const auth = message as SDKAuthStatusMessage;
        const output = auth.output.join('\n').trim();
        if (auth.error) {
          this.logger.error('Claude auth status error: %s', redact(auth.error));
        } else {
          this.logger.info('Claude auth status: authenticating=%s', String(auth.isAuthenticating));
          if (auth.isAuthenticating) {
            this.setSystemStatus(handlers.runtimeUi, 'auth', 'Authenticating Claude...');
            this.rememberLoadingMessage(handlers.runtimeUi, 'Authenticating Claude...');
          } else {
            this.clearSystemStatus(handlers.runtimeUi, 'auth');
          }
        }
        if (output) {
          this.logger.info('Claude auth status output: %s', redact(output));
          this.rememberLoadingMessage(handlers.runtimeUi, output);
        }
        await handlers.publishUiState();
        break;
      }

      case 'tool_progress': {
        const tool = message as SDKToolProgressMessage;
        this.logger.info(
          'Claude tool progress: %s (%ss elapsed)',
          tool.tool_name,
          tool.elapsed_time_seconds.toFixed(1),
        );
        await sink.onEvent({
          type: 'task-update',
          taskId: tool.task_id ?? tool.tool_use_id,
          title: `Running ${tool.tool_name}`,
          status: 'in_progress',
          details: `Elapsed ${tool.elapsed_time_seconds.toFixed(1)}s`,
        });
        this.clearSystemStatus(handlers.runtimeUi, 'hook');
        this.clearSystemStatus(handlers.runtimeUi, 'retry');
        this.setToolStatus(
          handlers.runtimeUi,
          `Running ${tool.tool_name} (${tool.elapsed_time_seconds.toFixed(1)}s)...`,
          tool.tool_name,
        );
        this.rememberLoadingMessage(
          handlers.runtimeUi,
          this.describeGenericToolActivity(tool.tool_name),
        );
        await handlers.publishUiState();
        break;
      }

      case 'stream_event': {
        const stream = message as SDKPartialAssistantMessage;
        if (this.applyStreamEventToUiState(handlers.runtimeUi, stream)) {
          await handlers.publishUiState();
        }
        break;
      }

      case 'result': {
        this.clearToolStatus(handlers.runtimeUi);
        this.clearSystemStatus(handlers.runtimeUi, 'hook');
        this.clearSystemStatus(handlers.runtimeUi, 'retry');
        this.clearSystemStatus(handlers.runtimeUi, 'compacting');
        this.handleResult(message as SDKResultMessage);
        break;
      }

      default: {
        const record = message as { type?: string };
        this.logger.info('Unhandled Claude SDK message type: %s', record.type ?? 'unknown');
      }
    }
  }

  private handleResult(message: SDKResultMessage): void {
    if (message.subtype === 'success') {
      this.logger.info(
        'Claude execution completed in %dms, cost $%s',
        message.duration_ms,
        message.total_cost_usd.toFixed(4),
      );
    } else {
      this.logger.warn(
        'Claude execution ended with %s: %s',
        message.subtype,
        message.errors.join('; '),
      );
    }
  }

  private createPublishStateMcpServer(request: ClaudeExecutionRequest, sink: ClaudeExecutionSink) {
    const logger = this.logger;

    return createSdkMcpServer({
      name: 'slack-ui',
      tools: [
        tool(
          SLACK_UI_STATE_TOOL_NAME,
          SLACK_UI_STATE_TOOL_DESCRIPTION,
          ClaudeUiStateToolInputShape,
          async (args) => {
            try {
              const state = parseSlackUiStateToolInput({
                ...args,
                threadTs: request.threadTs,
              });
              await sink.onEvent({ type: 'ui-state', state });
              return { content: [{ type: 'text' as const, text: 'UI state published.' }] };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn('publish_state validation failed: %s', msg);
              return {
                content: [{ type: 'text' as const, text: `Validation error: ${msg}` }],
                isError: true,
              };
            }
          },
        ),
      ],
    });
  }

  private buildPrompt(request: ClaudeExecutionRequest): string {
    if (request.resumeSessionId) {
      return request.mentionText;
    }

    const parts: string[] = [];

    if (request.threadContext.messages.length > 0) {
      parts.push(request.threadContext.renderedPrompt);
      parts.push('');
    }

    parts.push(`Current user message from <@${request.userId}>:`);
    parts.push(request.mentionText);

    return parts.join('\n');
  }

  private buildSystemPrompt(request: ClaudeExecutionRequest): string {
    return [
      'You are a helpful assistant in a Slack workspace.',
      `You are responding in channel ${request.channelId}, thread ${request.threadTs}.`,
      '',
      `You have access to the ${SLACK_UI_STATE_TOOL_NAME} tool to publish UI state updates to the Slack thread.`,
      'Use it to show progress indicators when performing long-running tasks.',
    ].join('\n');
  }

  private createRuntimeUiStateTracker(): RuntimeUiStateTracker {
    return {
      loadingMessages: [],
      sessionStatus: 'Thinking...',
      systemStatuses: {},
      taskStatus: undefined,
      toolStatus: undefined,
      activeStreamToolUses: new Map(),
    };
  }

  private async publishRuntimeUiState(
    threadTs: string,
    sink: ClaudeExecutionSink,
    runtimeUi: RuntimeUiStateTracker,
  ): Promise<void> {
    const state = this.buildRuntimeUiState(threadTs, runtimeUi);
    if (!state) {
      return;
    }

    await sink.onEvent({
      type: 'ui-state',
      state,
    });
  }

  private buildRuntimeUiState(
    threadTs: string,
    runtimeUi: RuntimeUiStateTracker,
  ): ClaudeUiState | undefined {
    const status = this.pickRuntimeStatus(runtimeUi);
    const loadingMessages = this.buildRuntimeLoadingMessages(runtimeUi, status);

    if (!status && loadingMessages.length === 0) {
      return undefined;
    }

    return {
      threadTs,
      ...(status ? { status } : {}),
      ...(loadingMessages.length > 0 ? { loadingMessages } : {}),
      clear: false,
    };
  }

  private pickRuntimeStatus(runtimeUi: RuntimeUiStateTracker): string {
    return this.normalizeUiStatus(
      runtimeUi.toolStatus?.text ??
        runtimeUi.taskStatus?.text ??
        this.pickRuntimeSystemStatus(runtimeUi) ??
        runtimeUi.sessionStatus ??
        'Thinking...',
    );
  }

  private pickRuntimeSystemStatus(runtimeUi: RuntimeUiStateTracker): string | undefined {
    return (
      runtimeUi.systemStatuses.permission ??
      runtimeUi.systemStatuses.auth ??
      runtimeUi.systemStatuses.compacting ??
      runtimeUi.systemStatuses.retry ??
      runtimeUi.systemStatuses.hook
    );
  }

  private buildRuntimeLoadingMessages(runtimeUi: RuntimeUiStateTracker, status: string): string[] {
    const streamToolMessages = [...runtimeUi.activeStreamToolUses.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((toolUse) => this.describeStreamToolUse(toolUse.toolName, toolUse.partialInput))
      .filter(Boolean);

    const merged = [...streamToolMessages, ...runtimeUi.loadingMessages];
    const normalized = merged
      .map((message) => this.normalizeLoadingMessage(message))
      .filter(Boolean);
    const deduped = [...new Set(normalized)].slice(0, 10);

    if (deduped.length > 0) {
      return deduped;
    }

    return status ? [this.normalizeLoadingMessage(status)] : [];
  }

  private setSessionStatus(runtimeUi: RuntimeUiStateTracker, status: string): void {
    runtimeUi.sessionStatus = this.normalizeUiStatus(status);
  }

  private clearSessionStatus(runtimeUi: RuntimeUiStateTracker): void {
    runtimeUi.sessionStatus = undefined;
  }

  private setSystemStatus(
    runtimeUi: RuntimeUiStateTracker,
    key: RuntimeSystemStatusKey,
    status: string,
  ): void {
    runtimeUi.systemStatuses[key] = this.normalizeUiStatus(status);
  }

  private clearSystemStatus(runtimeUi: RuntimeUiStateTracker, key: RuntimeSystemStatusKey): void {
    delete runtimeUi.systemStatuses[key];
  }

  private setTaskStatus(runtimeUi: RuntimeUiStateTracker, status: string, taskId?: string): void {
    runtimeUi.taskStatus = {
      text: this.normalizeUiStatus(status),
      ...(taskId ? { taskId } : {}),
    };
  }

  private clearTaskStatus(runtimeUi: RuntimeUiStateTracker, taskId?: string): void {
    if (!runtimeUi.taskStatus) {
      return;
    }

    if (!taskId || runtimeUi.taskStatus.taskId === taskId) {
      runtimeUi.taskStatus = undefined;
    }
  }

  private setToolStatus(runtimeUi: RuntimeUiStateTracker, status: string, toolName?: string): void {
    runtimeUi.toolStatus = {
      text: this.normalizeUiStatus(status),
      ...(toolName ? { toolName } : {}),
    };
  }

  private clearToolStatus(runtimeUi: RuntimeUiStateTracker, toolName?: string): void {
    if (!runtimeUi.toolStatus) {
      return;
    }

    if (!toolName || runtimeUi.toolStatus.toolName === toolName) {
      runtimeUi.toolStatus = undefined;
    }
  }

  private rememberLoadingMessage(runtimeUi: RuntimeUiStateTracker, message: string): void {
    const normalized = this.normalizeLoadingMessage(message);
    if (!normalized) {
      return;
    }

    runtimeUi.loadingMessages = [
      normalized,
      ...runtimeUi.loadingMessages.filter((existing) => existing !== normalized),
    ].slice(0, 10);
  }

  private applyStreamEventToUiState(
    runtimeUi: RuntimeUiStateTracker,
    message: SDKPartialAssistantMessage,
  ): boolean {
    const event = message.event as
      | StreamToolStartEvent
      | StreamToolDeltaEvent
      | StreamToolStopEvent;

    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      runtimeUi.activeStreamToolUses.set(event.index, {
        toolName: event.content_block.name ?? 'tool',
        partialInput: '',
        updatedAt: Date.now(),
      });
      return true;
    }

    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      const activeToolUse = runtimeUi.activeStreamToolUses.get(event.index);
      if (!activeToolUse) {
        return false;
      }

      activeToolUse.partialInput += event.delta.partial_json ?? '';
      activeToolUse.updatedAt = Date.now();
      return true;
    }

    if (event.type === 'content_block_stop') {
      const activeToolUse = runtimeUi.activeStreamToolUses.get(event.index);
      if (!activeToolUse) {
        return false;
      }

      runtimeUi.activeStreamToolUses.delete(event.index);
      this.clearToolStatus(runtimeUi, activeToolUse.toolName);
      return true;
    }

    return false;
  }

  private describeStreamToolUse(toolName: string, partialInput: string): string {
    const normalizedName = toolName.toLowerCase();

    if (normalizedName === 'readfile') {
      const targetPath = this.extractToolInputValue(partialInput, ['path']);
      return targetPath ? `Reading ${this.formatUiPath(targetPath)}...` : 'Reading a file...';
    }

    if (normalizedName === 'glob') {
      const pattern = this.extractToolInputValue(partialInput, ['glob_pattern']);
      return pattern ? `Finding files matching ${pattern}...` : 'Finding matching files...';
    }

    if (normalizedName === 'rg') {
      const pattern = this.extractToolInputValue(partialInput, ['pattern']);
      return pattern ? `Searching for ${pattern}...` : 'Searching the workspace...';
    }

    if (normalizedName === 'semanticsearch') {
      const queryText = this.extractToolInputValue(partialInput, ['query']);
      return queryText ? `Searching code for ${queryText}...` : 'Exploring relevant code...';
    }

    if (normalizedName === 'webfetch') {
      const url = this.extractToolInputValue(partialInput, ['url']);
      return url ? `Fetching ${this.formatUrlForUi(url)}...` : 'Fetching a webpage...';
    }

    if (normalizedName === 'shell') {
      const description = this.extractToolInputValue(partialInput, ['description']);
      if (description) {
        return `Running ${description}...`;
      }

      const command = this.extractToolInputValue(partialInput, ['command']);
      return command
        ? `Running ${this.formatCommandForUi(command)}...`
        : 'Running a shell command...';
    }

    if (normalizedName === 'callmcptool') {
      const server = this.extractToolInputValue(partialInput, ['server']);
      const mcpToolName = this.extractToolInputValue(partialInput, ['toolName', 'tool_name']);
      if (server && mcpToolName) {
        return `Calling ${mcpToolName} on ${server}...`;
      }

      return 'Calling an MCP tool...';
    }

    if (normalizedName === 'readlints') {
      return 'Checking linter diagnostics...';
    }

    if (normalizedName === 'applypatch') {
      return 'Applying code changes...';
    }

    if (normalizedName === 'editnotebook') {
      return 'Editing a notebook...';
    }

    if (normalizedName === 'askquestion') {
      return 'Waiting for user input...';
    }

    if (normalizedName === 'generateimage') {
      return 'Generating an image...';
    }

    if (normalizedName === 'multi_tool_use.parallel') {
      return 'Running parallel tool calls...';
    }

    return `Using ${toolName}...`;
  }

  private describeGenericToolActivity(toolName: string): string {
    return this.describeStreamToolUse(toolName, '');
  }

  private extractToolInputValue(partialInput: string, keys: string[]): string | undefined {
    const parsedInput = this.tryParseToolInput(partialInput);
    for (const key of keys) {
      const parsedValue = parsedInput?.[key];
      if (typeof parsedValue === 'string' && parsedValue.trim()) {
        return parsedValue.trim();
      }
    }

    for (const key of keys) {
      const pattern = new RegExp(`"${this.escapeRegExp(key)}"\\s*:\\s*"([^"]*)`);
      const match = partialInput.match(pattern);
      if (match?.[1]) {
        return this.unescapeJsonFragment(match[1]).trim();
      }
    }

    return undefined;
  }

  private tryParseToolInput(partialInput: string): Record<string, unknown> | undefined {
    const trimmed = partialInput.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private formatUiPath(targetPath: string): string {
    const normalized = targetPath.replaceAll('\\', '/').trim();
    if (!normalized) {
      return 'file';
    }

    const basename = path.posix.basename(normalized);
    const parent = path.posix.basename(path.posix.dirname(normalized));
    if (!parent || parent === '.' || parent === '/' || parent === basename) {
      return basename;
    }

    return `${parent}/${basename}`;
  }

  private formatUrlForUi(value: string): string {
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      return value;
    }
  }

  private formatCommandForUi(command: string): string {
    const normalized = command.trim().replaceAll(/\s+/g, ' ');
    if (!normalized) {
      return 'shell command';
    }

    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  private unescapeJsonFragment(value: string): string {
    return value.replaceAll('\\"', '"').replaceAll('\\\\', '\\').replaceAll('\\/', '/');
  }

  private escapeRegExp(value: string): string {
    return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
  }

  private extractAssistantText(message: SDKAssistantMessage): string {
    const content = Array.isArray(message.message.content) ? message.message.content : [];

    return content
      .flatMap((block) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return [block.text];
        }

        return [];
      })
      .join('');
  }

  private summarizeProgressOutput(text: string): string {
    const normalized = text.trim().replaceAll(/\s+/g, ' ');
    if (!normalized) {
      return '';
    }

    return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
  }

  private normalizeUiStatus(text: string): string {
    const normalized = text.trim().replaceAll(/\s+/g, ' ');
    if (!normalized) {
      return '';
    }

    return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
  }

  private normalizeLoadingMessage(text: string): string {
    const normalized = text.trim().replaceAll(/\s+/g, ' ');
    if (!normalized) {
      return '';
    }

    return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
  }
}
