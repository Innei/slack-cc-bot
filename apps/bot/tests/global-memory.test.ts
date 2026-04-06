import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRootLogger } from '~/logger/index.js';
import type { MemoryRecord, MemoryStore } from '~/memory/types.js';
import { handleMemoryCommand } from '~/slack/commands/memory-command.js';
import type { SlashCommandDependencies } from '~/slack/commands/types.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

function createTestLogger() {
  return createRootLogger();
}

function createMemoryStore(initial: MemoryRecord[] = []): MemoryStore {
  const records = [...initial];

  return {
    countAll: (repoId?: string) => {
      if (repoId) return records.filter((r) => r.repoId === repoId).length;
      return records.length;
    },
    delete: (id) => {
      const idx = records.findIndex((r) => r.id === id);
      if (idx >= 0) {
        records.splice(idx, 1);
        return true;
      }
      return false;
    },
    deleteAll: (repoId?: string | null) => {
      if (repoId === null) {
        const before = records.length;
        const toRemove = records.filter((r) => !r.repoId);
        for (const r of toRemove) {
          const idx = records.indexOf(r);
          if (idx >= 0) records.splice(idx, 1);
        }
        return before - records.length;
      }
      if (repoId) {
        const before = records.length;
        const toRemove = records.filter((r) => r.repoId === repoId);
        for (const r of toRemove) {
          const idx = records.indexOf(r);
          if (idx >= 0) records.splice(idx, 1);
        }
        return before - records.length;
      }
      const count = records.length;
      records.length = 0;
      return count;
    },
    listRecent: (repoId, limit = 10) =>
      records
        .filter((r) => (repoId ? r.repoId === repoId : !r.repoId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    listForContext: (repoId, limits) => {
      const globalLimit = limits?.global ?? 5;
      const workspaceLimit = limits?.workspace ?? 10;

      const allGlobal = records
        .filter((r) => !r.repoId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const allWorkspace = repoId
        ? records
            .filter((r) => r.repoId === repoId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [];

      const globalPrefs = allGlobal.filter((r) => r.category === 'preference');
      const workspacePrefs = allWorkspace.filter((r) => r.category === 'preference');
      const preferences = [...globalPrefs, ...workspacePrefs];
      const prefIds = new Set(preferences.map((p) => p.id));

      const global = allGlobal.filter((r) => !prefIds.has(r.id)).slice(0, globalLimit);
      const workspace = allWorkspace.filter((r) => !prefIds.has(r.id)).slice(0, workspaceLimit);

      return { global, workspace, preferences };
    },
    prune: () => 0,
    pruneAll: () => 0,
    save: (input) => {
      const record: MemoryRecord = {
        ...input,
        scope: input.repoId ? 'workspace' : 'global',
        createdAt: new Date().toISOString(),
        id: `mem-${records.length + 1}`,
      };
      records.push(record);
      return record;
    },
    saveWithDedup: (input, supersedesId) => {
      if (supersedesId) {
        const idx = records.findIndex((r) => r.id === supersedesId);
        if (idx >= 0) records.splice(idx, 1);
      }
      const record: MemoryRecord = {
        ...input,
        scope: input.repoId ? 'workspace' : 'global',
        createdAt: new Date().toISOString(),
        id: `mem-${records.length + 1}`,
      };
      records.push(record);
      return record;
    },
    search: (repoId, options = {}) => {
      const limit = options.limit ?? 10;
      return records
        .filter((r) => (repoId ? r.repoId === repoId : !r.repoId))
        .filter((r) => !options.category || r.category === options.category)
        .filter(
          (r) => !options.query || r.content.toLowerCase().includes(options.query.toLowerCase()),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
  };
}

function makeGlobalMemory(content: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    category: 'context',
    content,
    createdAt: new Date().toISOString(),
    id: `mem-${Math.random().toString(36).slice(2)}`,
    scope: 'global',
    ...overrides,
  };
}

function makeWorkspaceMemory(
  repoId: string,
  content: string,
  overrides?: Partial<MemoryRecord>,
): MemoryRecord {
  return {
    category: 'task_completed',
    content,
    createdAt: new Date().toISOString(),
    id: `mem-${Math.random().toString(36).slice(2)}`,
    repoId,
    scope: 'workspace',
    ...overrides,
  };
}

function createSessionStore() {
  return {
    countAll: () => 0,
    get: () => undefined,
    listRecent: () => [],
    patch: () => ({ threadTs: '', channelId: '', rootMessageTs: '', createdAt: '', updatedAt: '' }),
    upsert: () => ({
      threadTs: '',
      channelId: '',
      rootMessageTs: '',
      createdAt: '',
      updatedAt: '',
    }),
  };
}

function createTestDeps(options?: {
  memoryRecords?: MemoryRecord[];
  repoRoot?: string;
}): SlashCommandDependencies {
  const repoRoot = options?.repoRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  return {
    logger: createTestLogger(),
    memoryStore: createMemoryStore(options?.memoryRecords ?? []),
    providerRegistry: {
      defaultProviderId: 'claude-code',
      providerIds: ['claude-code'],
      has: (id: string) => id === 'claude-code',
      getExecutor: () => {
        throw new Error('not used in tests');
      },
      drain: async () => {},
    },
    sessionStore: createSessionStore() as SlashCommandDependencies['sessionStore'],
    threadExecutionRegistry: createThreadExecutionRegistry(),
    workspaceResolver: new WorkspaceResolver({ repoRootDir: repoRoot, scanDepth: 3 }),
  };
}

describe('global memory - MemoryStore in-memory', () => {
  it('saves and retrieves global memories (no repoId)', () => {
    const store = createMemoryStore();
    const saved = store.save({ category: 'context', content: 'User prefers Chinese replies' });

    expect(saved.scope).toBe('global');
    expect(saved.repoId).toBeUndefined();

    const recent = store.listRecent(undefined, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe('User prefers Chinese replies');
    expect(recent[0]!.scope).toBe('global');
  });

  it('saves workspace memories with repoId', () => {
    const store = createMemoryStore();
    const saved = store.save({
      category: 'decision',
      content: 'Use ESM only',
      repoId: 'my-repo',
    });

    expect(saved.scope).toBe('workspace');
    expect(saved.repoId).toBe('my-repo');

    const recent = store.listRecent('my-repo', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe('Use ESM only');
  });

  it('listRecent(undefined) returns only global, not workspace', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global note'),
      makeWorkspaceMemory('repo-a', 'workspace note'),
    ]);

    const global = store.listRecent(undefined, 10);
    expect(global).toHaveLength(1);
    expect(global[0]!.content).toBe('global note');
  });

  it('listRecent(repoId) returns only workspace, not global', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global note'),
      makeWorkspaceMemory('repo-a', 'workspace note'),
    ]);

    const workspace = store.listRecent('repo-a', 10);
    expect(workspace).toHaveLength(1);
    expect(workspace[0]!.content).toBe('workspace note');
  });

  it('listForContext returns both global and workspace', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global 1'),
      makeGlobalMemory('global 2'),
      makeWorkspaceMemory('repo-a', 'ws 1'),
      makeWorkspaceMemory('repo-a', 'ws 2'),
      makeWorkspaceMemory('repo-b', 'other ws'),
    ]);

    const ctx = store.listForContext('repo-a');
    expect(ctx.global).toHaveLength(2);
    expect(ctx.workspace).toHaveLength(2);
    expect(ctx.global.map((m) => m.content)).toEqual(
      expect.arrayContaining(['global 1', 'global 2']),
    );
    expect(ctx.workspace.map((m) => m.content)).toEqual(expect.arrayContaining(['ws 1', 'ws 2']));
  });

  it('listForContext without repoId returns global only', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global note'),
      makeWorkspaceMemory('repo-a', 'ws note'),
    ]);

    const ctx = store.listForContext(undefined);
    expect(ctx.global).toHaveLength(1);
    expect(ctx.workspace).toHaveLength(0);
  });

  it('listForContext respects limits', () => {
    const store = createMemoryStore([
      makeGlobalMemory('g1'),
      makeGlobalMemory('g2'),
      makeGlobalMemory('g3'),
      makeWorkspaceMemory('repo', 'w1'),
      makeWorkspaceMemory('repo', 'w2'),
      makeWorkspaceMemory('repo', 'w3'),
    ]);

    const ctx = store.listForContext('repo', { global: 1, workspace: 2 });
    expect(ctx.global).toHaveLength(1);
    expect(ctx.workspace).toHaveLength(2);
  });

  it('deleteAll(null) deletes only global memories', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global 1'),
      makeGlobalMemory('global 2'),
      makeWorkspaceMemory('repo-a', 'ws note'),
    ]);

    const deleted = store.deleteAll(null);
    expect(deleted).toBe(2);
    expect(store.listRecent(undefined, 10)).toHaveLength(0);
    expect(store.listRecent('repo-a', 10)).toHaveLength(1);
  });

  it('deleteAll(repoId) deletes only that workspace', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global'),
      makeWorkspaceMemory('repo-a', 'a1'),
      makeWorkspaceMemory('repo-b', 'b1'),
    ]);

    const deleted = store.deleteAll('repo-a');
    expect(deleted).toBe(1);
    expect(store.listRecent('repo-a', 10)).toHaveLength(0);
    expect(store.listRecent('repo-b', 10)).toHaveLength(1);
    expect(store.listRecent(undefined, 10)).toHaveLength(1);
  });

  it('deleteAll() with no args deletes everything', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global'),
      makeWorkspaceMemory('repo-a', 'ws'),
    ]);

    const deleted = store.deleteAll();
    expect(deleted).toBe(2);
    expect(store.countAll()).toBe(0);
  });

  it('search with undefined repoId searches global scope', () => {
    const store = createMemoryStore([
      makeGlobalMemory('important preference'),
      makeWorkspaceMemory('repo', 'workspace item'),
    ]);

    const results = store.search(undefined, { query: 'preference' });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('important preference');
  });
});

