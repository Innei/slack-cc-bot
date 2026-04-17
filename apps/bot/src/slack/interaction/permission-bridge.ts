import type { AppLogger } from '~/logger/index.js';

import type { SlackActionsBlock, SlackSectionBlock, SlackWebClientLike } from '../types.js';

export const PERMISSION_APPROVE_ACTION_ID = 'permission_approve_action';
export const PERMISSION_DENY_ACTION_ID = 'permission_deny_action';

export interface SlackPermissionRequest {
  channelId: string;
  description?: string | undefined;
  expectedUserId?: string | undefined;
  input?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  threadTs: string;
  toolName: string;
}

export interface SlackPermissionResponse {
  allowed: boolean;
}

interface PendingSlackPermissionRequest {
  channelId: string;
  expectedUserId?: string | undefined;
  messageTs: string;
  reject: (reason?: unknown) => void;
  resolve: (value: SlackPermissionResponse) => void;
  threadTs: string;
  toolName: string;
}

interface PermissionActionBody {
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  user?: { id?: string };
}

interface PermissionActionResult {
  feedback?: string;
  handled: boolean;
}

export class SlackPermissionBridge {
  private readonly pendingByMessageTs = new Map<string, PendingSlackPermissionRequest>();
  private readonly pendingMessageByThread = new Map<string, string>();

  constructor(private readonly logger: AppLogger) {}

  hasPending(threadTs: string): boolean {
    return this.pendingMessageByThread.has(threadTs);
  }

  async requestPermission(
    client: SlackWebClientLike,
    request: SlackPermissionRequest,
  ): Promise<SlackPermissionResponse> {
    const existingMessageTs = this.pendingMessageByThread.get(request.threadTs);
    if (existingMessageTs) {
      throw new Error(`Thread ${request.threadTs} is already waiting for permission.`);
    }

    const text = buildPermissionRequestText(request);
    const response = await client.chat.postMessage({
      blocks: buildPermissionRequestBlocks(request),
      channel: request.channelId,
      text,
      thread_ts: request.threadTs,
    });

    const messageTs = response.ts?.trim();
    if (!messageTs) {
      throw new Error('Slack did not return a ts for the permission request message.');
    }

    if (request.signal?.aborted) {
      await this.updateResolvedMessage(client, {
        actionUserId: undefined,
        allowed: false,
        channelId: request.channelId,
        messageTs,
        reason: 'cancelled',
        toolName: request.toolName,
      });
      throw (
        request.signal.reason ?? new Error(`Permission request aborted for ${request.threadTs}`)
      );
    }

    return await new Promise<SlackPermissionResponse>((resolve, reject) => {
      let cleanupAbort = () => {};
      const pending: PendingSlackPermissionRequest = {
        channelId: request.channelId,
        expectedUserId: request.expectedUserId,
        messageTs,
        reject: (reason) => {
          cleanupAbort();
          this.pendingByMessageTs.delete(messageTs);
          this.pendingMessageByThread.delete(request.threadTs);
          reject(reason);
        },
        resolve: (value) => {
          cleanupAbort();
          this.pendingByMessageTs.delete(messageTs);
          this.pendingMessageByThread.delete(request.threadTs);
          resolve(value);
        },
        threadTs: request.threadTs,
        toolName: request.toolName,
      };

      this.pendingMessageByThread.set(request.threadTs, messageTs);
      this.pendingByMessageTs.set(messageTs, pending);
      cleanupAbort = this.attachAbortHandler(client, messageTs, request, pending.reject);

      if (request.signal?.aborted) {
        pending.reject(
          request.signal.reason ?? new Error(`Permission request aborted for ${request.threadTs}`),
        );
      }
    });
  }

  async handleAction(
    client: SlackWebClientLike,
    body: unknown,
    allowed: boolean,
  ): Promise<PermissionActionResult> {
    const parsed = body as PermissionActionBody;
    const messageTs =
      parsed.message?.ts?.trim() ??
      parsed.container?.message_ts?.trim() ??
      parsed.message?.thread_ts?.trim() ??
      parsed.container?.thread_ts?.trim();
    if (!messageTs) {
      return { handled: false };
    }

    const pending = this.pendingByMessageTs.get(messageTs);
    if (!pending) {
      return { handled: false };
    }

    const actionUserId = parsed.user?.id?.trim();
    if (pending.expectedUserId && actionUserId && actionUserId !== pending.expectedUserId) {
      return {
        handled: true,
        feedback: `只有 <@${pending.expectedUserId}> 可以批准或拒绝此操作。`,
      };
    }

    await this.updateResolvedMessage(client, {
      actionUserId,
      allowed,
      channelId: pending.channelId,
      messageTs,
      toolName: pending.toolName,
    });

    this.logger.info(
      'Resolved Slack permission request for thread %s tool %s: allowed=%s',
      pending.threadTs,
      pending.toolName,
      String(allowed),
    );
    pending.resolve({ allowed });
    return { handled: true };
  }

