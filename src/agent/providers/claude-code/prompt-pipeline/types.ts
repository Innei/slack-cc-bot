import type { AgentExecutionRequest } from '~/agent/types.js';
import type { LoadedThreadImage } from '~/slack/context/thread-context-loader.js';

/**
 * Mutable context threaded through every processor in the prompt pipeline.
 *
 * - `systemParts` — assembled into the system prompt (must remain **constant**
 *   across all turns within a session so the Anthropic prompt-cache can hit).
 * - `contextParts` — dynamic context injected *before* the user message
 *   (memories, thread history, workspace state, …).
 * - `userMessageParts` — the user's actual message content.
 * - `images` — multimodal image payloads yielded as separate SDK messages.
 * - `imageLoadFailures` — failure notes appended to the primary text message.
 */
export interface PromptPipelineContext {
  contextParts: string[];
  imageLoadFailures: string[];
  images: LoadedThreadImage[];
  request: AgentExecutionRequest;
  systemParts: string[];
  userMessageParts: string[];
}

/**
 * A single processor in the prompt assembly pipeline.
 *
 * Processors are executed in declaration order. Each processor mutates the
 * shared {@link PromptPipelineContext} — appending to `systemParts`,
 * `contextParts`, or `userMessageParts` as appropriate.
 */
export interface PromptProcessor {
  /** Human-readable name for logging / debugging. */
  name: string;
  /** Mutate `ctx` to inject this processor's contribution. */
  process: (ctx: PromptPipelineContext) => void;
}
