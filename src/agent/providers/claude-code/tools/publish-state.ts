import type { z } from 'zod';

import { ClaudeUiStateSchema } from '~/schemas/claude/publish-state.js';

export const SLACK_UI_STATE_TOOL_NAME = 'publish_state';
export const SLACK_UI_STATE_TOOL_DESCRIPTION =
  'Publish structured Slack UI state updates, including status text and rotating loading messages.';

export type SlackUiStateToolInput = z.infer<typeof ClaudeUiStateSchema>;

export function parseSlackUiStateToolInput(input: unknown): SlackUiStateToolInput {
  return ClaudeUiStateSchema.parse(input);
}
