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
  createAppMentionHandler,
  WORKSPACE_PICKER_ACTION_ID,
} from '../src/slack/ingress/app-mention-handler.js';
import { WORKSPACE_MODAL_CALLBACK_ID } from '../src/slack/interactions/workspace-message-action.js';
import { createWorkspacePickerActionHandler } from '../src/slack/interactions/workspace-picker-action.js';
import { encodeWorkspacePickerButtonValue } from '../src/slack/interactions/workspace-picker-payload.js';
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

describe('Workspace picker action test', () => {
  beforeEach(() => {
    sdkMocks.createSdkMcpServer.mockClear();
    sdkMocks.query.mockReset();
    sdkMocks.tool.mockClear();
  });

  it('posts a green button for ambiguous resolution and opens modal on click', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-picker-'));
    const repo1Path = path.join(repoRoot, 'org1', 'my-app');
    const repo2Path = path.join(repoRoot, 'org2', 'my-app');
    fs.mkdirSync(path.join(repo1Path, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo2Path, '.git'), { recursive: true });

    const logger = createTestLogger();
    const memoryStore = createMemoryStore();
    const sessionStore = createMemorySessionStore();
    const renderer = new SlackRenderer(logger);
    const threadContextLoader = new SlackThreadContextLoader(logger);
    const workspaceResolver = new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 3 });
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

    const mentionHandler = createAppMentionHandler(deps);
    const pickerHandler = createWorkspacePickerActionHandler(deps);
    const { ackCalls, client, postMessageCalls, viewOpenCalls } = createSlackClientFixture();

    await mentionHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> work on my-app',
        ts: '1712345678.000100',
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(sdkMocks.query).not.toHaveBeenCalled();
    expect(postMessageCalls).toHaveLength(1);

    const pickerMessage = postMessageCalls[0];
    expect(pickerMessage.thread_ts).toBe('1712345678.000100');
    expect(pickerMessage.text).toContain("couldn't tell which repository");
    expect(pickerMessage.text).toContain('org1/my-app');
    expect(pickerMessage.text).toContain('org2/my-app');

    const actionsBlock = pickerMessage.blocks?.find(
      (block: SlackBlock) => block.type === 'actions',
    );
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock!.type).toBe('actions');

    const elements = (actionsBlock as { elements: Array<Record<string, unknown>> }).elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      action_id: WORKSPACE_PICKER_ACTION_ID,
      style: 'primary',
      type: 'button',
      value: encodeWorkspacePickerButtonValue('<@U_BOT> work on my-app'),
    });

    await pickerHandler({
      ack: async () => {
        ackCalls.push('picker');
      },
      body: {
        actions: [
          {
            action_id: WORKSPACE_PICKER_ACTION_ID,
            value: encodeWorkspacePickerButtonValue('<@U_BOT> work on my-app'),
          },
        ],
        channel: { id: 'C123' },
        message: {
          thread_ts: '1712345678.000100',
          ts: '1712345678.000200',
        },
        team: { id: 'T123' },
        trigger_id: 'trigger-picker-1',
        user: { id: 'U123' },
      },
      client,
    });

    expect(ackCalls).toContain('picker');
    expect(viewOpenCalls).toHaveLength(1);
    expect(viewOpenCalls[0].trigger_id).toBe('trigger-picker-1');
    expect((viewOpenCalls[0].view as { callback_id?: string }).callback_id).toBe(
      WORKSPACE_MODAL_CALLBACK_ID,
    );

    const modalView = viewOpenCalls[0].view as { blocks?: unknown[]; private_metadata?: string };
    expect(modalView.private_metadata).toBeDefined();
    const metadata = JSON.parse(modalView.private_metadata!);
    expect(metadata.channelId).toBe('C123');
    expect(metadata.teamId).toBe('T123');
    expect(metadata.userId).toBe('U123');
  });

  it('posts a green button for missing resolution', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-picker-missing-'));
    const repoPath = path.join(repoRoot, 'actual-repo');
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
    const { client, postMessageCalls } = createSlackClientFixture();

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> work on nonexistent-repo',
        ts: '1712345678.000100',
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(sdkMocks.query).not.toHaveBeenCalled();
    expect(postMessageCalls).toHaveLength(1);

    const message = postMessageCalls[0];
    expect(message.text).toContain("couldn't determine which repository");

    const actionsBlock = message.blocks?.find((block: SlackBlock) => block.type === 'actions');
    expect(actionsBlock).toBeDefined();

    const elements = (actionsBlock as { elements: Array<Record<string, unknown>> }).elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      action_id: WORKSPACE_PICKER_ACTION_ID,
      style: 'primary',
      type: 'button',
      value: encodeWorkspacePickerButtonValue('<@U_BOT> work on nonexistent-repo'),
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
  postMessageCalls: Array<{
    blocks?: SlackBlock[];
    channel: string;
    text: string;
    thread_ts?: string;
  }>;
  statusCalls: Array<{
    channel_id: string;
    loading_messages?: string[];
    status: string;
    thread_ts: string;
  }>;
  viewOpenCalls: Array<{ trigger_id: string; view: unknown }>;
} {
  const ackCalls: unknown[] = [];
  const postMessageCalls: Array<{
    blocks?: SlackBlock[];
    channel: string;
    text: string;
    thread_ts?: string;
  }> = [];
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
        return { ts: '1712345678.000200' };
      },
      startStream: async () => ({ ts: '1712345678.000400' }),
      stopStream: async () => ({}),
      update: async () => ({}),
    },
    conversations: {
      replies: async (args) => ({
        messages: [
          {
            text: '<@U_BOT> work on my-app',
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
