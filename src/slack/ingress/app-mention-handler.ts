import type { AssistantThreadStartedMiddleware, AssistantUserMessageMiddleware } from '@slack/bolt';

import type { ClaudeExecutionEvent, ClaudeExecutor } from '../../claude/executor/types.js';
import type { AppLogger } from '../../logger/index.js';
import { redact } from '../../logger/redact.js';
import type { MemoryStore } from '../../memory/types.js';
import type { ClaudeUiState } from '../../schemas/claude/publish-state.js';
import { SlackAppMentionEventSchema } from '../../schemas/slack/app-mention-event.js';
import { SlackMessageSchema } from '../../schemas/slack/message.js';
import type { SessionRecord, SessionStore } from '../../session/types.js';
import type { WorkspaceResolver } from '../../workspace/resolver.js';
import type { ResolvedWorkspace, WorkspaceResolution } from '../../workspace/types.js';
import type { SlackThreadContextLoader } from '../context/thread-context-loader.js';
import { encodeWorkspacePickerButtonValue } from '../interactions/workspace-picker-payload.js';
import type { SlackRenderer } from '../render/slack-renderer.js';
import type { SlackBlock, SlackWebClientLike } from '../types.js';

export interface SlackIngressDependencies {
  claudeExecutor: ClaudeExecutor;
  logger: AppLogger;
  memoryStore: MemoryStore;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
  workspaceResolver: WorkspaceResolver;
}

export interface ThreadConversationMessage {
  channel: string;
  team: string;
  text: string;
  thread_ts?: string | undefined;
  ts: string;
  user: string;
}

interface ThreadConversationOptions {
  addAcknowledgementReaction: boolean;
  forceNewClaudeSession?: boolean;
  logLabel: string;
  rootMessageTs: string;
  workspaceOverride?: ResolvedWorkspace;
}

const DEFAULT_ASSISTANT_PROMPTS = [
  {
    title: 'Summarize a thread',
    message: 'Please summarize the latest discussion in this thread.',
  },
  {
    title: 'Review code changes',
    message: 'Please review the recent code changes and call out risks.',
  },
  {
    title: 'Draft a plan',
    message: 'Please create an implementation plan for this task.',
  },
] as const;

export function createAppMentionHandler(deps: SlackIngressDependencies) {
  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const mention = SlackAppMentionEventSchema.parse(args.event);
    await handleThreadConversation(args.client as SlackWebClientLike, mention, deps, {
      logLabel: 'app mention',
      addAcknowledgementReaction: true,
      rootMessageTs: mention.ts,
    });
  };
}

export function createThreadReplyHandler(deps: SlackIngressDependencies) {
  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const parsed = SlackMessageSchema.safeParse(args.event);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    const threadTs = message.thread_ts;

    if (!threadTs) {
      return;
    }

    if (!message.user || message.bot_id || message.subtype) {
      return;
    }

    const session = deps.sessionStore.get(threadTs);
    if (!session) {
      return;
    }

    const channelId = typeof message.channel === 'string' ? message.channel : undefined;
    const teamId = typeof message.team === 'string' ? message.team : undefined;
    if (!channelId || !teamId) {
      runtimeError(
        deps.logger,
        'Skipping thread reply without channel/team id for thread %s',
        threadTs,
      );
      return;
    }

    await handleThreadConversation(
      args.client as SlackWebClientLike,
      {
        channel: channelId,
        team: teamId,
        text: message.text,
        thread_ts: threadTs,
        ts: message.ts,
        user: message.user,
      },
      deps,
      {
        logLabel: 'thread reply',
        addAcknowledgementReaction: false,
        rootMessageTs: session.rootMessageTs,
      },
    );
  };
}

