import { describe, expect, it, vi } from 'vitest';

import { createStopMessageActionHandler } from '~/slack/interactions/stop-message-action.js';

function createTestDeps() {
  return {
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
      withTag: vi.fn().mockReturnThis(),
    } as any,
    threadExecutionRegistry: {
      listActive: vi.fn(() => []),
      register: vi.fn(() => () => {}),
      stopAll: vi.fn(async () => ({ stopped: 0, failed: 0 })),
      stopByMessage: vi.fn(async () => ({ stopped: 0, failed: 0 })),
      trackMessage: vi.fn(),
    },
  };
}

function createShortcutPayload(overrides?: { thread_ts?: string; ts?: string }) {
  return {
    ack: vi.fn().mockResolvedValue(undefined),
    client: {
      chat: {
        postEphemeral: vi.fn().mockResolvedValue({}),
      },
    },
    shortcut: {
      type: 'message_action',
      callback_id: 'stop_reply_action',
      trigger_id: 'T123',
      channel: { id: 'C123' },
      user: { id: 'U123' },
      team: { id: 'T1' },
      message: {
        ts: overrides?.ts ?? '1712345678.000100',
        text: 'some message',
        ...(overrides?.thread_ts ? { thread_ts: overrides.thread_ts } : {}),
      },
    },
  };
}

describe('createStopMessageActionHandler', () => {
  it('calls stopByMessage with the message ts and posts ephemeral result', async () => {
    const deps = createTestDeps();
    deps.threadExecutionRegistry.stopByMessage.mockResolvedValue({ stopped: 1, failed: 0 });
    const handler = createStopMessageActionHandler(deps);
    const payload = createShortcutPayload({ thread_ts: 'root-ts' });

    await handler(payload);

    expect(payload.ack).toHaveBeenCalled();
    expect(deps.threadExecutionRegistry.stopByMessage).toHaveBeenCalledWith(
      '1712345678.000100',
      'user_stop',
    );
    expect(payload.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        user: 'U123',
        thread_ts: 'root-ts',
        text: 'Stopped 1 in-progress reply.',
      }),
    );
  });

  it('uses message ts as thread_ts fallback when not in a thread', async () => {
    const deps = createTestDeps();
    const handler = createStopMessageActionHandler(deps);
    const payload = createShortcutPayload();

    await handler(payload);

    expect(payload.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: '1712345678.000100',
      }),
    );
  });

  it('reports no execution found when stopByMessage returns zeros', async () => {
    const deps = createTestDeps();
    deps.threadExecutionRegistry.stopByMessage.mockResolvedValue({ stopped: 0, failed: 0 });
    const handler = createStopMessageActionHandler(deps);
    const payload = createShortcutPayload({ thread_ts: 'root-ts' });

    await handler(payload);

    expect(payload.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'No in-progress reply found in this thread.',
      }),
    );
  });
});