describe('handleMemoryCommand - global scope', () => {
  it('help text includes global commands', () => {
    const deps = createTestDeps();
    const result = handleMemoryCommand('', deps);
    expect(result.text).toContain('global');
    expect(result.text).toContain('/memory list global');
    expect(result.text).toContain('/memory clear global');
  });

  it('lists global memories with "list global"', () => {
    const deps = createTestDeps({
      memoryRecords: [
        makeGlobalMemory('User prefers Chinese'),
        makeGlobalMemory('Important cross-workspace note'),
      ],
    });

    const result = handleMemoryCommand('list global', deps);
    expect(result.text).toContain('Global Memories');
    expect(result.text).toContain('User prefers Chinese');
    expect(result.text).toContain('Important cross-workspace note');
  });

  it('returns no global memories message when empty', () => {
    const deps = createTestDeps();
    const result = handleMemoryCommand('list global', deps);
    expect(result.text).toContain('No global memories');
  });

  it('count with no args shows total and global count', () => {
    const deps = createTestDeps({
      memoryRecords: [
        makeGlobalMemory('g1'),
        makeGlobalMemory('g2'),
        makeWorkspaceMemory('repo', 'w1'),
      ],
    });

    const result = handleMemoryCommand('count', deps);
    expect(result.text).toContain('3');
    expect(result.text).toContain('global');
  });

  it('clear global deletes global memories', () => {
    const deps = createTestDeps({
      memoryRecords: [makeGlobalMemory('g1'), makeWorkspaceMemory('repo', 'w1')],
    });

    const result = handleMemoryCommand('clear global', deps);
    expect(result.text).toContain('1');
    expect(result.text).toContain('global');
  });

  it('clear with no args prompts for scope', () => {
    const deps = createTestDeps();
    const result = handleMemoryCommand('clear', deps);
    expect(result.text).toContain('specify');
  });
});

