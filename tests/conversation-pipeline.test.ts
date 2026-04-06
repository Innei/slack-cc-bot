import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutor } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import type { ThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import {
  acknowledgeAndLog,
  DEFAULT_CONVERSATION_STEPS,
  executeAgent,
  prepareThreadContext,
  resolveSessionStep,
  resolveWorkspaceStep,
  runConversationPipeline,
} from '~/slack/ingress/conversation-pipeline.js';
import type { ConversationPipelineContext, PipelineStep } from '~/slack/ingress/types.js';
import type { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { WorkspaceResolution } from '~/workspace/types.js';

describe('runConversationPipeline', () => {
  it('runs all steps in order', async () => {
    const calls: string[] = [];
    const steps: PipelineStep[] = [
      async () => {
        calls.push('a');
        return { action: 'continue' };
      },
      async () => {
        calls.push('b');
        return { action: 'continue' };
      },
      async () => {
        calls.push('c');
        return { action: 'continue' };
      },
    ];
    const ctx = {} as ConversationPipelineContext;

    await runConversationPipeline(ctx, steps);

    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('stops on early exit', async () => {
    const calls: string[] = [];
    const steps: PipelineStep[] = [
      async () => {
        calls.push('a');
        return { action: 'continue' };
      },
      async () => {
        calls.push('b');
        return { action: 'done', reason: 'ambiguous' };
      },
      async () => {
        calls.push('c');
        return { action: 'continue' };
      },
    ];
    const ctx = {} as ConversationPipelineContext;

    await runConversationPipeline(ctx, steps);

    expect(calls).toEqual(['a', 'b']);
  });

  it('propagates step errors', async () => {
    const steps: PipelineStep[] = [
      async () => {
        throw new Error('boom');
      },
    ];
    const ctx = {} as ConversationPipelineContext;

    await expect(runConversationPipeline(ctx, steps)).rejects.toThrow('boom');
  });
});

describe('DEFAULT_CONVERSATION_STEPS', () => {
  it('exports the expected number of steps', () => {
    expect(DEFAULT_CONVERSATION_STEPS).toHaveLength(5);
  });

  it('contains only functions', () => {
    for (const step of DEFAULT_CONVERSATION_STEPS) {
      expect(typeof step).toBe('function');
    }
  });
});

function createMinimalPipelineContext(overrides?: {
  addAcknowledgementReaction?: boolean;
  sessionStoreRecords?: SessionRecord[];
  threadExecutionRegistry?: ThreadExecutionRegistry;
  workspaceResolverResult?: WorkspaceResolution;
}): ConversationPipelineContext {
  const records = new Map(
    (overrides?.sessionStoreRecords ?? []).map((r) => [r.threadTs, { ...r }]),
  );
  const sessionStore: SessionStore = {
    countAll: () => records.size,
    get: (ts) => {
      const r = records.get(ts);
      return r ? { ...r } : undefined;
    },
    patch: vi.fn((ts, patch) => {
      const existing = records.get(ts);
      if (!existing) return undefined;
      const next = { ...existing, ...patch, threadTs: ts, updatedAt: new Date().toISOString() };
      records.set(ts, next);
      return { ...next };
    }),
    upsert: vi.fn((record) => {
      records.set(record.threadTs, { ...record });
      return { ...record };
    }),
  };
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

  const unregister = vi.fn();
  const threadExecutionRegistry = {
    listActive: vi.fn().mockReturnValue([]),
    register: vi.fn().mockReturnValue(unregister),
    stopAll: vi.fn().mockResolvedValue({ failed: 0, stopped: 0 }),
    stopByMessage: vi.fn().mockResolvedValue({ failed: 0, stopped: 0 }),
    trackMessage: vi.fn(),
    ...overrides?.threadExecutionRegistry,
  } as ConversationPipelineContext['deps']['threadExecutionRegistry'];

  return {
    client: {
      assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      chat: {
        delete: vi.fn().mockResolvedValue({}),
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
        update: vi.fn().mockResolvedValue({}),
      },
      conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
      files: { uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }) },
      reactions: { add: vi.fn().mockResolvedValue({}) },
      views: { open: vi.fn().mockResolvedValue({}) },
    } as unknown as SlackWebClientLike,
    deps: {
      claudeExecutor: {
        providerId: 'claude',
        execute: vi.fn().mockResolvedValue(undefined),
        drain: vi.fn(),
      } as unknown as AgentExecutor,
      logger: logger as unknown as AppLogger,
      memoryStore: {
        listForContext: vi.fn().mockReturnValue({ global: [], workspace: [], preferences: [] }),
      } as unknown as MemoryStore,
      renderer: {
        addAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
        clearUiState: vi.fn().mockResolvedValue(undefined),
        deleteThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
        finalizeThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
        postGeneratedImages: vi.fn().mockResolvedValue([]),
        postThreadReply: vi.fn().mockResolvedValue(undefined),
        setUiState: vi.fn().mockResolvedValue(undefined),
        showThinkingIndicator: vi.fn().mockResolvedValue(undefined),
        upsertThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
      } as unknown as SlackRenderer,
      sessionStore,
      threadContextLoader: {
        loadThread: vi.fn().mockResolvedValue({
          channelId: 'C123',
          messages: [],
          renderedPrompt: '',
          threadTs: 'ts1',
        }),
      } as unknown as SlackThreadContextLoader,
      threadExecutionRegistry,
      workspaceResolver: {
        resolveFromText: vi
          .fn()
          .mockReturnValue(
            overrides?.workspaceResolverResult ?? { status: 'missing', query: '', reason: 'none' },
          ),
      } as unknown as WorkspaceResolver,
    },
    message: { channel: 'C123', team: 'T123', text: 'hello', ts: 'ts1', user: 'U123' },
    options: {
      addAcknowledgementReaction: overrides?.addAcknowledgementReaction ?? false,
      logLabel: 'test',
      rootMessageTs: 'ts1',
    },
    threadTs: 'ts1',
  };
}

describe('acknowledgeAndLog step', () => {
  it('sets existingSession on context from session store', async () => {
    const session = {
      channelId: 'C123',
      createdAt: '',
      rootMessageTs: 'ts1',
      threadTs: 'ts1',
      updatedAt: '',
    };
    const ctx = createMinimalPipelineContext({
      sessionStoreRecords: [session],
    });

    const result = await acknowledgeAndLog(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.existingSession).toBeDefined();
    expect(ctx.existingSession?.threadTs).toBe('ts1');
  });

  it('adds acknowledgement reaction when configured', async () => {
    const ctx = createMinimalPipelineContext({ addAcknowledgementReaction: true });

    await acknowledgeAndLog(ctx);

    expect(ctx.deps.renderer.addAcknowledgementReaction).toHaveBeenCalledWith(
      ctx.client,
      'C123',
      'ts1',
    );
  });
});

describe('resolveWorkspaceStep step', () => {
  it('returns done when workspace is ambiguous', async () => {
    const ctx = createMinimalPipelineContext({
      workspaceResolverResult: {
        status: 'ambiguous',
        query: 'my-app',
        reason: 'multiple',
        candidates: [
          {
            aliases: [],
            id: 'org1/my-app',
            label: 'org1/my-app',
            name: 'my-app',
            relativePath: 'org1/my-app',
            repoPath: '/tmp/1',
          },
          {
            aliases: [],
            id: 'org2/my-app',
            label: 'org2/my-app',
            name: 'my-app',
            relativePath: 'org2/my-app',
            repoPath: '/tmp/2',
          },
        ],
      },
    });

    const result = await resolveWorkspaceStep(ctx);

    expect(result.action).toBe('done');
    expect(ctx.client.chat.postMessage).toHaveBeenCalled();
  });

  it('sets workspace on context when unique', async () => {
    const workspace = {
      input: '/tmp/repo',
      matchKind: 'repo' as const,
      repo: {
        aliases: [],
        id: 'r1',
        label: 'r1',
        name: 'repo',
        relativePath: 'r1',
        repoPath: '/tmp/repo',
      },
      source: 'auto' as const,
      workspaceLabel: 'repo',
      workspacePath: '/tmp/repo',
    };
    const ctx = createMinimalPipelineContext({
      workspaceResolverResult: { status: 'unique', workspace },
    });

    const result = await resolveWorkspaceStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.workspace).toEqual(workspace);
  });
});

describe('resolveSessionStep step', () => {
  it('sets resumeHandle on context', async () => {
    const ctx = createMinimalPipelineContext();

    const result = await resolveSessionStep(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.resumeHandle).toBeUndefined();
  });
});

describe('prepareThreadContext step', () => {
  it('loads thread context and sets it on ctx', async () => {
    const ctx = createMinimalPipelineContext();

    const result = await prepareThreadContext(ctx);

    expect(result.action).toBe('continue');
    expect(ctx.threadContext).toBeDefined();
    expect(ctx.deps.threadContextLoader.loadThread).toHaveBeenCalled();
  });
});

describe('executeAgent step', () => {
  it('registers execution, passes abortSignal to executor, and unregisters in finally', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    await executeAgent(ctx);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C123',
        executionId: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i),
        providerId: 'claude',
        startedAt: expect.any(String),
        threadTs: 'ts1',
        userId: 'U123',
      }),
    );
    const firstRegisterCall = register.mock.calls[0];
    if (!firstRegisterCall) {
      throw new Error('Expected register() to be called once');
    }
    const registered = firstRegisterCall[0] as { stop: () => Promise<void> };
    expect(typeof registered.stop).toBe('function');

    expect(ctx.deps.claudeExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }),
      expect.anything(),
    );

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('removes execution from registry on stop before execute settles and only calls unregister once', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async () => {
      const registered = register.mock.calls[0]?.[0] as { stop: () => Promise<void> };
      await registered.stop();
      expect(unregister).toHaveBeenCalledTimes(1);
    });

    await executeAgent(ctx);

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('idempotent stop during execute does not call unregister more than once', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);

    vi.mocked(ctx.deps.claudeExecutor.execute).mockImplementation(async () => {
      const registered = register.mock.calls[0]?.[0] as { stop: () => Promise<void> };
      await registered.stop();
      await registered.stop();
    });

    await executeAgent(ctx);

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('unregisters in finally when execute rejects', async () => {
    const unregister = vi.fn();
    const register = vi.fn().mockReturnValue(unregister);
    const ctx = createMinimalPipelineContext({
      threadExecutionRegistry: {
        listActive: vi.fn(),
        register,
        stopAll: vi.fn(),
      } as unknown as ThreadExecutionRegistry,
    });
    await prepareThreadContext(ctx);
    vi.mocked(ctx.deps.claudeExecutor.execute).mockRejectedValueOnce(new Error('exec failed'));

    await executeAgent(ctx);

    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
