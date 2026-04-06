import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentExecutionRequest } from '~/agent/types.js';
import type { LoadedThreadImage } from '~/slack/context/thread-context-loader.js';

import {
  imageCollectionProcessor,
  memoryContextProcessor,
  memoryInstructionProcessor,
  sessionContextProcessor,
  systemRoleProcessor,
  threadContextProcessor,
  toolDeclarationProcessor,
  userMessageProcessor,
} from './processors.js';
import type { PromptPipelineContext, PromptProcessor } from './types.js';

// ---------------------------------------------------------------------------
// Default processor ordering
// ---------------------------------------------------------------------------

/**
 * The default ordered list of processors that assemble the prompt.
 *
 * Phase 1 — System prompt (constant, cache-friendly):
 *   systemRole → toolDeclaration → memoryInstruction
 *
 * Phase 2 — Context injection (dynamic, in user message area):
 *   sessionContext → memoryContext → threadContext
 *
 * Phase 3 — User message:
 *   userMessage
 *
 * Phase 4 — Images:
 *   imageCollection
 */
export const DEFAULT_PROMPT_PROCESSORS: PromptProcessor[] = [
  // Phase 1 — System (constant)
  systemRoleProcessor,
  toolDeclarationProcessor,
  memoryInstructionProcessor,

  // Phase 2 — Context (dynamic, injected into user prompt)
  sessionContextProcessor,
  memoryContextProcessor,
  threadContextProcessor,

  // Phase 3 — User message
  userMessageProcessor,

  // Phase 4 — Images
  imageCollectionProcessor,
];

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

export interface PromptPipelineOutput {
  /** Fully assembled system prompt — must be identical across turns. */
  systemPrompt: string;
  /** User-facing prompt: either a plain string or multimodal async iterable. */
  userPrompt: string | AsyncIterable<SDKUserMessage>;
}

function createPipelineContext(request: AgentExecutionRequest): PromptPipelineContext {
  return {
    contextParts: [],
    imageLoadFailures: [],
    images: [],
    request,
    systemParts: [],
    userMessageParts: [],
  };
}

function assembleUserText(ctx: PromptPipelineContext): string {
  const sections: string[] = [];

  if (ctx.contextParts.length > 0) {
    sections.push(ctx.contextParts.join('\n\n'));
  }

  if (ctx.userMessageParts.length > 0) {
    sections.push(`<user_message>\n${ctx.userMessageParts.join('\n')}\n</user_message>`);
  }

  let text = sections.join('\n\n');

  if (ctx.imageLoadFailures.length > 0) {
    text +=
      '\n\nNote: Some Slack thread images could not be loaded:\n' +
      ctx.imageLoadFailures.map((line) => `- ${line}`).join('\n');
  }

  return text;
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

/**
 * Run the prompt pipeline and produce the final system + user prompts.
 *
 * @param request  The agent execution request.
 * @param processors  Ordered list of processors (defaults to {@link DEFAULT_PROMPT_PROCESSORS}).
 */
export function runPromptPipeline(
  request: AgentExecutionRequest,
  processors: PromptProcessor[] = DEFAULT_PROMPT_PROCESSORS,
): PromptPipelineOutput {
  const ctx = createPipelineContext(request);

  for (const processor of processors) {
    processor.process(ctx);
  }

  const systemPrompt = ctx.systemParts.join('\n');
  const userText = assembleUserText(ctx);

  const userPrompt =
    ctx.images.length > 0 ? yieldMultimodalMessages(userText, ctx.images) : userText;

  return { systemPrompt, userPrompt };
}
