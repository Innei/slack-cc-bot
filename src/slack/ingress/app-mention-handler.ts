import type { AssistantThreadStartedMiddleware, AssistantUserMessageMiddleware } from '@slack/bolt';

import type { ClaudeExecutionEvent, ClaudeExecutor } from '../../claude/executor/types.js';
import type { AppLogger } from '../../logger/index.js';
import { redact } from '../../logger/redact.js';
import type { ClaudeUiState } from '../../schemas/claude/publish-state.js';
import { SlackAppMentionEventSchema } from '../../schemas/slack/app-mention-event.js';
import { SlackMessageSchema } from '../../schemas/slack/message.js';
import type { SessionStore } from '../../session/types.js';
import type { SlackThreadContextLoader } from '../context/thread-context-loader.js';
import type { SlackRenderer } from '../render/slack-renderer.js';
import type { SlackWebClientLike } from '../types.js';

interface AppMentionHandlerDependencies {
  claudeExecutor: ClaudeExecutor;
  logger: AppLogger;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
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

export function createAppMentionHandler(deps: AppMentionHandlerDependencies) {
  return async (args: { client: SlackWebClientLike; event: unknown }): Promise<void> => {
    const mention = SlackAppMentionEventSchema.parse(args.event);
    await handleThreadConversation(args.client, mention, deps, {
      logLabel: 'app mention',
      addAcknowledgementReaction: true,
      rootMessageTs: mention.ts,
    });
  };
}

export function createThreadReplyHandler(deps: AppMentionHandlerDependencies) {
  return async (args: { client: SlackWebClientLike; event: unknown }): Promise<void> => {
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
      args.client,
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
  deps: AppMentionHandlerDependencies,
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
  deps: AppMentionHandlerDependencies,
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
      args.client as SlackWebClientLike,
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

async function handleThreadConversation(
  client: SlackWebClientLike,
  message: {
    channel: string;
    team: string;
    text: string;
    thread_ts?: string | undefined;
    ts: string;
    user: string;
  },
  deps: AppMentionHandlerDependencies,
  options: {
    logLabel: string;
    addAcknowledgementReaction: boolean;
    rootMessageTs: string;
  },
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
  const resumeSessionId = existingSession?.claudeSessionId;

  if (options.addAcknowledgementReaction) {
    await deps.renderer.addAcknowledgementReaction(client, message.channel, message.ts);
  }

  if (existingSession) {
    deps.sessionStore.patch(threadTs, {
      channelId: message.channel,
    });
  } else {
    deps.sessionStore.upsert({
      channelId: message.channel,
      threadTs,
      rootMessageTs: options.rootMessageTs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  let activeUiState: ClaudeUiState | undefined = createDefaultThinkingUiState(threadTs);

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

  let lastUiStateKey: string | undefined;
  const sink = {
    onEvent: async (event: ClaudeExecutionEvent): Promise<void> => {
      if (event.type === 'assistant-message') {
        await deps.renderer.postThreadReply(client, message.channel, threadTs, event.text);
        activeUiState = createDefaultThinkingUiState(threadTs);
        lastUiStateKey = JSON.stringify(activeUiState);
        await deps.renderer.setUiState(client, message.channel, activeUiState).catch((error) => {
          deps.logger.warn('Failed to restore Slack thinking indicator: %s', String(error));
        });
        return;
      }

      if (event.type === 'ui-state') {
        const nextUiStateKey = JSON.stringify(event.state);
        if (nextUiStateKey === lastUiStateKey) {
          return;
        }
        lastUiStateKey = nextUiStateKey;
        activeUiState = event.state.clear ? undefined : event.state;
        await deps.renderer.setUiState(client, message.channel, event.state);
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
