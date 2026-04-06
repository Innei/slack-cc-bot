import type { AgentExecutionRequest } from '~/agent/types.js';

import {
  fileContextProcessor,
  imageCollectionProcessor,
  memoryContextProcessor,
  memoryInstructionProcessor,
  sessionContextProcessor,
  systemRoleProcessor,
  threadContextProcessor,
  toolDeclarationProcessor,
  userMessageProcessor,
} from './processors.js';
import type { PromptAssembly, PromptAssemblyContext, PromptProcessor } from './types.js';

export const DEFAULT_PROMPT_PROCESSORS: PromptProcessor[] = [
  systemRoleProcessor,
  toolDeclarationProcessor,
  memoryInstructionProcessor,
  sessionContextProcessor,
  memoryContextProcessor,
  threadContextProcessor,
  fileContextProcessor,
  userMessageProcessor,
  imageCollectionProcessor,
];

function createPipelineContext(request: AgentExecutionRequest): PromptAssemblyContext {
  return {
    contextParts: [],
    imageLoadFailures: [],
    images: [],
    request,
    systemParts: [],
    userMessageParts: [],
  };
}

function assembleUserText(ctx: PromptAssemblyContext): string {
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

export function assemblePrompt(
  request: AgentExecutionRequest,
  processors: PromptProcessor[] = DEFAULT_PROMPT_PROCESSORS,
): PromptAssembly {
  const ctx = createPipelineContext(request);

  for (const processor of processors) {
    processor.process(ctx);
  }

  return {
    images: ctx.images,
    systemPrompt: ctx.systemParts.join('\n'),
    userText: assembleUserText(ctx),
  };
}
