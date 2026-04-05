import {
  type RecallMemoryToolInput,
  RecallMemoryToolInputSchema,
} from '~/schemas/claude/memory-tools.js';

export const RECALL_MEMORY_TOOL_NAME = 'recall_memory';
export const RECALL_MEMORY_TOOL_DESCRIPTION =
  'Retrieve memories from previous sessions. Supports both global (cross-workspace) and workspace-scoped memories.';

export function parseRecallMemoryToolInput(input: unknown): RecallMemoryToolInput {
  return RecallMemoryToolInputSchema.parse(input);
}
