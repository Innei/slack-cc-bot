import type { AssistantThreadStartedMiddleware, AssistantUserMessageMiddleware } from '@slack/bolt';

import { redact } from '~/logger/redact.js';
import { runtimeError, runtimeInfo, runtimeWarn } from '~/logger/runtime.js';
import { zodParse } from '~/schemas/safe-parse.js';
import { SlackAppMentionEventSchema } from '~/schemas/slack/app-mention-event.js';
import { SlackMessageSchema } from '~/schemas/slack/message.js';

import type { SlackWebClientLike } from '../types.js';
import { handleThreadConversation } from './conversation-pipeline.js';
import {
  createBotUserIdResolver,
  shouldSkipBotAuthoredMessage,
  shouldSkipBotAuthoredMessageFromUnjoinedSender,
  shouldSkipMessageForForeignMention,
} from './message-filter.js';
import type { SlackIngressDependencies } from './types.js';

export { handleThreadConversation } from './conversation-pipeline.js';
export type { SlackIngressDependencies, ThreadConversationMessage } from './types.js';
export { WORKSPACE_PICKER_ACTION_ID } from './workspace-resolution.js';

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
  const getBotUserId = createBotUserIdResolver(deps.logger);

  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const mention = zodParse(SlackAppMentionEventSchema, args.event, 'SlackAppMentionEvent');
    const client = args.client as SlackWebClientLike;
    const threadTs = mention.thread_ts ?? mention.ts;
    const botUserId = await getBotUserId(client);
    const rawMention = mention as {
      bot_id?: string | undefined;
      subtype?: string | undefined;
    };
    const botAuthored = Boolean(rawMention.bot_id) || rawMention.subtype === 'bot_message';

    if (
      shouldSkipBotAuthoredMessage(
        deps.logger,
        'app mention',
        threadTs,
        {
          bot_id: rawMention.bot_id,
          subtype: rawMention.subtype,
          text: mention.text,
          user: mention.user,
        },
        botUserId,
      )
    ) {
      return;
    }

    const existingSession = deps.sessionStore.get(threadTs);
    if (
      botAuthored &&
      existingSession &&
      (await shouldSkipBotAuthoredMessageFromUnjoinedSender(
        deps.logger,
        'app mention',
        client,
        mention.channel,
        threadTs,
        mention.user,
      ))
    ) {
      return;
    }

    await handleThreadConversation(
      client,
      {
        channel: mention.channel,
        files: mention.files,
        team: mention.team,
        text: mention.text,
        thread_ts: mention.thread_ts,
        ts: mention.ts,
        user: mention.user,
      },
      deps,
      {
        logLabel: 'app mention',
        addAcknowledgementReaction: true,
        currentBotUserId: botUserId,
        rootMessageTs: mention.ts,
      },
    );
  };
}

