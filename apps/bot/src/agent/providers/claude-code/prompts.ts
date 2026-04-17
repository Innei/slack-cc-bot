import { assemblePrompt } from '~/agent/prompt/index.js';
import type { AgentExecutionRequest } from '~/agent/types.js';

export function buildPrompt(request: AgentExecutionRequest): string {
  return assemblePrompt(request).userText;
}

export function buildSystemPrompt(request: AgentExecutionRequest): string {
  return assemblePrompt(request).systemPrompt;
}
