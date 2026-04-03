import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSdkExecutor } from '../src/claude/executor/anthropic-agent-sdk.js';
import type { AppLogger } from '../src/logger/index.js';
import type { SessionRecord, SessionStore } from '../src/session/types.js';
import { SlackThreadContextLoader } from '../src/slack/context/thread-context-loader.js';
import { createAppMentionHandler } from '../src/slack/ingress/app-mention-handler.js';
import { SlackRenderer } from '../src/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '../src/slack/types.js';

const sdkMocks = vi.hoisted(() => ({
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

describe('Slack loading status E2E', () => {
  beforeEach(() => {
    sdkMocks.createSdkMcpServer.mockClear();
    sdkMocks.query.mockReset();
    sdkMocks.tool.mockClear();
  });

  it('renders Claude SDK task and stream progress into Slack status updates', async () => {
    const threadTs = '1712345678.000100';
    const logger = createTestLogger();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const executor = new ClaudeAgentSdkExecutor(logger);
    const handler = createAppMentionHandler({
      claudeExecutor: executor,
      logger,
      renderer,
      sessionStore,
      threadContextLoader,
    });
    const { client, postMessageCalls, reactionCalls, statusCalls } = createSlackClientFixture({
      threadTs,
    });

    sdkMocks.query.mockImplementation((_request: { options: Record<string, unknown> }) =>
      createMessageStream([
        {
          type: 'system',
          subtype: 'init',
          cwd: '/Users/innei/git/innei-repo/slack-cc-bot',
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
        text: '<@U_BOT> inspect the loading messages',
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(sdkMocks.query).toHaveBeenCalledOnce();
    const [queryArgs] = sdkMocks.query.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(queryArgs.options).toMatchObject({
      agentProgressSummaries: true,
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

    const runtimeStatusCall = statusCalls.find(
      (call) => call.status === 'Running ReadFile (1.2s)...',
    );
    expect(runtimeStatusCall).toBeDefined();
    expect(runtimeStatusCall?.loading_messages).toEqual(
      expect.arrayContaining([
        'Inspecting Slack renderer status handling',
        'Reading render/slack-renderer.ts...',
      ]),
    );

    expect(postMessageCalls).toEqual([
      {
        channel: 'C123',
        text: 'Updated loading messages.',
        thread_ts: threadTs,
      },
    ]);

    expect(statusCalls.at(-1)).toEqual({
      channel_id: 'C123',
      status: '',
      thread_ts: threadTs,
    });

    expect(sessionStore.get(threadTs)?.claudeSessionId).toBe('session-1');
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

function createSlackClientFixture({ threadTs }: { threadTs: string }): {
  client: SlackWebClientLike;
  postMessageCalls: Array<{ channel: string; text: string; thread_ts?: string }>;
  reactionCalls: Array<{ channel: string; name: string; timestamp: string }>;
  statusCalls: Array<{
    channel_id: string;
    loading_messages?: string[];
    status: string;
    thread_ts: string;
  }>;
} {
  const postMessageCalls: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const reactionCalls: Array<{ channel: string; name: string; timestamp: string }> = [];
  const statusCalls: Array<{
    channel_id: string;
    loading_messages?: string[];
    status: string;
    thread_ts: string;
  }> = [];

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
      postMessage: async (args) => {
        postMessageCalls.push(args);
        return { ts: '1712345678.000200' };
      },
      startStream: async () => ({ ts: '1712345678.000300' }),
      stopStream: async () => ({}),
    },
    conversations: {
      replies: async () => ({
        messages: [
          {
            channel: 'C123',
            text: '<@U_BOT> inspect the loading messages',
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
  };

  return {
    client,
    postMessageCalls,
    reactionCalls,
    statusCalls,
  };
}

async function* createMessageStream(messages: readonly unknown[]): AsyncIterable<unknown> {
  for (const message of messages) {
    yield message;
  }
}