export function createThreadReplyHandler(deps: SlackIngressDependencies) {
  const getBotUserId = createBotUserIdResolver(deps.logger);

  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const parsed = SlackMessageSchema.safeParse(args.event);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    const threadTs = message.thread_ts;
    const client = args.client as SlackWebClientLike;

    if (!threadTs) {
      runtimeInfo(
        deps.logger,
        'Ignoring message event %s because it is not a thread reply',
        message.ts,
      );
      return;
    }

    if (message.user && !message.bot_id && !message.subtype) {
      const handledUserInput = await maybeHandlePendingUserInputReply(
        client,
        {
          channelId: typeof message.channel === 'string' ? message.channel : undefined,
          text: message.text,
          threadTs,
          userId: message.user,
        },
        deps,
      );
      if (handledUserInput) {
        return;
      }
    }

    const session = deps.sessionStore.get(threadTs);
    if (!session) {
      runtimeWarn(
        deps.logger,
        'Ignoring thread reply %s in thread %s because no persisted session was found',
        message.ts,
        threadTs,
      );
      return;
    }

    const channelId =
      typeof message.channel === 'string' && message.channel.trim()
        ? message.channel
        : session.channelId;
    const teamId = typeof message.team === 'string' ? message.team : undefined;
    if (!channelId) {
      runtimeError(deps.logger, 'Skipping thread reply without channel id for thread %s', threadTs);
      return;
    }
    if (typeof message.channel !== 'string' || !message.channel.trim()) {
      runtimeWarn(
        deps.logger,
        'Thread reply missing channel id for thread %s; falling back to session channel %s',
        threadTs,
        session.channelId,
      );
    }
    if (!teamId) {
      runtimeWarn(
        deps.logger,
        'Thread reply missing team id for thread %s; continuing without it',
        threadTs,
      );
    }

    const botUserId = await getBotUserId(client);
    const senderId = message.user?.trim() || message.bot_id?.trim();
    if (!senderId) {
      runtimeWarn(
        deps.logger,
        'Ignoring thread reply %s in thread %s because sender id is missing',
        message.ts,
        threadTs,
      );
      return;
    }

    if (shouldSkipBotAuthoredMessage(deps.logger, 'thread reply', threadTs, message, botUserId)) {
      return;
    }

    const botAuthored = Boolean(message.bot_id) || message.subtype === 'bot_message';
    if (
      botAuthored &&
      (await shouldSkipBotAuthoredMessageFromUnjoinedSender(
        deps.logger,
        'thread reply',
        client,
        channelId,
        threadTs,
        typeof message.user === 'string' ? message.user : undefined,
      ))
    ) {
      return;
    }

    if (
      shouldSkipMessageForForeignMention(
        deps.logger,
        'thread reply',
        threadTs,
        message.text,
        botUserId,
      )
    ) {
      return;
    }

    await handleThreadConversation(
      client,
      {
        channel: channelId,
        files: message.files,
        team: teamId,
        text: message.text,
        thread_ts: threadTs,
        ts: message.ts,
        user: senderId,
      },
      deps,
      {
        logLabel: 'thread reply',
        addAcknowledgementReaction: false,
        currentBotUserId: botUserId,
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
  const getBotUserId = createBotUserIdResolver(deps.logger);

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

    const hasTextOrFiles = message.text.trim() || (message.files && message.files.length > 0);
    if (!threadTs || !channelId || !teamId || !userId || !hasTextOrFiles) {
      runtimeError(
        deps.logger,
        'Skipping assistant message without required identifiers (channel=%s thread=%s team=%s user=%s hasContent=%s)',
        channelId ?? 'missing',
        threadTs ?? 'missing',
        teamId ?? 'missing',
        userId ?? 'missing',
        String(hasTextOrFiles),
      );
      return;
    }

    const handledUserInput = await maybeHandlePendingUserInputReply(
      args.client as unknown as SlackWebClientLike,
      {
        channelId,
        text: message.text,
        threadTs,
        userId,
      },
      deps,
    );
    if (handledUserInput) {
      return;
    }

    const client = args.client as unknown as SlackWebClientLike;
    const botUserId = await getBotUserId(client);
    if (
      shouldSkipMessageForForeignMention(
        deps.logger,
        'assistant user message',
        threadTs,
        message.text,
        botUserId,
      )
    ) {
      return;
    }

    const existingSession = deps.sessionStore.get(threadTs);
    if (!existingSession) {
      await args.setTitle(message.text).catch((error: unknown) => {
        deps.logger.warn('Failed to set assistant thread title: %s', String(error));
      });
    }

    await handleThreadConversation(
      client,
      {
        channel: channelId,
        files: message.files,
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

async function maybeHandlePendingUserInputReply(
  client: SlackWebClientLike,
  input: {
    channelId?: string | undefined;
    text: string;
    threadTs: string;
    userId: string;
  },
  deps: SlackIngressDependencies,
): Promise<boolean> {
  if (!deps.userInputBridge.hasPending(input.threadTs)) {
    return false;
  }

  const result = deps.userInputBridge.submitReply({
    text: input.text,
    threadTs: input.threadTs,
    userId: input.userId,
  });
  if (!result.handled) {
    return false;
  }

  if (result.feedback && input.channelId) {
    await deps.renderer.postThreadReply(client, input.channelId, input.threadTs, result.feedback);
  }

  return true;
}
