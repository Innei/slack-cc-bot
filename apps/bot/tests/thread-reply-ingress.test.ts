import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutor } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import {
  createAppMentionHandler,
  createThreadReplyHandler,
} from '~/slack/ingress/app-mention-handler.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
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
      'Skipping %s for thread %s because message was authored by this app itself',
      'thread reply',
      threadTs,
    );
  });

  it('ignores self-authored bot thread replies even when they mention the bot explicitly', async () => {
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
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('deduplicates a thread self-mention that arrives through both app_mention and message ingress', async () => {
    const threadTs = '1712345678.000105';
    const messageTs = '1712345678.000106';
    const registry = createThreadExecutionRegistry();
    const { appMentionHandler, claudeExecutor, client, threadReplyHandler } =
      createDualIngressTestHarness(threadTs, registry);

    await appMentionHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> continue with the deliverable',
        thread_ts: threadTs,
        ts: messageTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    await threadReplyHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> continue with the deliverable',
        thread_ts: threadTs,
        ts: messageTs,
        type: 'message',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('allows app mentions even when Slack omits the team id', async () => {
    const threadTs = '1712345678.000107';
    const { appMentionHandler, claudeExecutor, client } = createDualIngressTestHarness(threadTs);

    await appMentionHandler({
      client,
      event: {
        channel: 'C123',
        text: '<@U_BOT> continue with the deliverable',
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      mentionText: '<@U_BOT> continue with the deliverable',
      threadTs,
      userId: 'U123',
    });
  });

  it('processes thread replies with image attachments only (no text)', async () => {
    const threadTs = '1712345678.000108';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '',
        subtype: 'file_share',
        files: [
          {
            id: 'F123ABC',
            mimetype: 'image/png',
            name: 'screenshot.png',
            url_private: 'https://files.slack.com/files-pri/T123-F123ABC/screenshot.png',
          },
        ],
        thread_ts: threadTs,
        ts: '1712345678.000109',
        type: 'message',
        user: 'U123',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('processes thread replies with text and image attachments', async () => {
    const threadTs = '1712345678.000110';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'Here is the screenshot',
        subtype: 'file_share',
        files: [
          {
            id: 'F123DEF',
            mimetype: 'image/jpeg',
            name: 'photo.jpg',
            url_private: 'https://files.slack.com/files-pri/T123-F123DEF/photo.jpg',
          },
        ],
        thread_ts: threadTs,
        ts: '1712345678.000111',
        type: 'message',
        user: 'U123',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      mentionText: 'Here is the screenshot',
      threadTs,
    });
  });

  it('processes thread uploads when Slack omits channel and team ids', async () => {
    const threadTs = '1712345678.000113';
    const { claudeExecutor, client, handler, logger, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        text: 'Please inspect this upload',
        subtype: 'file_share',
        files: [
          {
            id: 'F123JKL',
            mimetype: 'image/png',
            name: 'upload.png',
            url_private: 'https://files.slack.com/files-pri/T123-F123JKL/upload.png',
          },
        ],
        thread_ts: threadTs,
        ts: '1712345678.000114',
        type: 'message',
        user: 'U123',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      mentionText: 'Please inspect this upload',
      threadTs,
      userId: 'U123',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Thread reply missing channel id for thread %s; falling back to session channel %s',
      threadTs,
      'C123',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Thread reply missing team id for thread %s; continuing without it',
      threadTs,
    );
  });

  it('processes app mentions with image attachments only', async () => {
    const threadTs = '1712345678.000112';
    const { appMentionHandler, claudeExecutor, client } = createDualIngressTestHarness(threadTs);

    await appMentionHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '',
        files: [
          {
            id: 'F123GHI',
            mimetype: 'image/png',
            name: 'diagram.png',
            url_private: 'https://files.slack.com/files-pri/T123-F123GHI/diagram.png',
          },
        ],
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      threadTs,
      userId: 'U123',
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
      fileLoadFailures: [],
      loadedFiles: [],
      messages: [],
      renderedPrompt: 'Slack thread context:',
      threadTs,
      loadedImages: [],
      imageLoadFailures: [],
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
    analyticsStore: { upsert: vi.fn() } as SessionAnalyticsStore,
    channelPreferenceStore: { get: vi.fn().mockReturnValue(undefined), upsert: vi.fn() },
    claudeExecutor,
    logger,
    memoryStore: createMemoryStore(),
    renderer,
    sessionStore,
    threadContextLoader,
    threadExecutionRegistry: createThreadExecutionRegistry(),
    userInputBridge: new SlackUserInputBridge(logger),
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

function createDualIngressTestHarness(
  threadTs: string,
  threadExecutionRegistry = createThreadExecutionRegistry(),
): {
  appMentionHandler: ReturnType<typeof createAppMentionHandler>;
  claudeExecutor: AgentExecutor;
  client: SlackWebClientLike & {
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
  };
  threadReplyHandler: ReturnType<typeof createThreadReplyHandler>;
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
      fileLoadFailures: [],
      loadedFiles: [],
      messages: [],
      renderedPrompt: 'Slack thread context:',
      threadTs,
      loadedImages: [],
      imageLoadFailures: [],
    }),
  } as unknown as SlackThreadContextLoader;
  const workspaceResolver = {
    resolveFromText: vi.fn().mockReturnValue({
      query: '',
      reason: 'unused in this test',
      status: 'missing',
    }),
  } as unknown as WorkspaceResolver;
  const deps = {
    analyticsStore: { upsert: vi.fn() } as SessionAnalyticsStore,
    channelPreferenceStore: { get: vi.fn().mockReturnValue(undefined), upsert: vi.fn() },
    claudeExecutor,
    logger,
    memoryStore: createMemoryStore(),
    renderer,
    sessionStore,
    threadContextLoader,
    threadExecutionRegistry,
    userInputBridge: new SlackUserInputBridge(logger),
    workspaceResolver,
  };

  return {
    appMentionHandler: createAppMentionHandler(deps),
    claudeExecutor,
    client: createSlackClientFixture(),
    threadReplyHandler: createThreadReplyHandler(deps),
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
      remove: vi.fn().mockResolvedValue({}),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({}),
    },
  };
}

function createRendererStub(): SlackRenderer {
  return {
    addAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
    clearUiState: vi.fn().mockResolvedValue(undefined),
    deleteThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    finalizeThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    removeAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
    postGeneratedFiles: vi.fn().mockResolvedValue([]),
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
