import type { AgentExecutionRequest } from '~/agent/types.js';
import type { LoadedThreadImage } from '~/slack/context/thread-context-loader.js';

export interface PromptAssembly {
  images: LoadedThreadImage[];
  systemPrompt: string;
  userText: string;
}

export interface PromptAssemblyContext {
  contextParts: string[];
  imageLoadFailures: string[];
  images: LoadedThreadImage[];
  request: AgentExecutionRequest;
  systemParts: string[];
  userMessageParts: string[];
}

export interface PromptProcessor {
  name: string;
  process: (ctx: PromptAssemblyContext) => void;
}
