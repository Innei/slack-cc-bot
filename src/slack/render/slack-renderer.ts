import { env } from '../../env/server.js';
import type { AppLogger } from '../../logger/index.js';
import type { ClaudeUiState } from '../../schemas/claude/publish-state.js';
import type { SlackStreamChunk, SlackWebClientLike } from '../types.js';
import type { SlackStatusProbe } from './status-probe.js';

const DEFAULT_LOADING_MESSAGES = [
  'Reading the thread context...',
  'Planning the next steps...',
  'Generating a response...',
] as const;

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
      recordedAt: new Date().toISOString(),
      status: '',
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
}
