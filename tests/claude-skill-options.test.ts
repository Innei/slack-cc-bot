import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn(),
  query: vi.fn(),
  tool: vi.fn(),
}));

vi.mock('~/env/server.js', () => ({
  env: {
    CLAUDE_ENABLE_SKILLS: true,
  },
}));

vi.mock('~/memory/memory-extractor.js', () => ({
  extractImplicitMemories: vi.fn().mockResolvedValue([]),
}));

describe('Claude skill permission bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not auto-approve non-skill tools when skill dispatch is enabled', async () => {
    const { ClaudeAgentSdkExecutor } = await import('~/agent/providers/claude-code/adapter.js');
    const executor = new ClaudeAgentSdkExecutor(createTestLogger(), createMemoryStore());
    const skillOptions = (
      executor as unknown as {
        buildToolOptions: (sink: Record<string, unknown>) => {
          canUseTool?: (
            toolName: string,
            input: Record<string, unknown>,
            options: {
              signal: AbortSignal;
            },
          ) => Promise<Record<string, unknown>>;
        };
      }
    ).buildToolOptions({});

    await expect(
      skillOptions.canUseTool?.(
        'Skill',
        { command: 'bazi' },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'bazi' },
    });

    await expect(
      skillOptions.canUseTool?.(
        'Bash',
        { command: 'pwd' },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
    });
  });
});

function createTestLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };

  logger.withTag.mockReturnValue(logger);

  return logger as unknown as AppLogger;
}

function createMemoryStore(): MemoryStore {
  return {
    countAll: () => 0,
    delete: () => false,
    deleteAll: () => 0,
    listForContext: () => ({ global: [], preferences: [], workspace: [] }),
    listRecent: () => [],
    prune: () => 0,
    pruneAll: () => 0,
    save: vi.fn(),
    saveWithDedup: vi.fn(),
    search: () => [],
  } as unknown as MemoryStore;
}
