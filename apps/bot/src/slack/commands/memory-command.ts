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
        '• `/memory list global` — show recent global memories',
        '• `/memory list <repo>` — show recent memories for a repo',
        '• `/memory count` — show total memory count',
        '• `/memory count global` — show global memory count',
        '• `/memory count <repo>` — show memory count for a repo',
        '• `/memory clear global` — clear all global memories',
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
  const trimmed = repoQuery.trim().toLowerCase();

  if (trimmed === 'global' || trimmed === '') {
    const memories = deps.memoryStore.listRecent(undefined, MAX_DISPLAY_MEMORIES);
    if (memories.length === 0) {
      return {
        response_type: 'ephemeral',
        text: 'No global memories found.',
      };
    }

    const lines = [
      `*Recent Global Memories* (${memories.length})`,
      '',
      ...memories.map((m) => {
        const truncated = m.content.length > 120 ? `${m.content.slice(0, 117)}...` : m.content;
        return `• [${m.category}] ${truncated}`;
      }),
    ];

    return { response_type: 'ephemeral', text: lines.join('\n') };
  }

  const repoId = resolveRepoId(repoQuery, deps);
  if (!repoId) {
    return {
      response_type: 'ephemeral',
      text: `No workspace found matching \`${repoQuery}\`. Use \`/workspace list\` to see available repos, or \`/memory list global\` for global memories.`,
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
  const trimmed = repoQuery.trim().toLowerCase();

  if (trimmed === '' || trimmed === 'global') {
    const total = deps.memoryStore.countAll();
    const globalCount = deps.memoryStore.listRecent(undefined, 50).length;
    return {
      response_type: 'ephemeral',
      text: `Total memories: *${total}* (global: *${globalCount}*)`,
    };
  }

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
  const trimmed = repoQuery.trim().toLowerCase();

  if (trimmed === 'global') {
    const deleted = deps.memoryStore.deleteAll(null);
    return {
      response_type: 'ephemeral',
      text: `Cleared *${deleted}* global memories.`,
    };
  }

  if (!trimmed) {
    return {
      response_type: 'ephemeral',
      text: 'Please specify a repo or `global`. Example: `/memory clear global` or `/memory clear my-repo`.',
    };
  }

  const repoId = resolveRepoId(repoQuery, deps);
  if (!repoId) {
    return {
      response_type: 'ephemeral',
      text: `No workspace found matching \`${repoQuery}\`. Use \`/workspace list\` to see available repos.`,
    };
  }

  const deleted = deps.memoryStore.deleteAll(repoId);
  return {
    response_type: 'ephemeral',
    text: `Cleared *${deleted}* memories for \`${repoId}\`.`,
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