export function createAssistantThreadStartedHandler(
  deps: SlackIngressDependencies,
): AssistantThreadStartedMiddleware {
  return async ({ logger, setSuggestedPrompts }) => {
    try {
      await setSuggestedPrompts({
        title: 'Try asking me to...',
        prompts: [...DEFAULT_ASSISTANT_PROMPTS],
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      runtimeError(
        deps.logger,
        'Failed to configure assistant thread prompts: %s',
        redact(errorMessage),
      );
      logger.error('Failed to configure assistant thread prompts: %s', errorMessage);
    }
  };
}

export function createAssistantUserMessageHandler(
  deps: SlackIngressDependencies,
): AssistantUserMessageMiddleware {
  return async (args) => {
    const parsed = SlackMessageSchema.safeParse(args.message);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    const threadTs = message.thread_ts;
    const channelId = typeof message.channel === 'string' ? message.channel : undefined;
    const teamId =
      typeof args.context.teamId === 'string'
        ? args.context.teamId
        : typeof args.body.team_id === 'string'
          ? args.body.team_id
          : undefined;
    const userId =
      typeof args.context.userId === 'string'
        ? args.context.userId
        : typeof message.user === 'string'
          ? message.user
          : undefined;

    if (!threadTs || !channelId || !teamId || !userId || !message.text.trim()) {
      runtimeError(
        deps.logger,
        'Skipping assistant message without required identifiers (channel=%s thread=%s team=%s user=%s)',
        channelId ?? 'missing',
        threadTs ?? 'missing',
        teamId ?? 'missing',
        userId ?? 'missing',
      );
      return;
    }

    const existingSession = deps.sessionStore.get(threadTs);
    if (!existingSession) {
      await args.setTitle(message.text).catch((error: unknown) => {
        deps.logger.warn('Failed to set assistant thread title: %s', String(error));
      });
    }

    await handleThreadConversation(
      args.client as unknown as SlackWebClientLike,
      {
        channel: channelId,
        team: teamId,
        text: message.text,
        thread_ts: threadTs,
        ts: message.ts,
        user: userId,
      },
      deps,
      {
        logLabel: 'assistant user message',
        addAcknowledgementReaction: false,
        rootMessageTs: threadTs,
      },
    );
  };
}

export async function handleThreadConversation(
  client: SlackWebClientLike,
  message: ThreadConversationMessage,
  deps: SlackIngressDependencies,
  options: ThreadConversationOptions,
): Promise<void> {
  const threadTs = message.thread_ts ?? message.ts;

  runtimeInfo(
    deps.logger,
    'Received %s in channel %s, root ts %s, thread ts %s',
    options.logLabel,
    message.channel,
    message.ts,
    threadTs,
  );

  const existingSession = deps.sessionStore.get(threadTs);

  if (options.addAcknowledgementReaction) {
    await deps.renderer.addAcknowledgementReaction(client, message.channel, message.ts);
  }

  const workspaceResolution = resolveWorkspaceForConversation(
    message.text,
    existingSession,
    deps.workspaceResolver,
    options.workspaceOverride,
  );

  if (workspaceResolution.status !== 'unique') {
    runtimeWarn(
      deps.logger,
      'Unable to resolve workspace for thread %s (%s)',
      threadTs,
      workspaceResolution.reason,
    );
    const { blocks, text } = buildWorkspaceResolutionBlocks(workspaceResolution, message.text);
    await client.chat.postMessage({
      blocks,
      channel: message.channel,
      text,
      thread_ts: threadTs,
    });
    return;
  }

  const workspace = workspaceResolution.workspace;
  const shouldResetClaudeSession =
    options.forceNewClaudeSession === true ||
    Boolean(
      existingSession?.claudeSessionId && existingSession.workspacePath !== workspace.workspacePath,
    );
  const resumeSessionId = shouldResetClaudeSession ? undefined : existingSession?.claudeSessionId;

  if (existingSession) {
    deps.sessionStore.patch(threadTs, {
      channelId: message.channel,
      rootMessageTs: options.rootMessageTs,
      workspaceLabel: workspace.workspaceLabel,
      workspacePath: workspace.workspacePath,
      workspaceRepoId: workspace.repo.id,
      workspaceRepoPath: workspace.repo.repoPath,
      workspaceSource: workspace.source,
      ...(shouldResetClaudeSession ? { claudeSessionId: undefined } : {}),
    });
  } else {
    deps.sessionStore.upsert({
      channelId: message.channel,
      threadTs,
      rootMessageTs: options.rootMessageTs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceLabel: workspace.workspaceLabel,
      workspacePath: workspace.workspacePath,
      workspaceRepoId: workspace.repo.id,
      workspaceRepoPath: workspace.repo.repoPath,
      workspaceSource: workspace.source,
    });
  }

  let activeUiState: ClaudeUiState | undefined = createDefaultThinkingUiState(threadTs);
  let progressMessageTs: string | undefined;
  let progressMessageActive = false;

  await deps.renderer.showThinkingIndicator(client, message.channel, threadTs).catch((error) => {
    deps.logger.warn('Failed to show Slack thinking indicator: %s', String(error));
  });

  runtimeInfo(deps.logger, 'Loading thread context for %s', threadTs);
  const threadContext = await deps.threadContextLoader.loadThread(
    client,
    message.channel,
    threadTs,
  );
  runtimeInfo(
    deps.logger,
    'Thread context loaded for %s (%d messages)',
    threadTs,
    threadContext.messages.length,
  );

  const recentMemories = deps.memoryStore.listRecent(workspace.repo.id, 15);

  let lastUiStateKey: string | undefined;
  let lastAssistantMessage: string | undefined;
  const defaultThinkingUiState = createDefaultThinkingUiState(threadTs);
  const defaultThinkingUiStateKey = JSON.stringify(defaultThinkingUiState);
  const isMeaningfulRuntimeUiState = (state: ClaudeUiState): boolean => {
    if (state.clear) {
      return false;
    }

    if (JSON.stringify(state) === defaultThinkingUiStateKey) {
      return false;
    }

    const normalizedStatus = state.status?.trim();
    if (normalizedStatus && normalizedStatus !== defaultThinkingUiState.status) {
      return true;
    }

    const meaningfulLoadingMessage = state.loadingMessages?.some((message) => {
      const normalizedMessage = message.trim();
      return (
        normalizedMessage.length > 0 &&
        normalizedMessage !== normalizedStatus &&
        !(defaultThinkingUiState.loadingMessages ?? []).includes(normalizedMessage)
      );
    });

    return meaningfulLoadingMessage === true;
  };
  const updateInFlightIndicator = async (state: ClaudeUiState): Promise<void> => {
    if (progressMessageActive) {
      progressMessageTs = await deps.renderer.upsertThreadProgressMessage(
        client,
        message.channel,
        threadTs,
        state,
        progressMessageTs,
      );
      return;
    }

    await deps.renderer.setUiState(client, message.channel, state);
  };
  const activateProgressMessage = async (state: ClaudeUiState): Promise<void> => {
    if (!progressMessageActive) {
      progressMessageActive = true;
      await deps.renderer.clearUiState(client, message.channel, threadTs).catch((error) => {
        deps.logger.warn('Failed to clear fallback Slack thinking indicator: %s', String(error));
      });
    }

    progressMessageTs = await deps.renderer.upsertThreadProgressMessage(
      client,
      message.channel,
      threadTs,
      state,
      progressMessageTs,
    );
  };
  const sink = {
    onEvent: async (event: ClaudeExecutionEvent): Promise<void> => {
      if (event.type === 'assistant-message') {
        lastAssistantMessage = event.text;
        await deps.renderer.postThreadReply(client, message.channel, threadTs, event.text);
        if (progressMessageActive && progressMessageTs) {
          await deps.renderer
            .deleteThreadProgressMessage(client, message.channel, threadTs, progressMessageTs)
            .catch((error) => {
              deps.logger.warn(
                'Failed to reset thread progress message after assistant reply: %s',
                String(error),
              );
            });
          progressMessageTs = undefined;
          progressMessageActive = false;
        } else {
          activeUiState = defaultThinkingUiState;
          lastUiStateKey = defaultThinkingUiStateKey;
          await updateInFlightIndicator(activeUiState).catch((error) => {
            deps.logger.warn('Failed to restore Slack thinking indicator: %s', String(error));
          });
        }
        return;
      }

      if (event.type === 'ui-state') {
        const nextUiStateKey = JSON.stringify(event.state);
        if (nextUiStateKey === lastUiStateKey) {
          return;
        }
        lastUiStateKey = nextUiStateKey;
        activeUiState = event.state.clear ? undefined : event.state;

        if (event.state.clear) {
          if (progressMessageActive && progressMessageTs) {
            await deps.renderer.deleteThreadProgressMessage(
              client,
              message.channel,
              threadTs,
              progressMessageTs,
            );
            progressMessageTs = undefined;
            progressMessageActive = false;
            return;
          }

          await deps.renderer.clearUiState(client, message.channel, threadTs);
          return;
        }

        if (!progressMessageActive && isMeaningfulRuntimeUiState(event.state)) {
          await activateProgressMessage(event.state);
          return;
        }

        await updateInFlightIndicator(event.state);
        return;
      }

      if (event.type === 'task-update') {
        return;
      }

      if (event.sessionId) {
        deps.sessionStore.patch(threadTs, { claudeSessionId: event.sessionId });
      }

      if (event.phase === 'started') {
        return;
      }

      if (event.phase === 'completed') {
        if (lastAssistantMessage?.trim()) {
          deps.memoryStore.save({
            repoId: workspace.repo.id,
            threadTs,
            category: 'task_completed',
            content: truncateForMemory(lastAssistantMessage),
          });
        }
        return;
      }

      if (event.phase === 'failed') {
        runtimeError(
          deps.logger,
          'Execution failed for thread %s: %s',
          threadTs,
          redact(String(event.error ?? '')),
        );
        activeUiState = undefined;
        await deps.renderer.postThreadReply(
          client,
          message.channel,
          threadTs,
          'An error occurred while processing your request.',
        );
      }
    },
  };

  try {
    runtimeInfo(deps.logger, 'Starting Claude execution for thread %s', threadTs);
    await deps.claudeExecutor.execute(
      {
        channelId: message.channel,
        threadTs,
        userId: message.user,
        mentionText: message.text,
        threadContext,
        recentMemories,
        workspaceLabel: workspace.workspaceLabel,
        workspacePath: workspace.workspacePath,
        workspaceRepoId: workspace.repo.id,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      },
      sink,
    );
    runtimeInfo(deps.logger, 'Claude execution completed for thread %s', threadTs);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    runtimeError(
      deps.logger,
      'Claude execution failed for thread %s: %s',
      threadTs,
      redact(errorMessage),
    );
    activeUiState = undefined;
    await deps.renderer.postThreadReply(
      client,
      message.channel,
      threadTs,
      'An error occurred while processing your request.',
    );
  } finally {
    await deps.renderer.clearUiState(client, message.channel, threadTs).catch((err) => {
      deps.logger.warn('Failed to clear UI state: %s', String(err));
    });
    if (progressMessageTs) {
      await deps.renderer
        .deleteThreadProgressMessage(client, message.channel, threadTs, progressMessageTs)
        .catch((err) => {
          deps.logger.warn('Failed to delete progress message: %s', String(err));
        });
    }
  }
}

function runtimeInfo(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.info(message, ...args);
  console.info(message, ...args);
}

function runtimeError(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.error(message, ...args);
  console.error(message, ...args);
}

function runtimeWarn(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.warn(message, ...args);
  console.warn(message, ...args);
}

function createDefaultThinkingUiState(threadTs: string): ClaudeUiState {
  return {
    threadTs,
    status: 'Thinking...',
    loadingMessages: [
      'Reading the thread context...',
      'Planning the next steps...',
      'Generating a response...',
    ],
    clear: false,
  };
}

function truncateForMemory(value: string, maxLength = 500): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveWorkspaceForConversation(
  messageText: string,
  existingSession: SessionRecord | undefined,
  workspaceResolver: WorkspaceResolver,
  workspaceOverride?: ResolvedWorkspace,
): WorkspaceResolution {
  if (workspaceOverride) {
    return {
      status: 'unique',
      workspace: workspaceOverride,
    };
  }

  if (
    existingSession?.workspacePath &&
    existingSession.workspaceRepoId &&
    existingSession.workspaceRepoPath &&
    existingSession.workspaceLabel
  ) {
    return {
      status: 'unique',
      workspace: {
        input: existingSession.workspacePath,
        matchKind:
          existingSession.workspacePath === existingSession.workspaceRepoPath ? 'repo' : 'path',
        repo: {
          aliases: [],
          id: existingSession.workspaceRepoId,
          label: existingSession.workspaceRepoId,
          name:
            existingSession.workspaceRepoId.split('/').at(-1) ?? existingSession.workspaceRepoId,
          repoPath: existingSession.workspaceRepoPath,
          relativePath: existingSession.workspaceRepoId,
        },
        source: existingSession.workspaceSource ?? 'manual',
        workspaceLabel: existingSession.workspaceLabel,
        workspacePath: existingSession.workspacePath,
      },
    };
  }

  return workspaceResolver.resolveFromText(messageText, 'auto');
}

export const WORKSPACE_PICKER_ACTION_ID = 'workspace_picker_open_modal';

function buildWorkspaceResolutionBlocks(
  resolution: Exclude<WorkspaceResolution, { status: 'unique' }>,
  originalMessageText: string,
): { blocks: SlackBlock[]; text: string } {
  let text: string;

  if (resolution.status === 'ambiguous') {
    const labels = resolution.candidates
      .slice(0, 5)
      .map((candidate) => `\`${candidate.label}\``)
      .join(', ');
    text = `I couldn't tell which repository to use — matched: ${labels}`;
  } else {
    text = "I couldn't determine which repository to use for this thread.";
  }

  return {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        block_id: 'workspace_picker',
        elements: [
          {
            action_id: WORKSPACE_PICKER_ACTION_ID,
            style: 'primary',
            text: { type: 'plain_text' as const, text: 'Choose Workspace' },
            type: 'button' as const,
            value: encodeWorkspacePickerButtonValue(originalMessageText),
          },
        ],
      },
    ],
    text,
  };
}
