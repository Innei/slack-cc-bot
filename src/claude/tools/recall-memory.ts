import {
  type RecallMemoryToolInput,
  RecallMemoryToolInputSchema,
} from '../../schemas/claude/memory-tools.js';

export const RECALL_MEMORY_TOOL_NAME = 'recall_memory';
export const RECALL_MEMORY_TOOL_DESCRIPTION =
  'Retrieve workspace memories from previous sessions, including completed tasks, decisions, and observations.';

export function parseRecallMemoryToolInput(input: unknown): RecallMemoryToolInput {
  return RecallMemoryToolInputSchema.parse(input);
}
