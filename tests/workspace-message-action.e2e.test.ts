import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSdkExecutor } from '../src/claude/executor/anthropic-agent-sdk.js';
import type { AppLogger } from '../src/logger/index.js';
import type { MemoryStore } from '../src/memory/types.js';
import type { SessionRecord, SessionStore } from '../src/session/types.js';
import { SlackThreadContextLoader } from '../src/slack/context/thread-context-loader.js';
import {
  createWorkspaceMessageActionHandler,
  createWorkspaceSelectionViewHandler,
  WORKSPACE_MODAL_CALLBACK_ID,
} from '../src/slack/interactions/workspace-message-action.js';
import { SlackRenderer } from '../src/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '../src/slack/types.js';
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

describe('Workspace message action test', () => {
  beforeEach(() => {
    sdkMocks.createSdkMcpServer.mockClear();
    sdkMocks.query.mockReset();
    sdkMocks.tool.mockClear();
  });

  it('opens a modal and starts a new workspace-bound session from message action selection', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-message-action-'));
    const repoPath = path.join(repoRoot, 'team', 'slack-cc-bot');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });

    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 2 });
    const executor = new ClaudeAgentSdkExecutor(logger);
    const deps = {
      claudeExecutor: executor,
      logger,
      memoryStore,
      renderer,
      sessionStore,
      threadContextLoader,
      workspaceResolver,
    };
    const actionHandler = createWorkspaceMessageActionHandler(deps);
    const viewHandler = createWorkspaceSelectionViewHandler(deps);
    const { ackCalls, client, postMessageCalls, statusCalls, viewOpenCalls } =
      createSlackClientFixture();

    sdkMocks.query.mockImplementation((_request: { options: Record<string, unknown> }) =>
      createMessageStream([
        {
          type: 'system',
          subtype: 'init',
          cwd: repoPath,
          model: 'claude-sonnet-test',
          session_id: 'session-message-action',
        },
        {
          type: 'assistant',
          error: undefined,
          message: {
            content: [{ type: 'text', text: 'Workspace action completed.' }],
          },
          parent_tool_use_id: null,
          session_id: 'session-message-action',
          uuid: 'assistant-1',
        },
        {
          type: 'result',
          subtype: 'success',
          duration_ms: 800,
          total_cost_usd: 0.0007,
        },
      ]),
    );

    await actionHandler({
      ack: async () => {
        ackCalls.push('shortcut');
      },
      client,
      shortcut: {
        callback_id: 'workspace_message_action',
        channel: { id: 'C123' },
        message: {
          text: 'please handle this task in the right repo',
          ts: '1712345678.000100',
        },
        team: { id: 'T123' },
        trigger_id: 'trigger-1',
        type: 'message_action',
        user: { id: 'U123' },
      },
    });

    expect(viewOpenCalls).toHaveLength(1);
    const openedView = viewOpenCalls[0];
    expect(openedView.trigger_id).toBe('trigger-1');
    expect((openedView.view as { callback_id?: string }).callback_id).toBe(
      WORKSPACE_MODAL_CALLBACK_ID,
    );

    await viewHandler({
      ack: async (response?: unknown) => {
        ackCalls.push(response ?? 'view');
      },
      body: {
        user: { id: 'U123' },
      },
      client,
      view: {
        private_metadata: (openedView.view as { private_metadata?: string }).private_metadata,
        state: {
          values: {
            workspace_repo: {
              workspace_repo: {
                selected_option: {
                  value: 'team/slack-cc-bot',
                },
              },
            },
            workspace_input: {
              workspace_input: {
                value: '',
              },
            },
            workspace_mode: {
              workspace_mode: {
                selected_option: {
                  value: 'new_session',
                },
              },
            },
          },
        },
      },
    });

    expect(ackCalls[0]).toBe('shortcut');
    expect(ackCalls.at(-1)).toBe('view');

    expect(postMessageCalls).toEqual([
      {
        channel: 'C123',
        text: 'Starting a workspace session in `team/slack-cc-bot`.',
      },
      {
        channel: 'C123',
        text: 'Workspace action completed.',
        thread_ts: '1712345678.000200',
      },
    ]);

    expect(sdkMocks.query).toHaveBeenCalledOnce();
    const [queryArgs] = sdkMocks.query.mock.calls[0] as [
      { prompt: string; options: Record<string, unknown> },
    ];
    expect(queryArgs.options).toMatchObject({
      cwd: repoPath,
      persistSession: true,
    });
    expect(queryArgs.prompt).toContain('Slack message action invoked by <@U123>.');
    expect(queryArgs.prompt).toContain('please handle this task in the right repo');

    expect(statusCalls.at(0)).toEqual({
      channel_id: 'C123',
      loading_messages: [
        'Reading the thread context...',
        'Planning the next steps...',
        'Generating a response...',
      ],
      status: 'Thinking...',
      thread_ts: '1712345678.000200',
    });
    expect(statusCalls.at(-1)).toEqual({
      channel_id: 'C123',
      status: '',
      thread_ts: '1712345678.000200',
    });

    expect(sessionStore.get('1712345678.000200')).toMatchObject({
      claudeSessionId: 'session-message-action',
      workspaceLabel: 'team/slack-cc-bot',
      workspacePath: repoPath,
      workspaceRepoId: 'team/slack-cc-bot',
      workspaceSource: 'manual',
    });
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

function createSlackClientFixture(): {
  ackCalls: unknown[];
  client: SlackWebClientLike;
  postMessageCalls: Array<{ channel: string; text: string; thread_ts?: string }>;
  statusCalls: Array<{
    channel_id: string;
    loading_messages?: string[];
    status: string;
    thread_ts: string;
  }>;
  viewOpenCalls: Array<{ trigger_id: string; view: unknown }>;
} {
  const ackCalls: unknown[] = [];
  const postMessageCalls: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const statusCalls: Array<{
    channel_id: string;
    loading_messages?: string[];
    status: string;
    thread_ts: string;
  }> = [];
  const viewOpenCalls: Array<{ trigger_id: string; view: unknown }> = [];

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
      delete: async () => ({}),
      postMessage: async (args) => {
        postMessageCalls.push(args);

        if (!args.thread_ts) {
          return { ts: '1712345678.000200' };
        }

        return { ts: '1712345678.000300' };
      },
      startStream: async () => ({ ts: '1712345678.000400' }),
      stopStream: async () => ({}),
      update: async () => ({}),
    },
    conversations: {
      replies: async (args) => ({
        messages: [
          {
            text:
              args.ts === '1712345678.000200'
                ? 'Starting a workspace session in `team/slack-cc-bot`.'
                : 'please handle this task in the right repo',
            thread_ts: args.ts,
            ts: args.ts,
            user: 'U123',
          },
        ],
      }),
    },
    reactions: {
      add: async () => ({}),
    },
    views: {
      open: async (args) => {
        viewOpenCalls.push(args);
        return {};
      },
    },
  };

  return {
    ackCalls,
    client,
    postMessageCalls,
    statusCalls,
    viewOpenCalls,
  };
}

async function* createMessageStream(messages: readonly unknown[]): AsyncIterable<unknown> {
  for (const message of messages) {
    yield message;
  }
}
