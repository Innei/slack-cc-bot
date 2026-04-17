import { describe, expect, it, vi } from 'vitest';

import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import type { SessionRecord } from '~/session/types.js';
import {
  buildWorkspaceResolutionBlocks,
  resolveWorkspaceForConversation,
  WORKSPACE_PICKER_ACTION_ID,
} from '~/slack/ingress/workspace-resolution.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { ResolvedWorkspace, WorkspaceResolution } from '~/workspace/types.js';

function createMockChannelPreferenceStore(value: string | undefined): ChannelPreferenceStore {
  return {
    get: vi.fn().mockReturnValue(
      value
        ? {
            channelId: 'C123',
            createdAt: new Date().toISOString(),
            defaultWorkspaceInput: value,
            updatedAt: new Date().toISOString(),
          }
        : undefined,
    ),
    upsert: vi.fn(),
  };
}

describe('resolveWorkspaceForConversation', () => {
  it('returns the override when provided', () => {
    const override: ResolvedWorkspace = {
      input: '/tmp/repo',
      matchKind: 'repo',
      repo: {
        aliases: [],
        id: 'repo-1',
        label: 'repo-1',
        name: 'repo',
        relativePath: 'repo-1',
        repoPath: '/tmp/repo',
      },
      source: 'manual',
      workspaceLabel: 'repo',
      workspacePath: '/tmp/repo',
    };
    const resolver = { resolveFromText: vi.fn() } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore(undefined);

    const result = resolveWorkspaceForConversation(
      'some text',
      undefined,
      resolver,
      preferenceStore,
      'C123',
      override,
    );

    expect(result).toEqual({ status: 'unique', workspace: override });
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('reconstructs workspace from existing session', () => {
    const session: SessionRecord = {
      channelId: 'C123',
      createdAt: new Date().toISOString(),
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: new Date().toISOString(),
      workspaceLabel: 'my-repo',
      workspacePath: '/tmp/my-repo',
      workspaceRepoId: 'org/my-repo',
      workspaceRepoPath: '/tmp/my-repo',
    };
    const resolver = { resolveFromText: vi.fn() } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore(undefined);

    const result = resolveWorkspaceForConversation(
      'text',
      session,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result.status).toBe('unique');
    expect(resolver.resolveFromText).not.toHaveBeenCalled();
  });

  it('falls back to resolver when no session workspace', () => {
    const missing: WorkspaceResolution = { status: 'missing', query: 'hello', reason: 'no match' };
    const resolver = {
      resolveFromText: vi.fn().mockReturnValue(missing),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore(undefined);

    const result = resolveWorkspaceForConversation(
      'hello',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(missing);
    expect(resolver.resolveFromText).toHaveBeenCalledWith('hello', 'auto');
  });

  it('falls back to channel preference when resolver returns missing', () => {
    const missing: WorkspaceResolution = { status: 'missing', query: 'hello', reason: 'no match' };
    const unique: WorkspaceResolution = {
      status: 'unique',
      workspace: {
        input: 'my-repo',
        matchKind: 'repo',
        repo: {
          aliases: [],
          id: 'my-repo',
          label: 'my-repo',
          name: 'my-repo',
          relativePath: 'my-repo',
          repoPath: '/tmp/my-repo',
        },
        source: 'manual',
        workspaceLabel: 'my-repo',
        workspacePath: '/tmp/my-repo',
      },
    };
    const resolver = {
      resolveFromText: vi.fn().mockReturnValue(missing),
      resolveManualInput: vi.fn().mockReturnValue(unique),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore('my-repo');

    const result = resolveWorkspaceForConversation(
      'hello',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(unique);
    expect(resolver.resolveFromText).toHaveBeenCalledWith('hello', 'auto');
    expect(preferenceStore.get).toHaveBeenCalledWith('C123');
    expect(resolver.resolveManualInput).toHaveBeenCalledWith('my-repo', 'manual');
  });

  it('ignores channel preference when resolver returns unique', () => {
    const unique: WorkspaceResolution = {
      status: 'unique',
      workspace: {
        input: 'text-match',
        matchKind: 'repo',
        repo: {
          aliases: [],
          id: 'text-match',
          label: 'text-match',
          name: 'text-match',
          relativePath: 'text-match',
          repoPath: '/tmp/text-match',
        },
        source: 'auto',
        workspaceLabel: 'text-match',
        workspacePath: '/tmp/text-match',
      },
    };
    const resolver = {
      resolveFromText: vi.fn().mockReturnValue(unique),
      resolveManualInput: vi.fn(),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore('my-repo');

    const result = resolveWorkspaceForConversation(
      'text-match',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(unique);
    expect(resolver.resolveManualInput).not.toHaveBeenCalled();
  });

  it('ignores channel preference when preference resolution is missing', () => {
    const missing: WorkspaceResolution = { status: 'missing', query: 'hello', reason: 'no match' };
    const resolver = {
      resolveFromText: vi.fn().mockReturnValue(missing),
      resolveManualInput: vi.fn().mockReturnValue(missing),
    } as unknown as WorkspaceResolver;
    const preferenceStore = createMockChannelPreferenceStore('unknown-repo');

    const result = resolveWorkspaceForConversation(
      'hello',
      undefined,
      resolver,
      preferenceStore,
      'C123',
    );

    expect(result).toEqual(missing);
    expect(resolver.resolveManualInput).toHaveBeenCalledWith('unknown-repo', 'manual');
  });
});

describe('buildWorkspaceResolutionBlocks', () => {
  it('builds blocks with candidate labels and a picker button', () => {
    const resolution = {
      status: 'ambiguous' as const,
      query: 'my-app',
      reason: 'multiple matches',
      candidates: [
        {
          aliases: [],
          id: 'org1/my-app',
          label: 'org1/my-app',
          name: 'my-app',
          relativePath: 'org1/my-app',
          repoPath: '/tmp/org1/my-app',
        },
        {
          aliases: [],
          id: 'org2/my-app',
          label: 'org2/my-app',
          name: 'my-app',
          relativePath: 'org2/my-app',
          repoPath: '/tmp/org2/my-app',
        },
      ],
    };

    const { blocks, text } = buildWorkspaceResolutionBlocks(resolution, 'work on my-app');

    expect(text).toContain("couldn't tell which repository");
    expect(text).toContain('org1/my-app');
    expect(text).toContain('org2/my-app');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      type: 'actions',
      block_id: 'workspace_picker',
    });
  });
});

describe('WORKSPACE_PICKER_ACTION_ID', () => {
  it('is a string constant', () => {
    expect(typeof WORKSPACE_PICKER_ACTION_ID).toBe('string');
  });
});
