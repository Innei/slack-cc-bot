import {
  type SaveMemoryToolInput,
  SaveMemoryToolInputSchema,
} from '../../schemas/claude/memory-tools.js';

export const SAVE_MEMORY_TOOL_NAME = 'save_memory';
export const SAVE_MEMORY_TOOL_DESCRIPTION =
  'Persist an important workspace memory for future sessions, including decisions, observations, and completed tasks.';

export function parseSaveMemoryToolInput(input: unknown): SaveMemoryToolInput {
  return SaveMemoryToolInputSchema.parse(input);
}
