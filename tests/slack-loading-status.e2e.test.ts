import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSdkExecutor } from '../src/claude/executor/anthropic-agent-sdk.js';
import type { AppLogger } from '../src/logger/index.js';
import type { MemoryStore } from '../src/memory/types.js';
import type { SessionRecord, SessionStore } from '../src/session/types.js';
import { SlackThreadContextLoader } from '../src/slack/context/thread-context-loader.js';
import { createAppMentionHandler } from '../src/slack/ingress/app-mention-handler.js';
import { SlackRenderer } from '../src/slack/render/slack-renderer.js';
import type { SlackBlock, SlackWebClientLike } from '../src/slack/types.js';
import { WorkspaceResolver } from '../src/workspace/resolver.js';

const sdkMocks = vi.hoisted(() => ({
  env: (() => {
    process.env.REPO_ROOT_DIR = process.env.REPO_ROOT_DIR ?? '/tmp';
    process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? 'xoxb-test';
    process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? 'xapp-test';
    process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? 'secret';
    return true;
  })(),
  createSdkMcpServer: vi.fn((config: unknown) => config),
  query: vi.fn(),
  tool: vi.fn(
    (
      name: unknown,
      description: unknown,
      inputSchema: unknown,
      handler: unknown,
    ): Record<string, unknown> => ({
      description,
      handler,
      inputSchema,
      name,
    }),
  ),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: sdkMocks.createSdkMcpServer,
  query: sdkMocks.query,
  tool: sdkMocks.tool,
}));

