import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutor } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import { createThreadReplyHandler } from '~/slack/ingress/app-mention-handler.js';
import type { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';

describe('thread reply ingress', () => {
  it('ignores thread replies that mention another user instead of the bot', async () => {
    const threadTs = '1712345678.000100';
    const { claudeExecutor, client, handler, logger, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'please ask <@U456> to review this',
        thread_ts: threadTs,
        ts: '1712345678.000101',
        type: 'message',
        user: 'U123',
      },
    });

    expect(client.auth.test).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping %s for thread %s because mention targets another user: %s',
      'thread reply',
      threadTs,
      'U456',
    );
  });

  it('ignores bot-authored thread replies when they do not mention the bot', async () => {
    const threadTs = '1712345678.000101';
    const { claudeExecutor, client, handler, logger, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'status update from the bot itself',
        thread_ts: threadTs,
        ts: '1712345678.000102',
        type: 'message',
        user: 'U_BOT',
      },
    });

    expect(client.auth.test).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping %s for thread %s because bot-authored message does not mention this app',
      'thread reply',
      threadTs,
    );
  });

  it('allows bot-authored thread replies when they mention the bot explicitly', async () => {
    const threadTs = '1712345678.000103';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> please continue the thread',
        thread_ts: threadTs,
        ts: '1712345678.000104',
        type: 'message',
        user: 'U_BOT',
      },
    });

    expect(client.auth.test).toHaveBeenCalledOnce();
    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      mentionText: '<@U_BOT> please continue the thread',
      threadTs,
      userId: 'U_BOT',
    });
  });
});

function createThreadReplyTestHarness(threadTs: string): {
  claudeExecutor: AgentExecutor;
  client: SlackWebClientLike & {
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
  };
  handler: ReturnType<typeof createThreadReplyHandler>;
  logger: AppLogger;
  renderer: SlackRenderer;
  threadContextLoader: SlackThreadContextLoader;
} {
  const logger = createTestLogger();
  const sessionStore = createMemorySessionStore([
    {
      channelId: 'C123',
      createdAt: new Date().toISOString(),
      rootMessageTs: threadTs,
      threadTs,
      updatedAt: new Date().toISOString(),
    },
  ]);
  const claudeExecutor = {
    providerId: 'claude-code',
    execute: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentExecutor;
  const renderer = createRendererStub();
  const threadContextLoader = {
    loadThread: vi.fn().mockResolvedValue({
      channelId: 'C123',
      messages: [],
      renderedPrompt: 'Slack thread context:',
      threadTs,
    }),
  } as unknown as SlackThreadContextLoader;
  const workspaceResolver = {
    resolveFromText: vi.fn().mockReturnValue({
      query: '',
      reason: 'unused in this test',
      status: 'missing',
    }),
  } as unknown as WorkspaceResolver;
  const handler = createThreadReplyHandler({
    claudeExecutor,
    logger,
    memoryStore: createMemoryStore(),
    renderer,
    sessionStore,
    threadContextLoader,
    threadExecutionRegistry: createThreadExecutionRegistry(),
    workspaceResolver,
  });
  const client = createSlackClientFixture();

  return {
    claudeExecutor,
    client,
    handler,
    logger,
    renderer,
    threadContextLoader,
  };
}

function createSlackClientFixture(): SlackWebClientLike & {
  auth: {
    test: ReturnType<typeof vi.fn>;
  };
} {
  return {
    assistant: {
      threads: {
        setStatus: vi.fn().mockResolvedValue({}),
      },
    },
    auth: {
      test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }),
    },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({ ts: '1712345678.000200' }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
    },
  };
}

function createRendererStub(): SlackRenderer {
  return {
    addAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
    clearUiState: vi.fn().mockResolvedValue(undefined),
    deleteThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    finalizeThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    postGeneratedImages: vi.fn().mockResolvedValue([]),
    postThreadReply: vi.fn().mockResolvedValue(undefined),
    setUiState: vi.fn().mockResolvedValue(undefined),
    showThinkingIndicator: vi.fn().mockResolvedValue(undefined),
    upsertThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackRenderer;
}

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

function createMemorySessionStore(records: SessionRecord[] = []): SessionStore {
  const store = new Map(records.map((record) => [record.threadTs, { ...record }]));

  return {
    countAll: () => store.size,
    get: (threadTs) => {
      const record = store.get(threadTs);
      return record ? { ...record } : undefined;
    },
    patch: (threadTs, patch) => {
      const existing = store.get(threadTs);
      if (!existing) {
        return undefined;
      }

      const next: SessionRecord = {
        ...existing,
        ...patch,
        threadTs,
        updatedAt: new Date().toISOString(),
      };
      store.set(threadTs, next);
      return { ...next };
    },
    upsert: (record) => {
      const next = { ...record };
      store.set(record.threadTs, next);
      return { ...next };
    },
  };
}

function createMemoryStore(): MemoryStore {
  return {
    countAll: vi.fn().mockReturnValue(0),
    delete: vi.fn().mockReturnValue(false),
    deleteAll: vi.fn().mockReturnValue(0),
    listRecent: vi.fn().mockReturnValue([]),
    listForContext: vi.fn().mockReturnValue({ global: [], workspace: [], preferences: [] }),
    prune: vi.fn().mockReturnValue(0),
    pruneAll: vi.fn().mockReturnValue(0),
    save: vi.fn().mockImplementation((input) => ({
      ...input,
      scope: input.repoId ? 'workspace' : 'global',
      createdAt: new Date().toISOString(),
      id: 'memory-1',
    })),
    saveWithDedup: vi.fn().mockImplementation((input) => ({
      ...input,
      scope: input.repoId ? 'workspace' : 'global',
      createdAt: new Date().toISOString(),
      id: 'memory-1',
    })),
    search: vi.fn().mockReturnValue([]),
  };
}
