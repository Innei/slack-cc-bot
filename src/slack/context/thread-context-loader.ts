import type { AppLogger } from '~/logger/index.js';

import type { SlackWebClientLike } from '../types.js';
import {
  type NormalizedThreadImage,
  type NormalizedThreadMessage,
  normalizeThreadMessages,
} from './message-normalizer.js';
import { downloadSlackImage } from './slack-image-downloader.js';

export interface LoadedThreadImage extends NormalizedThreadImage {
  base64Data: string;
  messageIndex: number;
}

export interface NormalizedThreadContext {
  channelId: string;
  imageLoadFailures: string[];
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
    }

    return {
      channelId,
      threadTs,
      messages,
      loadedImages,
      imageLoadFailures,
      renderedPrompt: renderThreadPrompt(messages),
    };
  }
}

function renderThreadPrompt(messages: NormalizedThreadMessage[]): string {
  const filtered = messages.filter((message) => message.text.trim() !== '');
  const renderedLines = filtered.flatMap((message, index) => {
    const header = `Message ${index + 1} | ts=${message.ts} | author=${message.authorId ?? 'unknown'}`;
    return [header, message.text];
  });

  return ['Slack thread context:', ...renderedLines].join('\n');
}