describe('Slack loading status test', () => {
  beforeEach(() => {
    sdkMocks.createSdkMcpServer.mockClear();
    sdkMocks.query.mockReset();
    sdkMocks.tool.mockClear();
  });

  it('renders Claude SDK task and stream progress into Slack status updates', async () => {
    const threadTs = '1712345678.000100';
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-'));
    const repoPath = path.join(repoRoot, 'slack-cc-bot');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 2 });
    const executor = new ClaudeAgentSdkExecutor(logger);
    const handler = createAppMentionHandler({
      claudeExecutor: executor,
      logger,
      memoryStore,
      renderer,
      sessionStore,
      threadContextLoader,
      workspaceResolver,
    });
    const {
      client,
      deleteCalls,
      postMessageCalls,
      reactionCalls,
      statusCalls,
      updateCalls,
    } = createSlackClientFixture({ threadTs });

    sdkMocks.query.mockImplementation((_request: { options: Record<string, unknown> }) =>
      createMessageStream([
        {
          type: 'system',
          subtype: 'init',
          cwd: repoPath,
          model: 'claude-sonnet-test',
          session_id: 'session-1',
        },
        {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        },
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          description: 'Inspect the Slack loading flow',
        },
        {
          type: 'system',
          subtype: 'task_progress',
          task_id: 'task-1',
          description: 'Inspect the Slack loading flow',
          last_tool_name: 'ReadFile',
          summary: 'Inspecting Slack renderer status handling',
          usage: {
            duration_ms: 900,
            tool_uses: 1,
            total_tokens: 42,
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              name: 'ReadFile',
            },
          },
          parent_tool_use_id: null,
          session_id: 'session-1',
          uuid: 'event-1',
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json:
                '{"path":"/Users/innei/git/innei-repo/slack-cc-bot/src/slack/render/slack-renderer.ts"}',
            },
          },
          parent_tool_use_id: null,
          session_id: 'session-1',
          uuid: 'event-2',
        },
        {
          type: 'tool_progress',
          elapsed_time_seconds: 1.2,
          parent_tool_use_id: null,
          session_id: 'session-1',
          task_id: 'task-1',
          tool_name: 'ReadFile',
          tool_use_id: 'tool-1',
          uuid: 'tool-progress-1',
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_stop',
            index: 0,
          },
          parent_tool_use_id: null,
          session_id: 'session-1',
          uuid: 'event-3',
        },
        {
          type: 'assistant',
          error: undefined,
          message: {
            content: [{ type: 'text', text: 'Updated loading messages.' }],
          },
          parent_tool_use_id: null,
          session_id: 'session-1',
          uuid: 'assistant-1',
        },
        {
          type: 'result',
          subtype: 'success',
          duration_ms: 1450,
          total_cost_usd: 0.0012,
        },
      ]),
    );

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> inspect the loading messages in slack-cc-bot',
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(sdkMocks.query).toHaveBeenCalledOnce();
    const [queryArgs] = sdkMocks.query.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(queryArgs.options).toMatchObject({
      agentProgressSummaries: true,
      cwd: repoPath,
      includeHookEvents: true,
      includePartialMessages: true,
    });

    expect(reactionCalls).toEqual([
      {
        channel: 'C123',
        name: 'eyes',
        timestamp: threadTs,
      },
    ]);

    expect(statusCalls[0]).toEqual({
      channel_id: 'C123',
      loading_messages: [
        'Reading the thread context...',
        'Planning the next steps...',
        'Generating a response...',
      ],
      status: 'Thinking...',
      thread_ts: threadTs,
    });
    expect(statusCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_id: 'C123',
          status: '',
          thread_ts: threadTs,
        }),
      ]),
    );
    expect(statusCalls.at(-1)).toEqual(
      expect.objectContaining({
        channel_id: 'C123',
        status: '',
        thread_ts: threadTs,
      }),
    );

    expect(postMessageCalls).toHaveLength(2);
    expect(postMessageCalls[0]).toMatchObject({
      channel: 'C123',
      thread_ts: threadTs,
    });
    expect(postMessageCalls[0].text).not.toBe('Thinking... — Thinking...');
    expect(postMessageCalls[0].blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'section',
          text: expect.objectContaining({ text: expect.any(String) }),
        }),
      ]),
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Running ReadFile'),
          ts: '1712345678.000200',
        }),
      ]),
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'context',
              elements: expect.arrayContaining([
                expect.objectContaining({ text: 'Inspecting Slack renderer status handling' }),
              ]),
            }),
          ]),
          channel: 'C123',
          ts: '1712345678.000200',
        }),
      ]),
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        channel: 'C123',
        text: expect.stringContaining('Inspect the Slack loading flow'),
        ts: '1712345678.000200',
      }),
      ]),
    );
    expect(postMessageCalls[1]).toEqual({
      channel: 'C123',
      text: 'Updated loading messages.',
      thread_ts: threadTs,
    });
    expect(deleteCalls).toEqual([
      {
        channel: 'C123',
        ts: '1712345678.000200',
      },
    ]);

    expect(sessionStore.get(threadTs)?.claudeSessionId).toBe('session-1');
  });

  it('cleans up the thread progress message when execution fails after cutover', async () => {
    const threadTs = '1712345678.000101';
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-'));
    const repoPath = path.join(repoRoot, 'slack-cc-bot');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 2 });
    const executor = new ClaudeAgentSdkExecutor(logger);
    const handler = createAppMentionHandler({
      claudeExecutor: executor,
      logger,
      memoryStore,
      renderer,
      sessionStore,
      threadContextLoader,
      workspaceResolver,
    });
    const { client, deleteCalls, postMessageCalls, statusCalls, updateCalls } =
      createSlackClientFixture({ threadTs });

    sdkMocks.query.mockImplementation((_request: { options: Record<string, unknown> }) =>
      createFailingMessageStream(
        [
          {
            type: 'system',
            subtype: 'init',
            cwd: repoPath,
            model: 'claude-sonnet-test',
            session_id: 'session-2',
          },
          {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task-2',
            description: 'Inspect failure cleanup',
          },
          {
            type: 'system',
            subtype: 'task_progress',
            task_id: 'task-2',
            description: 'Inspect failure cleanup',
            last_tool_name: 'ReadFile',
            summary: 'Inspecting failure cleanup handling',
            usage: {
              duration_ms: 600,
              tool_uses: 1,
              total_tokens: 24,
            },
          },
        ],
        new Error('boom'),
      ),
    );

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> inspect failure cleanup in slack-cc-bot',
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(statusCalls[0]).toEqual({
      channel_id: 'C123',
      loading_messages: [
        'Reading the thread context...',
        'Planning the next steps...',
        'Generating a response...',
      ],
      status: 'Thinking...',
      thread_ts: threadTs,
    });
    expect(statusCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_id: 'C123',
          status: '',
          thread_ts: threadTs,
        }),
      ]),
    );

    expect(postMessageCalls[0]).toMatchObject({
      channel: 'C123',
      thread_ts: threadTs,
    });
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Inspect failure cleanup'),
          ts: '1712345678.000200',
        }),
      ]),
    );
    expect(postMessageCalls.at(-1)).toEqual({
      channel: 'C123',
      text: 'An error occurred while processing your request.',
      thread_ts: threadTs,
    });
    expect(deleteCalls).toEqual([
      {
        channel: 'C123',
        ts: '1712345678.000200',
      },
    ]);
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

