import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import {
  createPermissionActionHandler,
  PERMISSION_APPROVE_ACTION_ID,
  PERMISSION_DENY_ACTION_ID,
  SlackPermissionBridge,
} from '~/slack/interaction/permission-bridge.js';
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

function createClient(): SlackWebClientLike {
  return {
    assistant: { threads: { setStatus: vi.fn(async () => ({})) } },
    auth: { test: vi.fn(async () => ({ user_id: 'U_BOT' })) },
    chat: {
      delete: vi.fn(async () => ({})),
      postEphemeral: vi.fn(async () => ({})),
      postMessage: vi.fn(async () => ({ ts: 'perm-ts' })),
      update: vi.fn(async () => ({})),
    },
    conversations: { replies: vi.fn(async () => ({ messages: [] })) },
    files: { uploadV2: vi.fn(async () => ({ files: [] })) },
    reactions: { add: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) },
    views: { open: vi.fn(async () => ({})), publish: vi.fn(async () => ({})) },
  } as unknown as SlackWebClientLike;
}

describe('SlackPermissionBridge', () => {
  it('posts a permission request and resolves on approve action', async () => {
    const bridge = new SlackPermissionBridge(createTestLogger());
    const client = createClient();

    const pending = bridge.requestPermission(client, {
      channelId: 'C1',
      description: 'Need to save memory',
      input: { category: 'context' },
      threadTs: 'thread-1',
      toolName: 'mcp__slack-ui__save_memory',
    });

    await vi.waitFor(() => {
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: 'thread-1',
        text: expect.stringContaining('需要你的授权'),
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'section' }),
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({ action_id: PERMISSION_APPROVE_ACTION_ID }),
              expect.objectContaining({ action_id: PERMISSION_DENY_ACTION_ID }),
            ]),
          }),
        ]),
      }),
    );

    const handled = await bridge.handleAction(
      client,
      {
        message: { ts: 'perm-ts', thread_ts: 'thread-1' },
        user: { id: 'U123' },
      },
      true,
    );

    expect(handled).toEqual({ handled: true });
    await expect(pending).resolves.toEqual({ allowed: true });
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        ts: 'perm-ts',
        text: expect.stringContaining('已批准'),
      }),
    );
  });

  it('rejects approvals from users other than the expected actor', async () => {
    const bridge = new SlackPermissionBridge(createTestLogger());
    const client = createClient();

    const pending = bridge.requestPermission(client, {
      channelId: 'C1',
      expectedUserId: 'U_OWNER',
      input: { category: 'context' },
      threadTs: 'thread-1',
      toolName: 'mcp__slack-ui__save_memory',
    });

    await vi.waitFor(() => {
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    });

    const handled = await bridge.handleAction(
      client,
      {
        message: { ts: 'perm-ts', thread_ts: 'thread-1' },
        user: { id: 'U_OTHER' },
      },
      true,
    );

    expect(handled).toEqual({
      handled: true,
      feedback: '只有 <@U_OWNER> 可以批准或拒绝此操作。',
    });
    expect(client.chat.update).not.toHaveBeenCalled();

    await bridge.handleAction(
      client,
      {
        message: { ts: 'perm-ts', thread_ts: 'thread-1' },
        user: { id: 'U_OWNER' },
      },
      true,
    );
    await expect(pending).resolves.toEqual({ allowed: true });
  });

  it('accepts action payloads that only include container.message_ts', async () => {
    const bridge = new SlackPermissionBridge(createTestLogger());
    const client = createClient();

    const pending = bridge.requestPermission(client, {
      channelId: 'C1',
      input: { category: 'context' },
      threadTs: 'thread-1',
      toolName: 'mcp__slack-ui__save_memory',
    });

    await vi.waitFor(() => {
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    });

    const handled = await bridge.handleAction(
      client,
      {
        container: { channel_id: 'C1', message_ts: 'perm-ts', thread_ts: 'thread-1' },
        user: { id: 'U123' },
      },
      true,
    );

    expect(handled).toEqual({ handled: true });
    await expect(pending).resolves.toEqual({ allowed: true });
  });

  it('formats circular or bigint input previews without throwing', async () => {
    const bridge = new SlackPermissionBridge(createTestLogger());
    const client = createClient();
    const input: Record<string, unknown> = { size: BigInt(42) };
    input.self = input;

    const pending = bridge.requestPermission(client, {
      channelId: 'C1',
      input,
      threadTs: 'thread-1',
      toolName: 'mcp__slack-ui__save_memory',
    });

    await vi.waitFor(() => {
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('[Circular]'),
      }),
    );

    await bridge.handleAction(
      client,
      {
        message: { ts: 'perm-ts', thread_ts: 'thread-1' },
        user: { id: 'U123' },
      },
      false,
    );
    await expect(pending).resolves.toEqual({ allowed: false });
  });

  it('posts ephemeral feedback when a different user clicks the action button', async () => {
    const bridge = new SlackPermissionBridge(createTestLogger());
    const client = createClient();
    const handler = createPermissionActionHandler(bridge, true);

    bridge.requestPermission(client, {
      channelId: 'C1',
      expectedUserId: 'U_OWNER',
      input: { category: 'context' },
      threadTs: 'thread-1',
      toolName: 'mcp__slack-ui__save_memory',
    });

    await vi.waitFor(() => {
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    });

    const ack = vi.fn(async () => {});
    await handler({
      ack,
      body: {
        channel: { id: 'C1' },
        message: { ts: 'perm-ts', thread_ts: 'thread-1' },
        user: { id: 'U_OTHER' },
      },
      client,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: 'C1',
      text: '只有 <@U_OWNER> 可以批准或拒绝此操作。',
      user: 'U_OTHER',
    });
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('posts ephemeral feedback when no pending permission request exists', async () => {
    const bridge = new SlackPermissionBridge(createTestLogger());
    const client = createClient();
    const handler = createPermissionActionHandler(bridge, false);

    const ack = vi.fn(async () => {});
    await handler({
      ack,
      body: {
        channel: { id: 'C1' },
        message: { ts: 'missing-ts', thread_ts: 'thread-1' },
        user: { id: 'U123' },
      },
      client,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: 'C1',
      text: '没有待处理的权限请求。',
      user: 'U123',
    });
  });
});
