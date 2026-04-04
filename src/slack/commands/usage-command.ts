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

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
