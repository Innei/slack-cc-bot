import { zodParse } from '~/schemas/safe-parse.js';

import {
  type RecallMemoryToolInput,
  RecallMemoryToolInputSchema,
} from '../schemas/memory-tools.js';

export const RECALL_MEMORY_TOOL_NAME = 'recall_memory';
export const RECALL_MEMORY_TOOL_DESCRIPTION =
  'Retrieve memories from previous sessions. Supports both global (cross-workspace) and workspace-scoped memories.';

export function parseRecallMemoryToolInput(input: unknown): RecallMemoryToolInput {
  return zodParse(RecallMemoryToolInputSchema, input, 'RecallMemoryToolInput');
}
