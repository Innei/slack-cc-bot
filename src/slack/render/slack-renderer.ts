import { readFile } from 'node:fs/promises';

import { markdownToBlocks, splitBlocksWithText } from 'markdown-to-slack-blocks';

import type { GeneratedImageFile, GeneratedOutputFile, SessionUsageInfo } from '~/agent/types.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';

import type { SlackBlock, SlackFilesUploadV2Response, SlackWebClientLike } from '../types.js';
import type { SlackStatusProbe } from './status-probe.js';

export interface TrackedTask {
  details?: string | undefined;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  title: string;
}

interface RendererUiState {
  clear: boolean;
  composing?: boolean | undefined;
  loadingMessages?: string[] | undefined;
  status?: string | undefined;
  tasks?: Map<string, TrackedTask> | undefined;
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

  async removeAcknowledgementReaction(
    client: SlackWebClientLike,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await client.reactions.remove({
      channel: channelId,
      timestamp: messageTs,
      name: env.SLACK_REACTION_NAME,
    });

    this.logger.debug('Removed acknowledgement reaction from message %s', messageTs);
  }

  async addCompletionReaction(
    client: SlackWebClientLike,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: env.SLACK_REACTION_DONE_NAME,
    });

    this.logger.debug('Added completion reaction to message %s', messageTs);
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
      const fileId = await this.uploadGeneratedFile(client, channelId, threadTs, meta, 'image');
      if (!fileId) {
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

  async postGeneratedFiles(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    files: readonly GeneratedOutputFile[],
  ): Promise<GeneratedOutputFile[]> {
    const failed: GeneratedOutputFile[] = [];

    for (const meta of files) {
      const fileId = await this.uploadGeneratedFile(client, channelId, threadTs, meta, 'file');
      if (!fileId) {
        failed.push(meta);
      }
    }

    return failed;
  }

  async postSessionUsageInfo(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    usage: SessionUsageInfo,
  ): Promise<void> {
    const usageText = formatSessionUsageInfo(usage);
    if (!usageText) return;

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: usageText,
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: usageText }],
        },
      ],
    });
  }

  private buildProgressMessageText(state: RendererUiState): string {
    const status = (state.status ?? '').trim() || DEFAULT_PROGRESS_STATUS;
    const parts: string[] = [status];

    const taskLines = formatTaskLines(state.tasks);
    if (taskLines) parts.push(taskLines);

    const detail = this.collectRecentProgressDetails(state.loadingMessages, 1).at(0);
    if (detail && detail !== status) parts.push(detail);

    return parts.join(' — ');
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

    const taskLines = formatTaskLines(state.tasks);
    if (taskLines) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: taskLines }],
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

  private async uploadGeneratedFile(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    meta: GeneratedOutputFile,
    kind: 'file' | 'image',
  ): Promise<string | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(meta.path);
    } catch (error) {
      this.logger.warn('Failed to read generated %s at %s: %s', kind, meta.path, String(error));
      return undefined;
    }

    let response: SlackFilesUploadV2Response;
    try {
      response = await client.files.uploadV2({
        ...(kind === 'image' ? { alt_text: meta.fileName } : {}),
        channel_id: channelId,
        file: bytes,
        filename: meta.fileName,
        thread_ts: threadTs,
        title: meta.fileName,
      });
    } catch (error) {
      this.logger.warn('Failed to upload generated %s %s: %s', kind, meta.fileName, String(error));
      return undefined;
    }

    const fileId = extractUploadedFileId(response);
    if (!fileId) {
      this.logger.warn('Upload returned no file id for generated %s %s', kind, meta.fileName);
      return undefined;
    }

    return fileId;
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

function formatSessionUsageInfo(usage: SessionUsageInfo): string | undefined {
  if (!usage.modelUsage || usage.modelUsage.length === 0) {
    return undefined;
  }

  const parts: string[] = [];

  // Format duration
  const durationSec = (usage.durationMs / 1000).toFixed(1);
  parts.push(`${durationSec}s`);

  // Format total cost
  parts.push(`$${usage.totalCostUSD.toFixed(4)}`);

  // Format model usage details
  for (const model of usage.modelUsage) {
    const modelName = model.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const nonCachedInputAndOutputTokens = model.inputTokens + model.outputTokens;
    const cacheHitPct = model.cacheHitRate.toFixed(0);

    parts.push(
      `${modelName}: ${formatTokenCount(nonCachedInputAndOutputTokens)} non-cached in + out (${cacheHitPct}% cache)`,
    );
  }

  return parts.join('  \u00B7  ');
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}

const TASK_STATUS_ICON: Record<TrackedTask['status'], string> = {
  pending: '\u2610',
  in_progress: '\u2610',
  complete: '\u2611',
  error: '\u2612',
};

function formatTaskLines(tasks?: Map<string, TrackedTask>): string | undefined {
  if (!tasks || tasks.size === 0) return undefined;

  const lines: string[] = [];
  for (const [, task] of tasks) {
    const icon = TASK_STATUS_ICON[task.status];
    const detail = task.details ? ` — ${truncateTaskDetail(task.details)}` : '';
    lines.push(`${icon} ${task.title}${detail}`);
  }

  return lines.join('\n');
}

function truncateTaskDetail(detail: string, maxLength = 80): string {
  const normalized = detail.trim().replaceAll(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
