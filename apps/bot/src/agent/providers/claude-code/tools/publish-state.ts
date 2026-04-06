import type { z } from 'zod';

import { zodParse } from '~/schemas/safe-parse.js';

import { ClaudeUiStateSchema } from '../schemas/publish-state.js';

export {
  SLACK_UI_STATE_TOOL_DESCRIPTION,
  SLACK_UI_STATE_TOOL_NAME,
} from '~/agent/slack-runtime-tools.js';

export type SlackUiStateToolInput = z.infer<typeof ClaudeUiStateSchema>;

export function parseSlackUiStateToolInput(input: unknown): SlackUiStateToolInput {
  return zodParse(ClaudeUiStateSchema, input, 'ClaudeUiState');
}
