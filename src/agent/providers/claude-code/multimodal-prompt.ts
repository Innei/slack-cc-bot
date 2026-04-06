import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentExecutionRequest } from '~/agent/types.js';
import type { LoadedThreadImage } from '~/slack/context/thread-context-loader.js';

import { buildPrompt } from './prompts.js';

type AllowedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeImageMediaType(raw: string): AllowedImageMediaType {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? 'image/png';
  if (base === 'image/jpg' || base === 'image/jpeg') {
    return 'image/jpeg';
  }
  if (base === 'image/png' || base === 'image/gif' || base === 'image/webp') {
    return base;
  }
  return 'image/png';
}

function buildImageLoadFailureNote(failures: string[]): string {
  if (failures.length === 0) {
    return '';
  }
  return (
    '\n\nNote: Some Slack thread images could not be loaded:\n' +
    failures.map((line) => `- ${line}`).join('\n')
  );
}

/** Coerce thread context data to a real array so `for…of` never sees a non-iterable value. */
function normalizeLoadedImages(raw: unknown): LoadedThreadImage[] {
  if (raw == null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'object') {
    if (Symbol.iterator in raw) {
      return Array.from(raw as Iterable<LoadedThreadImage>);
    }
    const maybeLen = (raw as { length?: unknown }).length;
    if (typeof maybeLen === 'number' && maybeLen >= 0) {
      return Array.from(raw as ArrayLike<LoadedThreadImage>);
    }
    const o = raw as Partial<LoadedThreadImage>;
    if (
      typeof o.base64Data === 'string' &&
      typeof o.fileName === 'string' &&
      typeof o.messageTs === 'string'
    ) {
      return [raw as LoadedThreadImage];
    }
  }
  return [];
}

async function* yieldMultimodalMessages(
  request: AgentExecutionRequest,
  loadedImages: LoadedThreadImage[],
  imageLoadFailures: string[],
): AsyncIterable<SDKUserMessage> {
  const basePrompt = buildPrompt(request);
  const primaryText = basePrompt + buildImageLoadFailureNote(imageLoadFailures);

  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: primaryText,
    },
  };

  for (const img of loadedImages) {
    const preamble = `Image from Slack thread message ts=${img.messageTs} (filename: ${img.fileName})`;
    const media_type = normalizeImageMediaType(img.mimeType);
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: preamble },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type,
              data: img.base64Data,
            },
          },
        ],
      },
    };
  }
}

function normalizeImageLoadFailures(raw: unknown): string[] {
  if (raw == null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((line): line is string => typeof line === 'string');
  }
  return [];
}

export function buildClaudePromptInput(
  request: AgentExecutionRequest,
): string | AsyncIterable<SDKUserMessage> {
  const loadedImages = normalizeLoadedImages(request.threadContext.loadedImages);
  const imageLoadFailures = normalizeImageLoadFailures(request.threadContext.imageLoadFailures);

  if (loadedImages.length === 0) {
    const base = buildPrompt(request);
    return base + buildImageLoadFailureNote(imageLoadFailures);
  }
  return yieldMultimodalMessages(request, loadedImages, imageLoadFailures);
}
