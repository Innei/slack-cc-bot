import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { WorkspaceResolver } from '~/workspace/resolver.js';

describe('WorkspaceResolver', () => {
  it('discovers repositories and resolves repo names from text', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-resolver-'));
    const repoPath = createRepo(repoRoot, 'team/slack-cc-bot');
    createRepo(repoRoot, 'team/other-service');

    const resolver = new WorkspaceResolver({
      repoRootDir: repoRoot,
      scanDepth: 2,
    });

    const resolution = resolver.resolveFromText('please check slack-cc-bot for this issue');

    expect(resolution.status).toBe('unique');
    if (resolution.status !== 'unique') {
      return;
    }

    expect(resolution.workspace.repo.repoPath).toBe(repoPath);
    expect(resolution.workspace.workspacePath).toBe(repoPath);
  });

  it('expands a tilde-prefixed repo root directory', () => {
    const homeDir = os.homedir();
    const repoRoot = fs.mkdtempSync(path.join(homeDir, 'workspace-resolver-home-'));
    const repoPath = createRepo(repoRoot, 'team/slack-cc-bot');

    try {
      const resolver = new WorkspaceResolver({
        repoRootDir: repoRoot.replace(homeDir, '~'),
        scanDepth: 2,
      });

      const resolution = resolver.resolveFromText('check slack-cc-bot');

      expect(resolution.status).toBe('unique');
      if (resolution.status !== 'unique') {
        return;
      }

      expect(resolution.workspace.repo.repoPath).toBe(repoPath);
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it('resolves manual subdirectory paths inside a repository', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-resolver-'));
    const repoPath = createRepo(repoRoot, 'team/slack-cc-bot');
    const subdirPath = path.join(repoPath, 'packages', 'bot');
    fs.mkdirSync(subdirPath, { recursive: true });

    const resolver = new WorkspaceResolver({
      repoRootDir: repoRoot,
      scanDepth: 2,
    });

    const resolution = resolver.resolveManualInput('team/slack-cc-bot/packages/bot');

    expect(resolution.status).toBe('unique');
    if (resolution.status !== 'unique') {
      return;
    }

    expect(resolution.workspace.workspacePath).toBe(subdirPath);
    expect(resolution.workspace.workspaceLabel).toBe('team/slack-cc-bot/packages/bot');
  });
});

function createRepo(repoRoot: string, relativePath: string): string {
  const repoPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  return repoPath;
}