function createMemorySessionStore(): SessionStore {
  const records = new Map<string, SessionRecord>();

  return {
    get: (threadTs) => {
      const existing = records.get(threadTs);
      return existing ? { ...existing } : undefined;
    },
    patch: (threadTs, patch) => {
      const existing = records.get(threadTs);
      if (!existing) {
        return undefined;
      }

      const next: SessionRecord = {
        ...existing,
        ...patch,
        threadTs,
        updatedAt: new Date().toISOString(),
      };
      records.set(threadTs, next);
      return { ...next };
    },
    upsert: (record) => {
      const next = { ...record };
      records.set(record.threadTs, next);
      return { ...next };
    },
  };
}

function createMemoryStore(): MemoryStore {
  return {
    delete: () => false,
    listRecent: () => [],
    prune: () => 0,
    pruneAll: () => 0,
    save: (input) => ({
      ...input,
      createdAt: new Date().toISOString(),
      id: 'memory-1',
    }),
    search: () => [],
  };
}

function createSlackClientFixture({ threadTs }: { threadTs: string }): {
  client: SlackWebClientLike;
  deleteCalls: Array<{ channel: string; ts: string }>;
  postMessageCalls: Array<{ blocks?: SlackBlock[]; channel: string; text: string; thread_ts?: string }>;
  reactionCalls: Array<{ channel: string; name: string; timestamp: string }>;
  statusCalls: Array<{
    channel_id: string;
    loading_messages?: string[];
    status: string;
    thread_ts: string;
  }>;
  updateCalls: Array<{ blocks?: SlackBlock[]; channel: string; text: string; ts: string }>;
} {
  const deleteCalls: Array<{ channel: string; ts: string }> = [];
  const postMessageCalls: Array<{
    blocks?: SlackBlock[];
    channel: string;
    text: string;
    thread_ts?: string;
  }> = [];
  const reactionCalls: Array<{ channel: string; name: string; timestamp: string }> = [];
  const statusCalls: Array<{
    channel_id: string;
    loading_messages?: string[];
    status: string;
    thread_ts: string;
  }> = [];
  const updateCalls: Array<{ blocks?: SlackBlock[]; channel: string; text: string; ts: string }> =
    [];

  const client: SlackWebClientLike = {
    assistant: {
      threads: {
        setStatus: async (args) => {
          statusCalls.push(args);
          return {};
        },
      },
    },
    chat: {
      appendStream: async () => ({}),
      delete: async (args) => {
        deleteCalls.push(args);
        return {};
      },
      postMessage: async (args) => {
        postMessageCalls.push(args);
        return { ts: '1712345678.000200' };
      },
      startStream: async () => ({ ts: '1712345678.000300' }),
      stopStream: async () => ({}),
      update: async (args) => {
        updateCalls.push(args);
        return {};
      },
    },
    conversations: {
      replies: async () => ({
        messages: [
          {
            channel: 'C123',
            text: '<@U_BOT> inspect the loading messages in slack-cc-bot',
            thread_ts: threadTs,
            ts: threadTs,
            user: 'U123',
          },
        ],
      }),
    },
    reactions: {
      add: async (args) => {
        reactionCalls.push(args);
        return {};
      },
    },
    views: {
      open: async () => ({}),
    },
  };

  return {
    client,
    deleteCalls,
    postMessageCalls,
    reactionCalls,
    statusCalls,
    updateCalls,
  };
}

async function* createMessageStream(messages: readonly unknown[]): AsyncIterable<unknown> {
  for (const message of messages) {
    yield message;
  }
}

async function* createFailingMessageStream(
  messages: readonly unknown[],
  error: Error,
): AsyncIterable<unknown> {
  for (const message of messages) {
    yield message;
  }

  throw error;
}
