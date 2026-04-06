import { describe, expect, it, vi } from 'vitest';

import { createReactionStopHandler } from '~/slack/ingress/reaction-stop-handler.js';

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
      claimMessage: vi.fn(() => true),
      listActive: vi.fn(() => []),
      register: vi.fn(() => () => {}),
      stopAll: vi.fn(async () => ({ stopped: 0, failed: 0 })),
      stopByMessage: vi.fn(async () => ({ stopped: 0, failed: 0 })),
      trackMessage: vi.fn(),
    },
  };
}

describe('createReactionStopHandler', () => {
  it('calls stopByMessage for octagonal_sign reaction on a message', async () => {
    const deps = createTestDeps();
    deps.threadExecutionRegistry.stopByMessage.mockResolvedValue({ stopped: 1, failed: 0 });
    const handler = createReactionStopHandler(deps);

    await handler({
      event: {
        type: 'reaction_added',
        user: 'U123',
        reaction: 'octagonal_sign',
        item: { type: 'message', channel: 'C123', ts: '1712345678.000100' },
        event_ts: '1712345679.000000',
      },
    } as any);

    expect(deps.threadExecutionRegistry.stopByMessage).toHaveBeenCalledWith(
      '1712345678.000100',
      'user_stop',
    );
    expect(deps.logger.info).toHaveBeenCalled();
  });

  it('calls stopByMessage for stop_sign reaction', async () => {
    const deps = createTestDeps();
    const handler = createReactionStopHandler(deps);

    await handler({
      event: {
        type: 'reaction_added',
        user: 'U123',
        reaction: 'stop_sign',
        item: { type: 'message', channel: 'C123', ts: '1712345678.000100' },
        event_ts: '1712345679.000000',
      },
    } as any);

    expect(deps.threadExecutionRegistry.stopByMessage).toHaveBeenCalledWith(
      '1712345678.000100',
      'user_stop',
    );
  });

  it('ignores non-stop reactions', async () => {
    const deps = createTestDeps();
    const handler = createReactionStopHandler(deps);

    await handler({
      event: {
        type: 'reaction_added',
        user: 'U123',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C123', ts: '1712345678.000100' },
        event_ts: '1712345679.000000',
      },
    } as any);

    expect(deps.threadExecutionRegistry.stopByMessage).not.toHaveBeenCalled();
  });

  it('ignores non-message item types', async () => {
    const deps = createTestDeps();
    const handler = createReactionStopHandler(deps);

    await handler({
      event: {
        type: 'reaction_added',
        user: 'U123',
        reaction: 'octagonal_sign',
        item: { type: 'file', file: 'F123' },
        event_ts: '1712345679.000000',
      },
    } as any);

    expect(deps.threadExecutionRegistry.stopByMessage).not.toHaveBeenCalled();
  });

  it('does not log when no execution was found', async () => {
    const deps = createTestDeps();
    deps.threadExecutionRegistry.stopByMessage.mockResolvedValue({ stopped: 0, failed: 0 });
    const handler = createReactionStopHandler(deps);

    await handler({
      event: {
        type: 'reaction_added',
        user: 'U123',
        reaction: 'octagonal_sign',
        item: { type: 'message', channel: 'C123', ts: '1712345678.000100' },
        event_ts: '1712345679.000000',
      },
    } as any);

    expect(deps.logger.info).not.toHaveBeenCalled();
  });
});
