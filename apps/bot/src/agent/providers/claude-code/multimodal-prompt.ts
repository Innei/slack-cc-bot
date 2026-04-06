import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentExecutionRequest } from '~/agent/types.js';

import { createClaudePromptInput } from './prompt-input.js';

export function buildClaudePromptInput(
  request: AgentExecutionRequest,
): string | AsyncIterable<SDKUserMessage> {
  return createClaudePromptInput(request).userPrompt;
}
