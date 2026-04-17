import { describe, expect, it, vi } from 'vitest';

import type { AgentActivityState } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { SessionStore } from '~/session/types.js';
import { createActivitySink } from '~/slack/ingress/activity-sink.js';
import type { SlackRenderer } from '~/slack/render/slack-renderer.js';
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

function createRendererStub(): SlackRenderer {
  return {
    addAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
    clearUiState: vi.fn().mockResolvedValue(undefined),
    deleteThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    finalizeThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    postGeneratedFiles: vi.fn().mockResolvedValue([]),
    postGeneratedImages: vi.fn().mockResolvedValue([]),
    finalizeThreadProgressMessageStopped: vi.fn().mockResolvedValue(undefined),
    postThreadReply: vi.fn().mockResolvedValue(undefined),
    setUiState: vi.fn().mockResolvedValue(undefined),
    showThinkingIndicator: vi.fn().mockResolvedValue(undefined),
    upsertThreadProgressMessage: vi.fn().mockResolvedValue('progress-ts'),
    postSessionUsageInfo: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackRenderer;
}

function createMockClient(): SlackWebClientLike {
  return {
    assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    files: { uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }) },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({}),
    },
  } as unknown as SlackWebClientLike;
}

function createMockSessionStore(): SessionStore {
  return {
    countAll: () => 0,
    get: vi.fn().mockReturnValue(undefined),
    patch: vi.fn().mockReturnValue(undefined),
    upsert: vi.fn().mockImplementation((r) => r),
  } as unknown as SessionStore;
}

function createMockAnalyticsStore(): SessionAnalyticsStore {
  return {
    upsert: vi.fn(),
  };
}

