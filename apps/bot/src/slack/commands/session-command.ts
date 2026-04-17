import { getSessionState } from '~/session/types.js';

import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';

export function handleSessionCommand(
  text: string,
  deps: SlashCommandDependencies,
): SlashCommandResponse {
  const query = text.trim();

  if (!query) {
    return showSessionOverview(deps);
  }

  return lookupSession(query, deps);
}

function showSessionOverview(deps: SlashCommandDependencies): SlashCommandResponse {
  const totalSessions = deps.sessionStore.countAll();

  const lines = [
    '*Session Overview*',
    '',
    `• *Total sessions:* ${totalSessions}`,
    '',
    '_Use `/session <thread_ts>` to inspect a specific session._',
  ];

  return {
    response_type: 'ephemeral',
    text: lines.join('\n'),
  };
}

function lookupSession(threadTs: string, deps: SlashCommandDependencies): SlashCommandResponse {
  const session = deps.sessionStore.get(threadTs);

  if (!session) {
    return {
      response_type: 'ephemeral',
      text: `No session found for thread \`${threadTs}\`.`,
    };
  }

  const state = getSessionState(session);
  const lines = [
    `*Session:* \`${session.threadTs}\``,
    '',
    `• *Channel:* \`${session.channelId}\``,
    `• *State:* ${state}`,
    `• *Workspace:* ${session.workspaceLabel ? `\`${session.workspaceLabel}\`` : '_not set_'}`,
    `• *Workspace Path:* ${session.workspacePath ? `\`${session.workspacePath}\`` : '_not set_'}`,
    `• *Provider Session:* ${session.providerSessionId ? `\`${session.providerSessionId.slice(0, 16)}...\`` : '_none_'}`,
    `• *Created:* ${session.createdAt}`,
    `• *Updated:* ${session.updatedAt}`,
  ];

  return {
    response_type: 'ephemeral',
    text: lines.join('\n'),
  };
}
