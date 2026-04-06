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

  const botAuthored =
    Boolean(message.bot_id) || message.subtype === 'bot_message' || message.user === botUserId;
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
