import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentProviderRegistry } from '~/agent/registry.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionStore } from '~/session/types.js';
import {
  createHomeTabHandler,
  HOME_TAB_REFRESH_ACTION_ID,
} from '~/slack/ingress/home-tab-handler.js';
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

function createMockProviderRegistry(
  providers: string[] = ['claude-code'],
  defaultId = 'claude-code',
): AgentProviderRegistry {
  return {
    defaultProviderId: defaultId,
    providerIds: providers,
    has: (id: string) => providers.includes(id),
    getExecutor: () => {
      throw new Error('not implemented');
    },
    drain: async () => {},
  };
}

function createMockClient() {
  return {
    assistant: { threads: { setStatus: vi.fn() } },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    chat: { delete: vi.fn(), postMessage: vi.fn(), update: vi.fn() },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    reactions: { add: vi.fn() },
    users: {
      info: vi.fn().mockResolvedValue({
        user: { profile: { display_name: 'Alice', real_name: 'Alice Smith' } },
      }),
    },
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
      providerRegistry: createMockProviderRegistry(),
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
      providerRegistry: createMockProviderRegistry(),
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
      providerRegistry: createMockProviderRegistry(),
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

  it('includes uptime in the stats block', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(),
      providerRegistry: createMockProviderRegistry(),
      sessionStore: createMockSessionStore(),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    await handler({ client, event: { user: 'U123', tab: 'home' } });

    const view = client.views.publish.mock.calls[0]![0].view;
    const statsBlock = view.blocks.find((b: any) => b.type === 'section' && b.fields);
    const fieldTexts = statsBlock.fields.map((f: any) => f.text);
    expect(fieldTexts).toContainEqual(expect.stringContaining('Uptime'));
  });

  it('includes provider info', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(),
      providerRegistry: createMockProviderRegistry(['claude-code', 'openai'], 'claude-code'),
      sessionStore: createMockSessionStore(),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    await handler({ client, event: { user: 'U123', tab: 'home' } });

    const view = client.views.publish.mock.calls[0]![0].view;
    const providerBlock = view.blocks.find(
      (b: any) =>
        b.type === 'section' &&
        typeof b.text?.text === 'string' &&
        b.text.text.includes('claude-code'),
    );
    expect(providerBlock).toBeDefined();
    expect(providerBlock.text.text).toContain('default');
    expect(providerBlock.text.text).toContain('openai');
  });

  it('includes personalized greeting with user name', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(),
      providerRegistry: createMockProviderRegistry(),
      sessionStore: createMockSessionStore(),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    await handler({ client, event: { user: 'U123', tab: 'home' } });

    const view = client.views.publish.mock.calls[0]![0].view;
    const greetingBlock = view.blocks[0];
    expect(greetingBlock.text.text).toContain('Alice');
  });

  it('falls back to generic greeting when user info unavailable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(),
      providerRegistry: createMockProviderRegistry(),
      sessionStore: createMockSessionStore(),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    // Remove users.info to simulate unavailability
    delete (client as any).users;
    await handler({ client, event: { user: 'U123', tab: 'home' } });

    const view = client.views.publish.mock.calls[0]![0].view;
    const greetingBlock = view.blocks[0];
    expect(greetingBlock.text.text).toContain('Hey there!');
  });

  it('includes a refresh button', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });

    const handler = createHomeTabHandler({
      logger: createTestLogger(),
      memoryStore: createMockMemoryStore(),
      providerRegistry: createMockProviderRegistry(),
      sessionStore: createMockSessionStore(),
      workspaceResolver: resolver,
    });

    const client = createMockClient();
    await handler({ client, event: { user: 'U123', tab: 'home' } });

    const view = client.views.publish.mock.calls[0]![0].view;
    const actionsBlock = view.blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements[0].action_id).toBe(HOME_TAB_REFRESH_ACTION_ID);
  });

  it('logs error when views.publish fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-tab-test-'));
    const resolver = new WorkspaceResolver({ repoRootDir: tmpDir, scanDepth: 0 });
    const logger = createTestLogger();

    const handler = createHomeTabHandler({
      logger,
      memoryStore: createMockMemoryStore(),
      providerRegistry: createMockProviderRegistry(),
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
