import { env } from '../../env/server.js';
import type { AppLogger } from '../../logger/index.js';
import type { ClaudeUiState } from '../../schemas/claude/publish-state.js';
import type { SlackBlock, SlackMrkdwnTextObject, SlackStreamChunk, SlackWebClientLike } from '../types.js';
import type { SlackStatusProbe } from './status-probe.js';

const DEFAULT_LOADING_MESSAGES = [
  'Reading the thread context...',
  'Planning the next steps...',
  'Generating a response...',
] as const;

const DEFAULT_PROGRESS_STATUS = 'Working on your request...';

export class SlackRenderer {
  constructor(
    private readonly logger: AppLogger,
    private readonly statusProbe?: SlackStatusProbe,
  ) {}

  async addAcknowledgementReaction(
    client: SlackWebClientLike,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: env.SLACK_REACTION_NAME,
    });

    this.logger.debug('Added acknowledgement reaction to message %s', messageTs);
  }

  async showThinkingIndicator(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    loadingMessages: readonly string[] = DEFAULT_LOADING_MESSAGES,
  ): Promise<void> {
    await this.setUiState(client, channelId, {
      threadTs,
      status: 'Thinking...',
      loadingMessages: [...loadingMessages],
      clear: false,
    });
  }

  async setUiState(
    client: SlackWebClientLike,
    channelId: string,
    state: ClaudeUiState,
  ): Promise<void> {
    if (state.clear) {
      await this.clearUiState(client, channelId, state.threadTs);
      return;
    }

    await client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: state.threadTs,
      status: state.status ?? '',
      ...(state.loadingMessages ? { loading_messages: state.loadingMessages } : {}),
    });
    await this.statusProbe?.recordStatus({
      channelId,
      clear: false,
      kind: 'status',
      ...(state.loadingMessages ? { loadingMessages: [...state.loadingMessages] } : {}),
      recordedAt: new Date().toISOString(),
      status: state.status ?? '',
      threadTs: state.threadTs,
    });
  }

  async clearUiState(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    await client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      status: '',
    });
    await this.statusProbe?.recordStatus({
      channelId,
      clear: true,
      kind: 'status',
      recordedAt: new Date().toISOString(),
      status: '',
      threadTs,
    });
  }

  async upsertThreadProgressMessage(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    state: ClaudeUiState,
    progressMessageTs?: string,
  ): Promise<string | undefined> {
    if (state.clear) {
      if (progressMessageTs) {
        await this.deleteThreadProgressMessage(client, channelId, threadTs, progressMessageTs);
      }
      return undefined;
    }

    const text = this.buildProgressMessageText(state);
    const blocks = this.buildProgressMessageBlocks(state);

    if (progressMessageTs) {
      await client.chat.update({
        channel: channelId,
        ts: progressMessageTs,
        text,
        blocks,
      });
      await this.statusProbe?.recordProgressMessage({
        action: 'update',
        channelId,
        kind: 'progress-message',
        messageTs: progressMessageTs,
        recordedAt: new Date().toISOString(),
        text,
        threadTs,
      });
      return progressMessageTs;
    }

    const response = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
      blocks,
    });

    await this.statusProbe?.recordProgressMessage({
      action: 'post',
      channelId,
      kind: 'progress-message',
      ...(response.ts ? { messageTs: response.ts } : {}),
      recordedAt: new Date().toISOString(),
      text,
      threadTs,
    });

    return response.ts;
  }

  async deleteThreadProgressMessage(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    progressMessageTs: string,
  ): Promise<void> {
    await client.chat.delete({
      channel: channelId,
      ts: progressMessageTs,
    });
    await this.statusProbe?.recordProgressMessage({
      action: 'delete',
      channelId,
      kind: 'progress-message',
      messageTs: progressMessageTs,
      recordedAt: new Date().toISOString(),
      threadTs,
    });
  }

  async postThreadReply(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    text: string,
  ): Promise<string | undefined> {
    if (!text.trim()) {
      return undefined;
    }

    const response = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
    });

    return response.ts;
  }

  async startStream(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    recipientTeamId: string,
    recipientUserId: string,
  ): Promise<string> {
    const response = await client.chat.startStream({
      channel: channelId,
      thread_ts: threadTs,
      recipient_team_id: recipientTeamId,
      recipient_user_id: recipientUserId,
      task_display_mode: 'plan',
    });

    if (!response.ts) {
      throw new Error('Slack did not return a stream timestamp.');
    }

    return response.ts;
  }

  async appendText(
    client: SlackWebClientLike,
    channelId: string,
    streamTs: string,
    text: string,
  ): Promise<void> {
    if (!text.trim()) {
      return;
    }

    await client.chat.appendStream({
      channel: channelId,
      ts: streamTs,
      markdown_text: text,
    });
  }

  async appendChunks(
    client: SlackWebClientLike,
    channelId: string,
    streamTs: string,
    chunks: SlackStreamChunk[],
  ): Promise<void> {
    if (chunks.length === 0) return;

    await client.chat.appendStream({
      channel: channelId,
      ts: streamTs,
      chunks,
    });
  }

  async stopStream(
    client: SlackWebClientLike,
    channelId: string,
    streamTs: string,
    threadTs: string,
    markdownText?: string,
  ): Promise<void> {
    await client.chat.stopStream({
      channel: channelId,
      ts: streamTs,
      thread_ts: threadTs,
      ...(markdownText ? { markdown_text: markdownText } : {}),
    });
  }

  private buildProgressMessageText(state: ClaudeUiState): string {
    const status = (state.status ?? '').trim() || DEFAULT_PROGRESS_STATUS;
    const detail = this.collectRecentProgressDetails(state.loadingMessages, 1).at(0);

    return detail && detail !== status ? `${status} — ${detail}` : status;
  }

  private buildProgressMessageBlocks(state: ClaudeUiState): SlackBlock[] {
    const status = this.buildProgressStatusLine(state.status);
    const contextElements = this.buildProgressContextElements(state.loadingMessages, status);

    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: status,
        },
      },
      ...(contextElements.length > 0
        ? [
            {
              type: 'context' as const,
              elements: contextElements,
            },
          ]
        : []),
    ];
  }

  private buildProgressStatusLine(status: string | undefined): string {
    const normalized = status?.trim();
    if (!normalized) {
      return DEFAULT_PROGRESS_STATUS;
    }

    return normalized.endsWith('...') ? normalized : `${normalized}`;
  }

  private buildProgressContextElements(
    loadingMessages: readonly string[] | undefined,
    status: string,
  ): SlackMrkdwnTextObject[] {
    const details = this.collectRecentProgressDetails(loadingMessages, 3).filter(
      (detail) => detail !== status,
    );

    return details.slice(-2).map((detail) => ({
      type: 'mrkdwn',
      text: detail,
    }));
  }

  private collectRecentProgressDetails(
    loadingMessages: readonly string[] | undefined,
    maxItems: number,
  ): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();

    for (const rawMessage of [...(loadingMessages ?? [])].reverse()) {
      const message = rawMessage.trim();
      if (!message || seen.has(message)) {
        continue;
      }

      seen.add(message);
      deduped.unshift(message);

      if (deduped.length >= maxItems) {
        break;
      }
    }

    return deduped;
  }
}