  private attachAbortHandler(
    client: SlackWebClientLike,
    messageTs: string,
    request: SlackPermissionRequest,
    reject: (reason?: unknown) => void,
  ): () => void {
    if (!request.signal) {
      return () => {};
    }

    const onAbort = () => {
      const pending = this.pendingByMessageTs.get(messageTs);
      if (!pending) {
        return;
      }
      void this.updateResolvedMessage(client, {
        actionUserId: undefined,
        allowed: false,
        channelId: request.channelId,
        messageTs,
        reason: 'cancelled',
        toolName: request.toolName,
      });
      pending.reject(
        request.signal?.reason ?? new Error(`Permission request aborted for ${request.threadTs}`),
      );
    };

    request.signal.addEventListener('abort', onAbort, { once: true });
    return () => request.signal?.removeEventListener('abort', onAbort);
  }

  private async updateResolvedMessage(
    client: SlackWebClientLike,
    input: {
      actionUserId?: string | undefined;
      allowed: boolean;
      channelId: string;
      messageTs: string;
      reason?: 'cancelled' | undefined;
      toolName: string;
    },
  ): Promise<void> {
    const text = buildResolvedPermissionText(input);
    await client.chat.update({
      blocks: buildResolvedPermissionBlocks(input),
      channel: input.channelId,
      text,
      ts: input.messageTs,
    });
  }
}

export function createPermissionActionHandler(bridge: SlackPermissionBridge, allowed: boolean) {
  return async (args: {
    ack: () => Promise<void>;
    body: unknown;
    client: unknown;
  }): Promise<void> => {
    await args.ack();
    const result = await bridge.handleAction(args.client as SlackWebClientLike, args.body, allowed);

    const body = args.body as PermissionActionBody;
    const channelId = body.channel?.id?.trim() ?? body.container?.channel_id?.trim();
    const userId = body.user?.id?.trim();

    if ((!result.handled || result.feedback) && channelId && userId && args.client) {
      await (args.client as SlackWebClientLike).chat.postEphemeral?.({
        channel: channelId,
        text: result.feedback ?? '没有待处理的权限请求。',
        user: userId,
      });
    }
  };
}

function buildPermissionRequestText(request: SlackPermissionRequest): string {
  const description = request.description?.trim();
  const preview = formatInputPreview(request.input);
  return [
    '需要你的授权',
    '',
    `Claude 想要使用 ${request.toolName} 工具。`,
    ...(description ? ['', description] : []),
    ...(preview ? ['', preview] : []),
  ].join('\n');
}

function buildPermissionRequestBlocks(
  request: SlackPermissionRequest,
): Array<SlackSectionBlock | SlackActionsBlock> {
  const text = buildPermissionRequestText(request);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: PERMISSION_APPROVE_ACTION_ID,
          style: 'primary',
          text: {
            type: 'plain_text',
            text: 'Approve',
            emoji: true,
          },
        },
        {
          type: 'button',
          action_id: PERMISSION_DENY_ACTION_ID,
          style: 'danger',
          text: {
            type: 'plain_text',
            text: 'Deny',
            emoji: true,
          },
        },
      ],
    },
  ];
}

function buildResolvedPermissionText(input: {
  actionUserId?: string | undefined;
  allowed: boolean;
  reason?: 'cancelled' | undefined;
  toolName: string;
}): string {
  if (input.reason === 'cancelled') {
    return `权限请求已取消：${input.toolName}`;
  }

  const actor = input.actionUserId ? ` by <@${input.actionUserId}>` : '';
  return input.allowed ? `已批准 ${input.toolName}${actor}` : `已拒绝 ${input.toolName}${actor}`;
}

function buildResolvedPermissionBlocks(input: {
  actionUserId?: string | undefined;
  allowed: boolean;
  reason?: 'cancelled' | undefined;
  toolName: string;
}): SlackSectionBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: buildResolvedPermissionText(input),
      },
    },
  ];
}

function formatInputPreview(input: Record<string, unknown> | undefined): string | undefined {
  if (!input || Object.keys(input).length === 0) {
    return undefined;
  }

  const serialized = safeSerializeForSlack(input);
  const truncated = serialized.length > 1200 ? `${serialized.slice(0, 1197)}...` : serialized;
  return ['```', truncated, '```'].join('\n');
}

function safeSerializeForSlack(input: Record<string, unknown>): string {
  const seen = new WeakSet<object>();

  try {
    return (
      JSON.stringify(
        input,
        (_key, value) => {
          if (typeof value === 'bigint') {
            return value.toString();
          }
          if (typeof value === 'function') {
            return '[Function]';
          }
          if (typeof value === 'symbol') {
            return value.toString();
          }
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular]';
            }
            seen.add(value);
          }
          return value;
        },
        2,
      ) ?? '[Unserializable input]'
    );
  } catch {
    try {
      return String(input);
    } catch {
      return '[Unserializable input]';
    }
  }
}
