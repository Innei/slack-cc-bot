import type { AppLogger } from '~/logger/index.js';

import type { SlackWebClientLike } from '../types.js';
import {
  type NormalizedThreadFile,
  type NormalizedThreadImage,
  type NormalizedThreadMessage,
  normalizeThreadMessages,
} from './message-normalizer.js';
import { downloadSlackImage } from './slack-image-downloader.js';
import { downloadSlackTextFile } from './slack-text-file-downloader.js';

export interface LoadedThreadImage extends NormalizedThreadImage {
  base64Data: string;
  messageIndex: number;
}

export interface LoadedThreadFile extends NormalizedThreadFile {
  content: string;
  messageIndex: number;
  truncated: boolean;
}

export interface NormalizedThreadContext {
  channelId: string;
  fileLoadFailures: string[];
  imageLoadFailures: string[];
  loadedFiles: LoadedThreadFile[];
  loadedImages: LoadedThreadImage[];
  messages: NormalizedThreadMessage[];
  renderedPrompt: string;
  threadTs: string;
}

export class SlackThreadContextLoader {
  constructor(private readonly logger: AppLogger) {}

  async loadThread(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
  ): Promise<NormalizedThreadContext> {
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: 200,
    });

    const messages = normalizeThreadMessages(response.messages ?? []);
    this.logger.debug(
      'Loaded %d normalized Slack messages for thread %s',
      messages.length,
      threadTs,
    );

    const loadedImages: LoadedThreadImage[] = [];
    const imageLoadFailures: string[] = [];
    const loadedFiles: LoadedThreadFile[] = [];
    const fileLoadFailures: string[] = [];

    for (const [idx, message] of messages.entries()) {
      const messageIndex = idx + 1;
      for (const image of message.images) {
        if (!image.slackUrl) {
          const msg = `Missing private URL for Slack image file ${image.fileId} (message ${messageIndex})`;
          this.logger.warn(msg);
          imageLoadFailures.push(msg);
          continue;
        }
        try {
          const { base64Data, mimeType } = await downloadSlackImage(image.slackUrl);
          loadedImages.push({
            ...image,
            base64Data,
            mimeType,
            messageIndex,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const msg = `Failed to download Slack image ${image.fileId} (${image.fileName}): ${detail}`;
          this.logger.warn(msg);
          imageLoadFailures.push(msg);
        }
      }
      for (const file of message.files) {
        if (!file.slackUrl) {
          const msg = `Missing private URL for Slack file ${file.fileId} (message ${messageIndex})`;
          this.logger.warn(msg);
          fileLoadFailures.push(msg);
          continue;
        }
        try {
          const { mimeType, text, truncated } = await downloadSlackTextFile(file.slackUrl);
          loadedFiles.push({
            ...file,
            content: text,
            messageIndex,
            mimeType: mimeType || file.mimeType,
            truncated,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const msg = `Failed to download Slack file ${file.fileId} (${file.fileName}): ${detail}`;
          this.logger.warn(msg);
          fileLoadFailures.push(msg);
        }
      }
    }

    return {
      channelId,
      fileLoadFailures,
      threadTs,
      loadedFiles,
      messages,
      loadedImages,
      imageLoadFailures,
      renderedPrompt: renderThreadPrompt(messages),
    };
  }
}

export function renderThreadPrompt(messages: NormalizedThreadMessage[]): string {
  const renderedLines = messages.flatMap((message, index) => {
    const body = renderMessageBody(message).trim();
    if (!body) {
      return [];
    }
    const header = `Message ${index + 1} | ts=${message.ts} | author=${message.authorId ?? 'unknown'}`;
    return [header, body];
  });

  return ['Slack thread context:', ...renderedLines].join('\n');
}

function renderMessageBody(message: NormalizedThreadMessage): string {
  const lines: string[] = [];
  if (message.text.trim()) {
    lines.push(message.text.trim());
  }
  if (message.files.length > 0) {
    lines.push(`Attached files: ${message.files.map((file) => file.fileName).join(', ')}`);
  }
  if (message.images.length > 0) {
    lines.push(`Attached images: ${message.images.map((image) => image.fileName).join(', ')}`);
  }
  return lines.join('\n');
}
