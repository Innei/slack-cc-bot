import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import {
  createBotUserIdResolver,
  shouldSkipBotAuthoredMessage,
  shouldSkipBotAuthoredMessageFromUnjoinedSender,
  shouldSkipMessageForForeignMention,
} from '~/slack/ingress/message-filter.js';
import type { SlackWebClientLike } from '~/slack/types.js';

function createTestLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };
  logger.withTag.mockReturnValue(logger);
  return logger as unknown as AppLogger;
}

describe('shouldSkipBotAuthoredMessage', () => {
  it('skips messages with non-bot subtypes', () => {
    const logger = createTestLogger();
    const result = shouldSkipBotAuthoredMessage(
      logger,
      'test',
      'ts1',
      {
        text: 'hello',
        subtype: 'channel_join',
      },
      'U_BOT',
    );
    expect(result).toBe(true);
  });

  it('does not skip human-authored messages', () => {
    const logger = createTestLogger();
    const result = shouldSkipBotAuthoredMessage(
      logger,
      'test',
      'ts1',
      {
        text: 'hello',
        user: 'U_HUMAN',
      },
      'U_BOT',
    );
    expect(result).toBe(false);
  });

  it('skips bot-authored messages that do not mention the bot', () => {
    const logger = createTestLogger();
    const result = shouldSkipBotAuthoredMessage(
      logger,
      'test',
      'ts1',
      {
        text: 'status update',
        user: 'U_BOT',
      },
      'U_BOT',
    );
    expect(result).toBe(true);
  });

  it('skips self-authored bot messages even when they explicitly mention the bot', () => {
    const logger = createTestLogger();
    const result = shouldSkipBotAuthoredMessage(
      logger,
      'test',
      'ts1',
      {
        text: '<@U_BOT> continue please',
        user: 'U_BOT',
      },
      'U_BOT',
    );
    expect(result).toBe(true);
  });

  it('allows third-party bot messages that explicitly mention the bot', () => {
    const logger = createTestLogger();
    const result = shouldSkipBotAuthoredMessage(
      logger,
      'test',
      'ts1',
      {
        bot_id: 'B_OTHER',
        text: '<@U_BOT> continue please',
      },
      'U_BOT',
    );
    expect(result).toBe(false);
  });
});

describe('shouldSkipMessageForForeignMention', () => {
  it('returns false when message has no mentions', () => {
    const logger = createTestLogger();
    const result = shouldSkipMessageForForeignMention(
      logger,
      'test',
      'ts1',
      'hello world',
      'U_BOT',
    );
    expect(result).toBe(false);
  });

  it('returns false when only the bot is mentioned', () => {
    const logger = createTestLogger();
    const result = shouldSkipMessageForForeignMention(
      logger,
      'test',
      'ts1',
      '<@U_BOT> hello',
      'U_BOT',
    );
    expect(result).toBe(false);
  });

  it('returns true when another user is mentioned', () => {
    const logger = createTestLogger();
    const result = shouldSkipMessageForForeignMention(
      logger,
      'test',
      'ts1',
      'ask <@U456> to review',
      'U_BOT',
    );
    expect(result).toBe(true);
  });

  it('returns false when botUserId is undefined', () => {
    const logger = createTestLogger();
    const result = shouldSkipMessageForForeignMention(
      logger,
      'test',
      'ts1',
      '<@U456> hello',
      undefined,
    );
    expect(result).toBe(false);
  });
});

describe('shouldSkipBotAuthoredMessage edge cases', () => {
  it('skips messages with bot_id but no user field', () => {
    const logger = createTestLogger();
    const result = shouldSkipBotAuthoredMessage(
      logger,
      'test',
      'ts1',
      {
        text: 'automated message',
        bot_id: 'B123',
      },
      'U_BOT',
    );
    expect(result).toBe(true);
  });

  it('does not skip when botUserId is undefined and message has no bot markers', () => {
    const logger = createTestLogger();
    const result = shouldSkipBotAuthoredMessage(
      logger,
      'test',
      'ts1',
      {
        text: 'hello',
        user: 'U_HUMAN',
      },
      undefined,
    );
    expect(result).toBe(false);
  });
});

describe('shouldSkipMessageForForeignMention edge cases', () => {
  it('returns true when multiple users are mentioned and one is foreign', () => {
    const logger = createTestLogger();
    const result = shouldSkipMessageForForeignMention(
      logger,
      'test',
      'ts1',
      '<@U_BOT> and <@U456> please',
      'U_BOT',
    );
    expect(result).toBe(true);
  });
});

describe('shouldSkipBotAuthoredMessageFromUnjoinedSender', () => {
  it('allows bot-authored follow-ups from the thread root author', async () => {
    const logger = createTestLogger();
    const client = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            {
              text: '<@U_AGENT> start',
              ts: '1712345678.000100',
              user: 'U_TRIGGER',
            },
          ],
        }),
      },
    } as unknown as SlackWebClientLike;

    const result = await shouldSkipBotAuthoredMessageFromUnjoinedSender(
      logger,
      'test',
      client,
      'C123',
      '1712345678.000100',
      'U_TRIGGER',
    );

    expect(result).toBe(false);
  });

  it('allows bot-authored messages from a sender explicitly mentioned by another participant', async () => {
    const logger = createTestLogger();
    const client = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            {
              text: '<@U_AGENT> start',
              ts: '1712345678.000100',
              user: 'U_TRIGGER',
            },
            {
              text: '<@U_SENDER> join this thread',
              ts: '1712345678.000101',
              user: 'U_TRIGGER',
            },
          ],
        }),
      },
    } as unknown as SlackWebClientLike;

    const result = await shouldSkipBotAuthoredMessageFromUnjoinedSender(
      logger,
      'test',
      client,
      'C123',
      '1712345678.000100',
      'U_SENDER',
    );

    expect(result).toBe(false);
  });

  it('skips bot-authored messages from senders that are neither root author nor explicitly mentioned', async () => {
    const logger = createTestLogger();
    const client = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            {
              text: '<@U_AGENT> start',
              ts: '1712345678.000100',
              user: 'U_TRIGGER',
            },
          ],
        }),
      },
    } as unknown as SlackWebClientLike;

    const result = await shouldSkipBotAuthoredMessageFromUnjoinedSender(
      logger,
      'test',
      client,
      'C123',
      '1712345678.000100',
      'U_UNJOINED',
    );

    expect(result).toBe(true);
  });
});

describe('createBotUserIdResolver', () => {
  it('resolves and caches the bot user id', async () => {
    const logger = createTestLogger();
    const resolver = createBotUserIdResolver(logger);
    const client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    } as unknown as SlackWebClientLike;

    const first = await resolver(client);
    const second = await resolver(client);

    expect(first).toBe('U_BOT');
    expect(second).toBe('U_BOT');
    expect(client.auth!.test).toHaveBeenCalledOnce();
  });

  it('returns undefined when auth.test is not available', async () => {
    const logger = createTestLogger();
    const resolver = createBotUserIdResolver(logger);
    const client = {} as unknown as SlackWebClientLike;

    const result = await resolver(client);
    expect(result).toBeUndefined();
  });
});
