import { describe, expect, it } from 'vitest';

import type { SessionRecord, SessionStore } from '~/session/types.js';
import { resolveAndPersistSession } from '~/slack/ingress/session-manager.js';
import type { ResolvedWorkspace } from '~/workspace/types.js';

function createMemorySessionStore(records: SessionRecord[] = []): SessionStore {
  const store = new Map(records.map((r) => [r.threadTs, { ...r }]));
  return {
    countAll: () => store.size,
    get: (threadTs) => {
      const r = store.get(threadTs);
      return r ? { ...r } : undefined;
    },
    patch: (threadTs, patch) => {
      const existing = store.get(threadTs);
      if (!existing) return undefined;
      const next: SessionRecord = {
        ...existing,
        ...patch,
        threadTs,
        updatedAt: new Date().toISOString(),
      };
      store.set(threadTs, next);
      return { ...next };
    },
    upsert: (record) => {
      const next = { ...record };
      store.set(record.threadTs, next);
      return { ...next };
    },
  };
}

const WORKSPACE: ResolvedWorkspace = {
  input: '/tmp/repo',
  matchKind: 'repo',
  repo: {
    aliases: [],
    id: 'org/repo',
    label: 'org/repo',
    name: 'repo',
    relativePath: 'org/repo',
    repoPath: '/tmp/repo',
  },
  source: 'auto',
  workspaceLabel: 'repo',
  workspacePath: '/tmp/repo',
};

describe('resolveAndPersistSession', () => {
  it('creates a new session when none exists', () => {
    const store = createMemorySessionStore();
    const result = resolveAndPersistSession('ts1', 'C123', 'ts1', WORKSPACE, false, store);

    expect(result.session.threadTs).toBe('ts1');
    expect(result.session.workspacePath).toBe('/tmp/repo');
    expect(result.resumeHandle).toBeUndefined();
    expect(store.get('ts1')).toBeDefined();
  });

  it('patches existing session and returns resume handle', () => {
    const existing: SessionRecord = {
      channelId: 'C123',
      providerSessionId: 'session-1',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspacePath: '/tmp/repo',
      workspaceRepoId: 'org/repo',
      workspaceRepoPath: '/tmp/repo',
      workspaceLabel: 'repo',
    };
    const store = createMemorySessionStore([existing]);

    const result = resolveAndPersistSession('ts1', 'C123', 'ts1', WORKSPACE, false, store);

    expect(result.resumeHandle).toBe('session-1');
  });

  it('resets session when workspace changes', () => {
    const existing: SessionRecord = {
      channelId: 'C123',
      providerSessionId: 'session-1',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspacePath: '/tmp/old-repo',
      workspaceRepoId: 'org/old-repo',
      workspaceRepoPath: '/tmp/old-repo',
      workspaceLabel: 'old-repo',
    };
    const store = createMemorySessionStore([existing]);

    const result = resolveAndPersistSession('ts1', 'C123', 'ts1', WORKSPACE, false, store);

    expect(result.resumeHandle).toBeUndefined();
    expect(store.get('ts1')?.providerSessionId).toBeUndefined();
  });

  it('resets session when forceNewSession is true', () => {
    const existing: SessionRecord = {
      channelId: 'C123',
      providerSessionId: 'session-1',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspacePath: '/tmp/repo',
      workspaceRepoId: 'org/repo',
      workspaceRepoPath: '/tmp/repo',
      workspaceLabel: 'repo',
    };
    const store = createMemorySessionStore([existing]);

    const result = resolveAndPersistSession('ts1', 'C123', 'ts1', WORKSPACE, true, store);

    expect(result.resumeHandle).toBeUndefined();
  });

  it('creates session without workspace fields when workspace is undefined', () => {
    const store = createMemorySessionStore();
    const result = resolveAndPersistSession('ts1', 'C123', 'ts1', undefined, false, store);

    expect(result.session.threadTs).toBe('ts1');
    expect(result.session.workspacePath).toBeUndefined();
    expect(result.session.workspaceRepoId).toBeUndefined();
    expect(result.resumeHandle).toBeUndefined();
  });

  it('preserves existing workspace when patching without new workspace', () => {
    const existing: SessionRecord = {
      channelId: 'C123',
      providerSessionId: 'session-1',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspacePath: '/tmp/repo',
      workspaceRepoId: 'org/repo',
      workspaceRepoPath: '/tmp/repo',
      workspaceLabel: 'repo',
    };
    const store = createMemorySessionStore([existing]);

    const result = resolveAndPersistSession('ts1', 'C123', 'ts1', undefined, false, store);

    expect(result.resumeHandle).toBe('session-1');
    expect(store.get('ts1')?.workspacePath).toBe('/tmp/repo');
  });
});
