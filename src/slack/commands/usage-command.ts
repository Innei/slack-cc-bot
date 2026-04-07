import { formatUptime } from '~/util/format.js';

import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';

const startTime = Date.now();

export function handleUsageCommand(
  _text: string,
  deps: SlashCommandDependencies,
): SlashCommandResponse {
  const sessionCount = deps.sessionStore.countAll();
  const memoryCount = deps.memoryStore.countAll();
  const repoCount = deps.workspaceResolver.listRepos().length;
  const uptimeMs = Date.now() - startTime;
  const uptimeFormatted = formatUptime(uptimeMs);

  const lines = [
    '*Bot Usage*',
    '',
    `• *Sessions:* ${sessionCount}`,
    `• *Memories:* ${memoryCount}`,
    `• *Repositories:* ${repoCount}`,
    `• *Uptime:* ${uptimeFormatted}`,
  ];

  return {
    response_type: 'ephemeral',
    text: lines.join('\n'),
  };
}
