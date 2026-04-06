import { zodParse } from '~/schemas/safe-parse.js';

import { type SaveMemoryToolInput, SaveMemoryToolInputSchema } from '../schemas/memory-tools.js';

export {
  SAVE_MEMORY_TOOL_DESCRIPTION,
  SAVE_MEMORY_TOOL_NAME,
} from '~/agent/slack-runtime-tools.js';

export function parseSaveMemoryToolInput(input: unknown): SaveMemoryToolInput {
  return zodParse(SaveMemoryToolInputSchema, input, 'SaveMemoryToolInput');
}
