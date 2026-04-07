import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';

describe('SlackUserInputBridge', () => {
  it('rejects replies from a different user while keeping the question pending', async () => {
    const bridge = new SlackUserInputBridge(createTestLogger());
    const pending = bridge.awaitAnswer({
      expectedUserId: 'U123',
      question: {
        header: 'Calendar',
        options: [
          { description: 'Use Gregorian', label: 'Gregorian' },
          { description: 'Use Lunar', label: 'Lunar' },
        ],
        question: 'Which calendar should I use?',
      },
      threadTs: 'thread-1',
    });

    const wrongUserReply = bridge.submitReply({
      text: '1',
      threadTs: 'thread-1',
      userId: 'U999',
    });
    expect(wrongUserReply).toMatchObject({
      feedback: '我正在等待 <@U123> 的回复来继续当前 skill 交互。',
      handled: true,
    });
    expect(bridge.hasPending('thread-1')).toBe(true);

    const correctUserReply = bridge.submitReply({
      text: '2',
      threadTs: 'thread-1',
      userId: 'U123',
    });
    expect(correctUserReply).toMatchObject({ accepted: true, handled: true });
    await expect(pending).resolves.toMatchObject({ answer: 'Lunar' });
  });

  it('returns feedback for invalid multi-select replies', async () => {
    const bridge = new SlackUserInputBridge(createTestLogger());
    void bridge.awaitAnswer({
      question: {
        header: 'Features',
        multiSelect: true,
        options: [
          { description: 'Enable memory', label: 'Memory' },
          { description: 'Enable skills', label: 'Skills' },
        ],
        question: 'Which features should I enable?',
      },
      threadTs: 'thread-2',
    });

    const result = bridge.submitReply({
      text: '1, unknown',
      threadTs: 'thread-2',
      userId: 'U123',
    });

    expect(result).toMatchObject({
      handled: true,
    });
    expect(result.feedback).toContain('没有识别你的回复');
    expect(bridge.hasPending('thread-2')).toBe(true);
  });

  it('does not keep a pending entry when the input signal is already aborted', async () => {
    const bridge = new SlackUserInputBridge(createTestLogger());
    const controller = new AbortController();
    controller.abort();

    await expect(
      bridge.awaitAnswer({
        question: {
          header: 'Calendar',
          options: [{ description: 'Use Gregorian', label: 'Gregorian' }],
          question: 'Which calendar should I use?',
        },
        signal: controller.signal,
        threadTs: 'thread-3',
      }),
    ).rejects.toBeDefined();

    expect(bridge.hasPending('thread-3')).toBe(false);
  });
});

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
