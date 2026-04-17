import { zodParse } from '~/schemas/safe-parse.js';

import {
  type RecallMemoryToolInput,
  RecallMemoryToolInputSchema,
} from '../schemas/memory-tools.js';

export {
  RECALL_MEMORY_TOOL_DESCRIPTION,
  RECALL_MEMORY_TOOL_NAME,
} from '~/agent/slack-runtime-tools.js';

export function parseRecallMemoryToolInput(input: unknown): RecallMemoryToolInput {
  return zodParse(RecallMemoryToolInputSchema, input, 'RecallMemoryToolInput');
}
