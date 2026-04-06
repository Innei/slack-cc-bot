import { zodParse } from '~/schemas/safe-parse.js';

import { type SaveMemoryToolInput, SaveMemoryToolInputSchema } from '../schemas/memory-tools.js';

export const SAVE_MEMORY_TOOL_NAME = 'save_memory';
export const SAVE_MEMORY_TOOL_DESCRIPTION =
  'Persist an important memory for future sessions. Categories: "preference" for user preferences, nicknames, identity, behavioral rules, and standing instructions (almost always scope "global"); "context" for conversation summaries; "decision" for key decisions; "observation" for notable facts; "task_completed" for completed tasks. Use "global" scope for cross-workspace knowledge, "workspace" scope for project-specific context. IMPORTANT: Always save detected preferences immediately as separate calls, and save a conversation summary before ending.';

export function parseSaveMemoryToolInput(input: unknown): SaveMemoryToolInput {
  return zodParse(SaveMemoryToolInputSchema, input, 'SaveMemoryToolInput');
}