describe('preference memory - listForContext', () => {
  it('returns preferences in a separate field', () => {
    const store = createMemoryStore([
      makeGlobalMemory('general note'),
      makeGlobalMemory('nickname is 小汐', { category: 'preference', id: 'pref-1' }),
    ]);

    const ctx = store.listForContext(undefined);
    expect(ctx.preferences).toHaveLength(1);
    expect(ctx.preferences[0]!.content).toBe('nickname is 小汐');
    expect(ctx.preferences[0]!.category).toBe('preference');
  });

  it('preferences are excluded from the global list', () => {
    const store = createMemoryStore([
      makeGlobalMemory('general note'),
      makeGlobalMemory('nickname is 小汐', { category: 'preference', id: 'pref-1' }),
    ]);

    const ctx = store.listForContext(undefined);
    expect(ctx.global).toHaveLength(1);
    expect(ctx.global[0]!.content).toBe('general note');
  });

  it('preferences are not subject to normal limits', () => {
    const prefs = Array.from({ length: 8 }, (_, i) =>
      makeGlobalMemory(`pref ${i}`, { category: 'preference', id: `pref-${i}` }),
    );
    const regulars = Array.from({ length: 3 }, (_, i) => makeGlobalMemory(`note ${i}`));
    const store = createMemoryStore([...prefs, ...regulars]);

    const ctx = store.listForContext(undefined, { global: 2 });
    expect(ctx.preferences).toHaveLength(8);
    expect(ctx.global).toHaveLength(2);
  });

  it('includes workspace preferences too', () => {
    const store = createMemoryStore([
      makeGlobalMemory('global pref', { category: 'preference', id: 'gp-1' }),
      makeWorkspaceMemory('repo-a', 'workspace pref', {
        category: 'preference',
        id: 'wp-1',
      }),
      makeWorkspaceMemory('repo-a', 'workspace note'),
    ]);

    const ctx = store.listForContext('repo-a');
    expect(ctx.preferences).toHaveLength(2);
    expect(ctx.workspace).toHaveLength(1);
    expect(ctx.workspace[0]!.content).toBe('workspace note');
  });
});

describe('saveWithDedup', () => {
  it('saves normally when no supersedes id', () => {
    const store = createMemoryStore();
    const saved = store.saveWithDedup({
      category: 'preference',
      content: 'nickname is 小汐',
    });
    expect(saved.content).toBe('nickname is 小汐');
    expect(store.search(undefined, { category: 'preference' })).toHaveLength(1);
  });

  it('deletes the superseded memory and saves the new one', () => {
    const store = createMemoryStore([
      makeGlobalMemory('nickname is 小汐', { category: 'preference', id: 'old-pref' }),
    ]);

    const saved = store.saveWithDedup(
      { category: 'preference', content: 'nickname is 小夕' },
      'old-pref',
    );
    expect(saved.content).toBe('nickname is 小夕');

    const all = store.search(undefined, { category: 'preference' });
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe('nickname is 小夕');
  });

  it('handles non-existent supersedes id gracefully', () => {
    const store = createMemoryStore();
    const saved = store.saveWithDedup(
      { category: 'preference', content: 'some pref' },
      'non-existent-id',
    );
    expect(saved.content).toBe('some pref');
    expect(store.search(undefined, { category: 'preference' })).toHaveLength(1);
  });
});
