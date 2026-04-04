import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';

const MAX_DISPLAY_REPOS = 30;

export function handleWorkspaceCommand(
  text: string,
  deps: SlashCommandDependencies,
): SlashCommandResponse {
  const subcommand = text.trim();

  if (!subcommand || subcommand === 'list') {
    return listWorkspaces(deps);
  }

  return lookupWorkspace(subcommand, deps);
}

function listWorkspaces(deps: SlashCommandDependencies): SlashCommandResponse {
  const repos = deps.workspaceResolver.listRepos();

  if (repos.length === 0) {
    return {
      response_type: 'ephemeral',
      text: 'No repositories found under the configured repo root.',
    };
  }

  const displayed = repos.slice(0, MAX_DISPLAY_REPOS);
  const lines = [
    `*Available Workspaces* (${repos.length})`,
    '',
    ...displayed.map((repo) => `• \`${repo.label}\``),
  ];

  if (repos.length > MAX_DISPLAY_REPOS) {
    lines.push(`_...and ${repos.length - MAX_DISPLAY_REPOS} more._`);
  }

  lines.push('', '_Use `/workspace <name>` to see details about a specific repo._');

  return {
    response_type: 'ephemeral',
    text: lines.join('\n'),
  };
}

function lookupWorkspace(query: string, deps: SlashCommandDependencies): SlashCommandResponse {
  const resolution = deps.workspaceResolver.resolveManualInput(query, 'manual');

  if (resolution.status === 'missing') {
    return {
      response_type: 'ephemeral',
      text: `No workspace found matching \`${query}\`.`,
    };
  }

  if (resolution.status === 'ambiguous') {
    const labels = resolution.candidates
      .slice(0, 5)
      .map((c) => `\`${c.label}\``)
      .join(', ');
    return {
      response_type: 'ephemeral',
      text: `Multiple workspaces match \`${query}\`: ${labels}. Be more specific.`,
    };
  }

  const ws = resolution.workspace;
  const memoryCount = deps.memoryStore.countAll(ws.repo.id);

  const lines = [
    `*Workspace:* \`${ws.workspaceLabel}\``,
    '',
    `• *Repo ID:* \`${ws.repo.id}\``,
    `• *Path:* \`${ws.workspacePath}\``,
    `• *Memories:* ${memoryCount}`,
  ];

  if (ws.repo.aliases.length > 0) {
    lines.push(`• *Aliases:* ${ws.repo.aliases.map((a) => `\`${a}\``).join(', ')}`);
  }

  return {
    response_type: 'ephemeral',
    text: lines.join('\n'),
  };
}
