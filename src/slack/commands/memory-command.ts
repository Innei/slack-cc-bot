import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';

const MAX_DISPLAY_MEMORIES = 10;

export function handleMemoryCommand(
  text: string,
  deps: SlashCommandDependencies,
): SlashCommandResponse {
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? '';

  if (!subcommand) {
    return {
      response_type: 'ephemeral',
      text: [
        '*Memory Commands*',
        '',
        '• `/memory list <repo>` — show recent memories for a repo',
        '• `/memory count <repo>` — show memory count for a repo',
        '• `/memory clear <repo>` — clear all memories for a repo',
      ].join('\n'),
    };
  }

  if (subcommand === 'list') {
    return listMemories(parts.slice(1).join(' '), deps);
  }

  if (subcommand === 'count') {
    return countMemories(parts.slice(1).join(' '), deps);
  }

  if (subcommand === 'clear') {
    return clearMemories(parts.slice(1).join(' '), deps);
  }

  return listMemories(text.trim(), deps);
}

function listMemories(repoQuery: string, deps: SlashCommandDependencies): SlashCommandResponse {
  const repoId = resolveRepoId(repoQuery, deps);
  if (!repoId) {
    return {
      response_type: 'ephemeral',
      text: `No workspace found matching \`${repoQuery}\`. Use \`/workspace list\` to see available repos.`,
    };
  }

  const memories = deps.memoryStore.listRecent(repoId, MAX_DISPLAY_MEMORIES);

  if (memories.length === 0) {
    return {
      response_type: 'ephemeral',
      text: `No memories found for \`${repoId}\`.`,
    };
  }

  const lines = [
    `*Recent Memories for* \`${repoId}\` (${memories.length})`,
    '',
    ...memories.map((m) => {
      const truncated = m.content.length > 120 ? `${m.content.slice(0, 117)}...` : m.content;
      return `• [${m.category}] ${truncated}`;
    }),
  ];

  return {
    response_type: 'ephemeral',
    text: lines.join('\n'),
  };
}

function countMemories(repoQuery: string, deps: SlashCommandDependencies): SlashCommandResponse {
  const repoId = resolveRepoId(repoQuery, deps);
  if (!repoId) {
    return {
      response_type: 'ephemeral',
      text: `No workspace found matching \`${repoQuery}\`. Use \`/workspace list\` to see available repos.`,
    };
  }

  const total = deps.memoryStore.countAll(repoId);
  return {
    response_type: 'ephemeral',
    text: `\`${repoId}\` has *${total}* memories.`,
  };
}

function clearMemories(repoQuery: string, deps: SlashCommandDependencies): SlashCommandResponse {
  const repoId = resolveRepoId(repoQuery, deps);
  if (!repoId) {
    return {
      response_type: 'ephemeral',
      text: `No workspace found matching \`${repoQuery}\`. Use \`/workspace list\` to see available repos.`,
    };
  }

  const pruned = deps.memoryStore.prune(repoId);
  return {
    response_type: 'ephemeral',
    text: `Cleared *${pruned}* expired memories for \`${repoId}\`.`,
  };
}

function resolveRepoId(query: string, deps: SlashCommandDependencies): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) {
    return undefined;
  }

  const resolution = deps.workspaceResolver.resolveManualInput(trimmed, 'manual');
  if (resolution.status === 'unique') {
    return resolution.workspace.repo.id;
  }

  return undefined;
}
