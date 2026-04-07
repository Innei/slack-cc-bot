import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionStore } from '~/session/types.js';
import { createHomeTabHandler } from '~/slack/ingress/home-tab-handler.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

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

function createMockSessionStore(count = 0): SessionStore {
  return {
    countAll: () => count,
    get: () => undefined,
    patch: () => undefined,
    upsert: (r) => r,
  };
}

function createMockMemoryStore(count = 0): MemoryStore {
  return {
    countAll: () => count,
    delete: () => false,
    deleteAll: () => 0,
    listForContext: () => ({ global: [], preferences: [], workspace: [] }),
    listRecent: () => [],
    prune: () => 0,
    pruneAll: () => 0,
    save: (input) => ({
      ...input,
      id: '1',
      createdAt: '',
      scope: input.repoId ? 'workspace' : 'global',
    }),
    saveWithDedup: (input) => ({
      ...input,
      id: '1',
      createdAt: '',
      scope: input.repoId ? 'workspace' : 'global',
    }),
    search: () => [],
  };
}

function createMockClient() {
  return {
    assistant: { threads: { setStatus: vi.fn() } },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    chat: { delete: vi.fn(), postMessage: vi.fn(), update: vi.fn() },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    reactions: { add: vi.fn() },
    views: { open: vi.fn(), publish: vi.fn().mockResolvedValue({}) },
  };
}

describe('Home Tab Handler', () => {
  it('publishes home view on app_home_opened event', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(5),
      sessionStore: createMockSessionStore(3),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    await handler({ client, event: { user: 'U123', tab: 'home' } });

    expect(client.views.publish).toHaveBeenCalledOnce();
    const publishCall = client.views.publish.mock.calls[0];
    if (!publishCall) {
      throw new Error('Expected publish to be called');
    }
    const call = publishCall[0];
    expect(call.user_id).toBe('U123');
    expect(call.view.type).toBe('home');
    expect(call.view.blocks.length).toBeGreaterThan(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips non-home tab events', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(),
      sessionStore: createMockSessionStore(),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    await handler({ client, event: { user: 'U123', tab: 'messages' } });

    expect(client.views.publish).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes stats in the home view', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(10),
      sessionStore: createMockSessionStore(7),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    await handler({ client, event: { user: 'U456', tab: 'home' } });

    const publishCall = client.views.publish.mock.calls[0];
    if (!publishCall) {
      throw new Error('Expected publish to be called');
    }
    const view = publishCall[0].view;
    const statsBlock = view.blocks.find((b: any) => b.type === 'section' && b.fields);
    expect(statsBlock).toBeDefined();
    if (!statsBlock) {
      throw new Error('Expected stats block');
    }

    const fieldTexts = statsBlock.fields.map((f: any) => f.text);
    expect(fieldTexts).toContainEqual(expect.stringContaining('7'));
    expect(fieldTexts).toContainEqual(expect.stringContaining('10'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs error when views.publish fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });
    const logger = createTestLogger();

    const handler = createHomeTabHandler({
      logger,
      memoryStore: createMockMemoryStore(),
      sessionStore: createMockSessionStore(),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    client.views.publish.mockRejectedValueOnce(new Error('API error'));

    await handler({ client, event: { user: 'U789', tab: 'home' } });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to publish Home tab'),
      'U789',
      'API error',
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
