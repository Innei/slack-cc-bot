import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { assemblePrompt } from '~/agent/prompt/index.js';
import type { AgentExecutionRequest } from '~/agent/types.js';
import type { LoadedThreadImage } from '~/slack/context/thread-context-loader.js';

export interface ClaudePromptInput {
  systemPrompt: string;
  userPrompt: string | AsyncIterable<SDKUserMessage>;
}

type AllowedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeImageMediaType(raw: string): AllowedImageMediaType {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? 'image/png';
  if (base === 'image/jpg' || base === 'image/jpeg') return 'image/jpeg';
  if (base === 'image/png' || base === 'image/gif' || base === 'image/webp') return base;
  return 'image/png';
}

async function* yieldMultimodalMessages(
  primaryText: string,
  images: LoadedThreadImage[],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: primaryText },
  };

  for (const img of images) {
    const preamble = `Image from Slack thread message ts=${img.messageTs} (filename: ${img.fileName})`;
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
              media_type: normalizeImageMediaType(img.mimeType),
              data: img.base64Data,
            },
          },
        ],
      },
    };
  }
}

export function createClaudePromptInput(request: AgentExecutionRequest): ClaudePromptInput {
  const prompt = assemblePrompt(request);

  return {
    systemPrompt: prompt.systemPrompt,
    userPrompt:
      prompt.images.length > 0
        ? yieldMultimodalMessages(prompt.userText, prompt.images)
        : prompt.userText,
  };
}