describe('createActivitySink', () => {
  it('posts a thread reply on assistant-message events', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'Hello!' });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Hello!',
      expect.any(Object),
    );
  });

  it('clears UI state after assistant-message', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'assistant-message', text: 'Hello!' });

    expect(renderer.clearUiState).toHaveBeenCalled();
  });

  it('patches session with resume handle on lifecycle events', async () => {
    const sessionStore = createMockSessionStore();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore,
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'started', resumeHandle: 'session-42' });

    expect(sessionStore.patch).toHaveBeenCalledWith('ts1', { providerSessionId: 'session-42' });
  });

  it('posts error message on lifecycle failed', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: 'boom' });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'An error occurred while processing your request.',
    );
  });

  it('finalize clears UI state', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.finalize();

    expect(renderer.clearUiState).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1');
  });

  it('tracks tool activity in toolHistory', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const state: AgentActivityState = {
      threadTs: 'ts1',
      status: 'Reading files...',
      activities: ['Reading src/index.ts...'],
      clear: false,
    };
    await sink.onEvent({ type: 'activity-state', state });

    expect(sink.toolHistory.get('Reading')).toBe(2);
  });

  it('does not block execution when progress message updates fail', async () => {
    const renderer = createRendererStub();
    vi.mocked(renderer.upsertThreadProgressMessage).mockRejectedValue(new Error('slack hung'));

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await expect(
      sink.onEvent({
        type: 'activity-state',
        state: {
          threadTs: 'ts1',
          status: 'Reading files...',
          activities: ['Reading src/index.ts...'],
          clear: false,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('counts repeated tool calls when activity reappears after disappearing', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    // First tool call: Reading file.txt
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        activities: ['Reading file.txt...'],
        clear: false,
      },
    });
    expect(sink.toolHistory.get('Reading')).toBe(1);

    // Transition to different activity (first read completes)
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        activities: ['Editing file.txt...'],
        clear: false,
      },
    });
    expect(sink.toolHistory.get('Editing')).toBe(1);

    // Second tool call: Reading file.txt again (same activity string reappears)
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        activities: ['Editing file.txt...', 'Reading file.txt...'],
        clear: false,
      },
    });
    // Should count the reappearing Reading activity
    expect(sink.toolHistory.get('Reading')).toBe(2);
    expect(sink.toolHistory.get('Editing')).toBe(1);
  });

  it('buffers generated-images and flushes via postGeneratedImages after assistant text reply', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const files = [
      { fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' },
      { fileName: 'b.png', path: '/tmp/b.png', providerFileId: 'p2' },
    ];
    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Here you go.' });

    expect(postThreadReply.mock.invocationCallOrder[0]).toBeLessThan(
      postGeneratedImages.mock.invocationCallOrder[0]!,
    );
    expect(postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Here you go.',
      expect.any(Object),
    );
    expect(postGeneratedImages).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1', files);
  });

  it('posts assistant text when postGeneratedImages reports failures without dropping the reply', async () => {
    const renderer = createRendererStub();
    const failedFile = { fileName: 'a.png', path: '/x/a.png', providerFileId: 'p1' };
    vi.mocked(renderer.postGeneratedImages).mockResolvedValue([failedFile]);
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'generated-images',
      files: [failedFile],
    });
    await sink.onEvent({ type: 'assistant-message', text: 'Reply text.' });

    expect(postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Reply text.',
      expect.any(Object),
    );
    expect(renderer.postGeneratedImages).toHaveBeenCalled();
  });

  it('buffers generated-files and flushes them after the assistant text reply', async () => {
    const renderer = createRendererStub();
    const postGeneratedFiles = vi.mocked(renderer.postGeneratedFiles);
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const files = [{ fileName: 'report.txt', path: '/tmp/report.txt', providerFileId: 'pf1' }];
    await sink.onEvent({ type: 'generated-files', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Attached.' });

    expect(postThreadReply.mock.invocationCallOrder[0]).toBeLessThan(
      postGeneratedFiles.mock.invocationCallOrder[0]!,
    );
    expect(postGeneratedFiles).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1', files);
  });

  it('retries generated-files on finalize after assistant-time flush leaves failures', async () => {
    const renderer = createRendererStub();
    const postGeneratedFiles = vi.mocked(renderer.postGeneratedFiles);
    const files = [{ fileName: 'report.txt', path: '/tmp/report.txt', providerFileId: 'pf1' }];
    postGeneratedFiles.mockResolvedValueOnce(files).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-files', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Attached.' });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedFiles).toHaveBeenCalledTimes(2);
    expect(postGeneratedFiles).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', files);
    expect(postGeneratedFiles).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', files);
  });

  it('retries postGeneratedImages on finalize after assistant-time flush leaves failures, when lifecycle completed', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const files = [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }];
    postGeneratedImages.mockResolvedValueOnce(files).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'assistant-message', text: 'Here is the answer.' });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenCalledTimes(2);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', files);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', files);
  });

  it('retries only failed images on finalize after partial assistant-time failure', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const a = { fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' };
    const b = { fileName: 'b.png', path: '/tmp/b.png', providerFileId: 'p2' };
    postGeneratedImages.mockResolvedValueOnce([b]).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-images', files: [a, b] });
    await sink.onEvent({ type: 'assistant-message', text: 'Done.' });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', [
      a,
      b,
    ]);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', [b]);
  });

  it('flushes buffered images on finalize when lifecycle completed', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const files = [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }];
    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1', files);
  });

  it('preserves buffer when finalize-time postGeneratedImages returns failures; second finalize retries', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const files = [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }];
    postGeneratedImages.mockResolvedValueOnce(files).mockResolvedValueOnce([]);

    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'generated-images', files });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();
    await sink.finalize();

    expect(postGeneratedImages).toHaveBeenCalledTimes(2);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(1, expect.anything(), 'C123', 'ts1', files);
    expect(postGeneratedImages).toHaveBeenNthCalledWith(2, expect.anything(), 'C123', 'ts1', files);
  });

  it('does not flush images on finalize after lifecycle failed', async () => {
    const renderer = createRendererStub();
    const postGeneratedImages = vi.mocked(renderer.postGeneratedImages);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'generated-images',
      files: [{ fileName: 'a.png', path: '/tmp/a.png', providerFileId: 'p1' }],
    });
    await sink.onEvent({ type: 'lifecycle', phase: 'failed', error: 'boom' });
    await sink.finalize();

    expect(postGeneratedImages).not.toHaveBeenCalled();
  });

  it('lifecycle stopped with no progress posts _Stopped by user._ and not the generic error', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'user_stop' });

    expect(renderer.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );
    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'An error occurred while processing your request.',
    );
  });

  it('finalize uses stopped progress finalizer when stopped with progress and no assistant reply yet', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    const state: AgentActivityState = {
      threadTs: 'ts1',
      status: 'Reading files...',
      activities: ['Reading src/index.ts...'],
      clear: false,
    };
    await sink.onEvent({ type: 'activity-state', state });
    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'user_stop' });

    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );

    await sink.finalize();

    expect(renderer.finalizeThreadProgressMessageStopped).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'progress-ts',
      sink.toolHistory,
    );
    expect(renderer.finalizeThreadProgressMessage).not.toHaveBeenCalled();
    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );
  });

  it('deletes superseded progress instead of showing stopped-by-user UI', async () => {
    const renderer = createRendererStub();
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
    });

    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        status: 'Reading files...',
        activities: ['Reading src/index.ts...'],
        clear: false,
      },
    });
    await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'superseded' });
    await sink.finalize();

    expect(renderer.deleteThreadProgressMessage).toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'progress-ts',
    );
    expect(renderer.finalizeThreadProgressMessageStopped).not.toHaveBeenCalled();
    expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      '_Stopped by user._',
    );
  });

  it('only includes workspaceLabel on the first message of a turn', async () => {
    const renderer = createRendererStub();
    const postThreadReply = vi.mocked(renderer.postThreadReply);
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer,
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      workspaceLabel: 'my-workspace',
    });

    // Accumulate some tool activity
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        status: 'Reading files...',
        activities: ['Reading src/index.ts...'],
        clear: false,
      },
    });

    // First message should include workspace label only
    await sink.onEvent({ type: 'assistant-message', text: 'First message' });
    expect(postThreadReply).toHaveBeenLastCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'First message',
      { workspaceLabel: 'my-workspace' },
    );

    // Simulate more tool activity between messages
    await sink.onEvent({
      type: 'activity-state',
      state: {
        threadTs: 'ts1',
        status: 'Searching codebase...',
        activities: ['Searching for patterns...'],
        clear: false,
      },
    });

    // Second message should NOT include toolbar (empty options object)
    await sink.onEvent({ type: 'assistant-message', text: 'Second message' });
    expect(postThreadReply).toHaveBeenLastCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Second message',
      {},
    );

    // Third message should also NOT include toolbar
    await sink.onEvent({ type: 'assistant-message', text: 'Third message' });
    expect(postThreadReply).toHaveBeenLastCalledWith(
      expect.anything(),
      'C123',
      'ts1',
      'Third message',
      {},
    );
  });

  it('persists analytics on finalize when lifecycle completed and usage info available', async () => {
    const analyticsStore = createMockAnalyticsStore();
    const sink = createActivitySink({
      analyticsStore,
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
    });

    const usage = {
      totalCostUSD: 0.01,
      durationMs: 5000,
      modelUsage: [
        {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 100,
          cacheHitRate: 66.7,
          costUSD: 0.01,
        },
      ],
    };

    await sink.onEvent({ type: 'usage-info', usage });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(analyticsStore.upsert).toHaveBeenCalledWith('ts1', 'U999', usage);
  });

  it('does not persist analytics when no analyticsStore provided', async () => {
    const sink = createActivitySink({
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
    });

    const usage = {
      totalCostUSD: 0.01,
      durationMs: 5000,
      modelUsage: [
        {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 100,
          cacheHitRate: 66.7,
          costUSD: 0.01,
        },
      ],
    };

    await sink.onEvent({ type: 'usage-info', usage });
    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();
  });

  it('does not persist analytics when no usage info available', async () => {
    const analyticsStore = createMockAnalyticsStore();
    const sink = createActivitySink({
      analyticsStore,
      channel: 'C123',
      client: createMockClient(),
      logger: createTestLogger(),
      renderer: createRendererStub(),
      sessionStore: createMockSessionStore(),
      threadTs: 'ts1',
      userId: 'U999',
    });

    await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
    await sink.finalize();

    expect(analyticsStore.upsert).not.toHaveBeenCalled();
  });
});
