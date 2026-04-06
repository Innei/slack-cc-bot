import type { z } from 'zod';

import { zodParse } from '~/schemas/safe-parse.js';

import { ClaudeUiStateSchema } from '../schemas/publish-state.js';

export const SLACK_UI_STATE_TOOL_NAME = 'publish_state';
export const SLACK_UI_STATE_TOOL_DESCRIPTION =
  'Publish structured Slack UI state updates, including status text and rotating loading messages.';

export type SlackUiStateToolInput = z.infer<typeof ClaudeUiStateSchema>;

export function parseSlackUiStateToolInput(input: unknown): SlackUiStateToolInput {
  return zodParse(ClaudeUiStateSchema, input, 'ClaudeUiState');
}
