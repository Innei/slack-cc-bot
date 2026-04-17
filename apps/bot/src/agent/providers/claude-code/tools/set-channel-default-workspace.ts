import { zodParse } from '~/schemas/safe-parse.js';

import {
  type SetChannelDefaultWorkspaceToolInput,
  SetChannelDefaultWorkspaceToolInputSchema,
} from '../schemas/channel-preference-tools.js';

export const SET_CHANNEL_DEFAULT_WORKSPACE_TOOL_NAME = 'set_channel_default_workspace';
export const SET_CHANNEL_DEFAULT_WORKSPACE_TOOL_DESCRIPTION =
  'Set the default workspace for the current Slack channel. This workspace will be used as a fallback when no workspace is detected from the message text.';

export function parseSetChannelDefaultWorkspaceToolInput(
  input: unknown,
): SetChannelDefaultWorkspaceToolInput {
  return zodParse(
    SetChannelDefaultWorkspaceToolInputSchema,
    input,
    'SetChannelDefaultWorkspaceToolInput',
  );
}
