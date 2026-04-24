import type { AppLogger } from '~/logger/index.js';
import { runtimeInfo, runtimeWarn } from '~/logger/runtime.js';

import type { SlackWebClientLike } from '../types.js';

const SLACK_USER_MENTION_PATTERN = /<@([\dA-Z]+)>/g;

export function createBotUserIdResolver(
  logger: AppLogger,
): (client: SlackWebClientLike) => Promise<string | undefined> {
  let cachedBotUserId: Promise<string | undefined> | undefined;

  return async (client: SlackWebClientLike): Promise<string | undefined> => {
    if (!cachedBotUserId) {
      cachedBotUserId = resolveBotUserId(client, logger);
    }
    return cachedBotUserId;
  };
}

export function shouldSkipBotAuthoredMessage(
  logger: AppLogger,
  logLabel: string,
  threadTs: string,
  message: {
    bot_id?: string | undefined;
    subtype?: string | undefined;
    text: string;
    user?: string | undefined;
  },
  botUserId: string | undefined,
): boolean {
  if (message.subtype && message.subtype !== 'bot_message' && message.subtype !== 'file_share') {
    return true;
  }

  if (botUserId && message.user === botUserId) {
    runtimeInfo(
      logger,
      'Skipping %s for thread %s because message was authored by this app itself',
      logLabel,
      threadTs,
    );
    return true;
  }

  const botAuthored = Boolean(message.bot_id) || message.subtype === 'bot_message';
  if (!botAuthored) {
    return false;
  }

  if (mentionsUser(message.text, botUserId)) {
    return false;
  }

  runtimeInfo(
    logger,
    'Skipping %s for thread %s because bot-authored message does not mention this app',
    logLabel,
    threadTs,
  );
  return true;
}

export function shouldSkipMessageForForeignMention(
  logger: AppLogger,
  logLabel: string,
  threadTs: string,
  messageText: string,
  botUserId: string | undefined,
): boolean {
  if (!messageText.includes('<@') || !botUserId) {
    return false;
  }

  const foreignMentionedUserId = getForeignMentionedUserId(messageText, botUserId);
  if (!foreignMentionedUserId) {
    return false;
  }

  runtimeInfo(
    logger,
    'Skipping %s for thread %s because mention targets another user: %s',
    logLabel,
    threadTs,
    foreignMentionedUserId,
  );
  return true;
}

export async function shouldSkipBotAuthoredMessageFromUnjoinedSender(
  logger: AppLogger,
  logLabel: string,
  client: SlackWebClientLike,
  channelId: string,
  threadTs: string,
  senderUserId: string | undefined,
): Promise<boolean> {
  if (!senderUserId || !senderUserId.startsWith('U')) {
    runtimeInfo(
      logger,
      'Skipping %s for thread %s because bot-authored sender cannot be matched to a Slack user mention',
      logLabel,
      threadTs,
    );
    return true;
  }

  try {
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: 200,
    });

    for (const raw of response.messages ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const message = raw as {
        bot_id?: unknown;
        subtype?: unknown;
        text?: unknown;
        ts?: unknown;
        user?: unknown;
      };
      const text = typeof message.text === 'string' ? message.text : '';
      const ts = typeof message.ts === 'string' ? message.ts : undefined;
      const user = typeof message.user === 'string' ? message.user : undefined;
      if (ts === threadTs && user === senderUserId) {
        return false;
      }
      const externallyAuthored = Boolean(user) && user !== senderUserId;
      if (externallyAuthored && mentionsUser(text, senderUserId)) {
        return false;
      }
    }
  } catch (error) {
    runtimeWarn(
      logger,
      'Failed to verify joined bot sender for %s in thread %s: %s',
      logLabel,
      threadTs,
      String(error),
    );
  }

  runtimeInfo(
    logger,
    'Skipping %s for thread %s because bot-authored sender %s has not been explicitly mentioned by a user in this thread',
    logLabel,
    threadTs,
    senderUserId,
  );
  return true;
}

async function resolveBotUserId(
  client: SlackWebClientLike,
  logger: AppLogger,
): Promise<string | undefined> {
  if (!client.auth?.test) {
    runtimeWarn(logger, 'Slack client does not expose auth.test; mention filtering disabled');
    return undefined;
  }

  try {
    const identity = await client.auth.test();
    const botUserId = identity.user_id?.trim();
    if (!botUserId) {
      runtimeWarn(
        logger,
        'Slack auth.test did not return a bot user id; mention filtering disabled',
      );
      return undefined;
    }
    return botUserId;
  } catch (error) {
    runtimeWarn(logger, 'Failed to resolve bot user id for mention filtering: %s', String(error));
    return undefined;
  }
}

function getForeignMentionedUserId(messageText: string, botUserId: string): string | undefined {
  for (const match of messageText.matchAll(SLACK_USER_MENTION_PATTERN)) {
    const mentionedUserId = match[1]?.trim();
    if (mentionedUserId && mentionedUserId !== botUserId) {
      return mentionedUserId;
    }
  }
  return undefined;
}

function mentionsUser(messageText: string, userId: string | undefined): boolean {
  if (!userId) {
    return false;
  }
  return messageText.includes(`<@${userId}>`);
}
