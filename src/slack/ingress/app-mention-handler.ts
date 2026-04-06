import type { AssistantThreadStartedMiddleware, AssistantUserMessageMiddleware } from '@slack/bolt';

import { redact } from '~/logger/redact.js';
import { runtimeError } from '~/logger/runtime.js';
import { zodParse } from '~/schemas/safe-parse.js';
import { SlackAppMentionEventSchema } from '~/schemas/slack/app-mention-event.js';
import { SlackMessageSchema } from '~/schemas/slack/message.js';

import type { SlackWebClientLike } from '../types.js';
import { handleThreadConversation } from './conversation-pipeline.js';
import {
  createBotUserIdResolver,
  shouldSkipBotAuthoredMessage,
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
  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const mention = zodParse(SlackAppMentionEventSchema, args.event, 'SlackAppMentionEvent');
    await handleThreadConversation(args.client as SlackWebClientLike, mention, deps, {
      logLabel: 'app mention',
      addAcknowledgementReaction: true,
      rootMessageTs: mention.ts,
    });
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

    const botUserId = await getBotUserId(client);
    const senderId = message.user?.trim() || message.bot_id?.trim();
    if (!senderId) {
      return;
    }

    if (shouldSkipBotAuthoredMessage(deps.logger, 'thread reply', threadTs, message, botUserId)) {
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
