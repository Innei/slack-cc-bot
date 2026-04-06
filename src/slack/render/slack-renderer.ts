import { readFile } from 'node:fs/promises';

import { markdownToBlocks, splitBlocksWithText } from 'markdown-to-slack-blocks';

import type { GeneratedImageFile } from '~/agent/types.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';

import type { SlackBlock, SlackFilesUploadV2Response, SlackWebClientLike } from '../types.js';
import type { SlackStatusProbe } from './status-probe.js';

interface RendererUiState {
  clear: boolean;
  composing?: boolean | undefined;
  loadingMessages?: string[] | undefined;
  status?: string | undefined;
  threadTs: string;
  toolHistory?: Map<string, number> | undefined;
}

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
    state: RendererUiState,
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
    state: RendererUiState,
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

  async finalizeThreadProgressMessage(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    progressMessageTs: string,
    toolHistory?: Map<string, number>,
  ): Promise<void> {
    const summaryLine = formatToolHistorySummary(toolHistory) ?? 'Done';
    const text = `\u2705 ${summaryLine}`;
    const blocks: SlackBlock[] = [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text }],
      },
    ];

    await client.chat.update({
      channel: channelId,
      ts: progressMessageTs,
      text,
      blocks,
    });
    await this.statusProbe?.recordProgressMessage({
      action: 'finalize',
      channelId,
      kind: 'progress-message',
      messageTs: progressMessageTs,
      recordedAt: new Date().toISOString(),
      text,
      threadTs,
    });
  }

  async finalizeThreadProgressMessageStopped(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    progressMessageTs: string,
    _toolHistory?: Map<string, number>,
  ): Promise<void> {
    const text = 'Stopped by user.';
    const blocks: SlackBlock[] = [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text }],
      },
    ];

    await client.chat.update({
      channel: channelId,
      ts: progressMessageTs,
      text,
      blocks,
    });
    await this.statusProbe?.recordProgressMessage({
      action: 'stopped',
      channelId,
      kind: 'progress-message',
      messageTs: progressMessageTs,
      recordedAt: new Date().toISOString(),
      text,
      threadTs,
    });
  }

  async postThreadReply(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    text: string,
    options?: { workspaceLabel?: string; toolHistory?: Map<string, number> },
  ): Promise<string | undefined> {
    if (!text.trim()) {
      return undefined;
    }

    const blocks = markdownToBlocks(normalizeUnderscoreEmphasis(text), {
      preferSectionBlocks: false,
    });
    const batches = splitBlocksWithText(blocks);

    if (batches.length > 0) {
      const prefixBlocks: Array<{
        type: 'context';
        elements: Array<{ type: 'mrkdwn'; text: string }>;
      }> = [];

      if (options?.workspaceLabel) {
        prefixBlocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_Working in ${options.workspaceLabel}_` }],
        });
      }

      const toolSummary = formatToolHistorySummary(options?.toolHistory);
      if (toolSummary) {
        prefixBlocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: toolSummary }],
        });
      }

      if (prefixBlocks.length > 0) {
        const first = batches[0]!;
        first.blocks = [...prefixBlocks, ...(first.blocks ?? [])];
      }
    }

    let lastTs: string | undefined;
    for (const batch of batches) {
      const response = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: batch.text,
        blocks: batch.blocks,
      });
      lastTs = response.ts;
    }

    return lastTs;
  }

  async postGeneratedImages(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    files: readonly GeneratedImageFile[],
  ): Promise<GeneratedImageFile[]> {
    const failed: GeneratedImageFile[] = [];

    for (const meta of files) {
      let bytes: Buffer;
      try {
        bytes = await readFile(meta.path);
      } catch (error) {
        this.logger.warn('Failed to read generated image at %s: %s', meta.path, String(error));
        failed.push(meta);
        continue;
      }

      let response: SlackFilesUploadV2Response;
      try {
        response = await client.files.uploadV2({
          alt_text: meta.fileName,
          channel_id: channelId,
          file: bytes,
          filename: meta.fileName,
          thread_ts: threadTs,
          title: meta.fileName,
        });
      } catch (error) {
        this.logger.warn('Failed to upload generated image %s: %s', meta.fileName, String(error));
        failed.push(meta);
        continue;
      }

      const fileId = extractUploadedFileId(response);
      if (!fileId) {
        this.logger.warn(
          'Upload returned no file id for generated image %s; skipping image block',
          meta.fileName,
        );
        failed.push(meta);
        continue;
      }

      try {
        await client.chat.postMessage({
          blocks: [
            {
              alt_text: meta.fileName,
              slack_file: { id: fileId },
              type: 'image',
            },
          ],
          channel: channelId,
          text: meta.fileName,
          thread_ts: threadTs,
        });
      } catch (error) {
        this.logger.warn(
          'Failed to post Slack image block for %s: %s',
          meta.fileName,
          String(error),
        );
        failed.push(meta);
      }
    }

    return failed;
  }

  private buildProgressMessageText(state: RendererUiState): string {
    const status = (state.status ?? '').trim() || DEFAULT_PROGRESS_STATUS;
    const detail = this.collectRecentProgressDetails(state.loadingMessages, 1).at(0);

    return detail && detail !== status ? `${status} — ${detail}` : status;
  }

  private buildProgressMessageBlocks(state: RendererUiState): SlackBlock[] {
    const blocks: SlackBlock[] = [];

    const historySummary = formatToolHistorySummary(state.toolHistory);
    if (historySummary) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: historySummary }],
      });
    } else {
      const status = state.status?.trim() || DEFAULT_PROGRESS_STATUS;
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: status }],
      });
    }

    const detail = this.collectRecentProgressDetails(state.loadingMessages, 1).at(0);
    if (detail) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: detail }],
      });
    }

    return blocks;
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

const FENCED_CODE_BLOCK = /^(`{3}|~{3})[^\n]*\n.+?\n\1/gms;
const INLINE_CODE = /`[^\n`]+`/g;
const UNDERSCORE_EMPHASIS = /\b_([^\n_]+)_\b/g;

export function normalizeUnderscoreEmphasis(markdown: string): string {
  const codeRanges: Array<[number, number]> = [];
  for (const match of markdown.matchAll(FENCED_CODE_BLOCK)) {
    codeRanges.push([match.index, match.index + match[0].length]);
  }
  for (const match of markdown.matchAll(INLINE_CODE)) {
    codeRanges.push([match.index, match.index + match[0].length]);
  }

  return markdown.replaceAll(UNDERSCORE_EMPHASIS, (full, inner, offset) => {
    if (codeRanges.some(([start, end]) => offset >= start && offset < end)) {
      return full;
    }
    return `*${inner}*`;
  });
}

function extractUploadedFileId(response: SlackFilesUploadV2Response): string | undefined {
  const fromFiles = response.files?.find((f) => f.id?.trim())?.id;
  if (fromFiles) {
    return fromFiles;
  }
  const fromFile = response.file?.id?.trim();
  return fromFile || undefined;
}

function formatToolHistorySummary(toolHistory?: Map<string, number>): string | undefined {
  if (!toolHistory || toolHistory.size === 0) {
    return undefined;
  }

  const items: string[] = [];
  for (const [verb, count] of toolHistory) {
    items.push(`${verb} x${count}`);
  }

  return items.join('  \u00B7  ');
}
