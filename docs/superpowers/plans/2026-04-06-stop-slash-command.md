# Stop Slash Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stop` slash command that can be used inside a Slack thread to stop all active bot executions for that thread, preserve already-visible output, clear transient UI, and mark the interruption as user-stopped.

**Architecture:** Add an in-memory `ThreadExecutionRegistry` shared by ingress and slash-command layers. Propagate cancellation through `AbortSignal` into the Claude executor, surface a distinct `stopped` lifecycle event, and teach the activity/rendering path to finalize stop differently from completion or failure.

**Tech Stack:** TypeScript strict mode, Slack Bolt, Claude Agent SDK adapter, Vitest, live Slack E2E harness

---

## File Map

- Create: `src/slack/execution/thread-execution-registry.ts`
- Create: `src/slack/commands/stop-command.ts`
- Create: `tests/thread-execution-registry.test.ts`
- Create: `src/e2e/live/run-stop-slash-command.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/providers/claude-code/adapter.ts`
- Modify: `src/slack/ingress/types.ts`
- Modify: `src/slack/ingress/conversation-pipeline.ts`
- Modify: `src/slack/ingress/activity-sink.ts`
- Modify: `src/slack/render/slack-renderer.ts`
- Modify: `src/slack/render/status-probe.ts`
- Modify: `src/slack/commands/types.ts`
- Modify: `src/slack/commands/register.ts`
- Modify: `src/slack/commands/manifest-sync.ts`
- Modify: `src/slack/app.ts`
- Modify: `src/application.ts`
- Modify: `tests/slash-commands.test.ts`
- Modify: `tests/manifest-sync.test.ts`
- Modify: `tests/conversation-pipeline.test.ts`
- Modify: `tests/activity-sink.test.ts`
- Modify: `tests/slack-loading-status.test.ts`

---

### Task 1: Add the thread execution registry

**Files:**

- Create: `src/slack/execution/thread-execution-registry.ts`
- Test: `tests/thread-execution-registry.test.ts`

- [ ] **Step 1: Write the failing registry test**

Create `tests/thread-execution-registry.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';

describe('createThreadExecutionRegistry', () => {
  it('lists active executions by thread and removes them on cleanup', () => {
    const registry = createThreadExecutionRegistry();
    const stop = vi.fn().mockResolvedValue(undefined);

    const unregister = registry.register({
      executionId: 'exec-1',
      threadTs: 'thread-1',
      channelId: 'C123',
      userId: 'U123',
      providerId: 'claude-code',
      startedAt: '2026-04-06T00:00:00.000Z',
      stop,
    });

    expect(registry.listActive('thread-1')).toHaveLength(1);

    unregister();

    expect(registry.listActive('thread-1')).toEqual([]);
  });

  it('stopAll stops every active execution in the target thread only', async () => {
    const registry = createThreadExecutionRegistry();
    const stopA = vi.fn().mockResolvedValue(undefined);
    const stopB = vi.fn().mockResolvedValue(undefined);
    const stopOther = vi.fn().mockResolvedValue(undefined);

    registry.register({
      executionId: 'exec-a',
      threadTs: 'thread-1',
      channelId: 'C123',
      userId: 'U1',
      providerId: 'claude-code',
      startedAt: '2026-04-06T00:00:00.000Z',
      stop: stopA,
    });
    registry.register({
      executionId: 'exec-b',
      threadTs: 'thread-1',
      channelId: 'C123',
      userId: 'U2',
      providerId: 'claude-code',
      startedAt: '2026-04-06T00:00:01.000Z',
      stop: stopB,
    });
    registry.register({
      executionId: 'exec-c',
      threadTs: 'thread-2',
      channelId: 'C999',
      userId: 'U9',
      providerId: 'claude-code',
      startedAt: '2026-04-06T00:00:02.000Z',
      stop: stopOther,
    });

    await expect(registry.stopAll('thread-1', 'user_stop')).resolves.toEqual({
      failed: 0,
      stopped: 2,
    });

    expect(stopA).toHaveBeenCalledWith('user_stop');
    expect(stopB).toHaveBeenCalledWith('user_stop');
    expect(stopOther).not.toHaveBeenCalled();
  });

  it('returns partial failure counts when one stop throws', async () => {
    const registry = createThreadExecutionRegistry();
    registry.register({
      executionId: 'exec-a',
      threadTs: 'thread-1',
      channelId: 'C123',
      userId: 'U1',
      providerId: 'claude-code',
      startedAt: '2026-04-06T00:00:00.000Z',
      stop: vi.fn().mockResolvedValue(undefined),
    });
    registry.register({
      executionId: 'exec-b',
      threadTs: 'thread-1',
      channelId: 'C123',
      userId: 'U2',
      providerId: 'claude-code',
      startedAt: '2026-04-06T00:00:01.000Z',
      stop: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(registry.stopAll('thread-1', 'user_stop')).resolves.toEqual({
      failed: 1,
      stopped: 1,
    });
  });
});
```

- [ ] **Step 2: Run the registry test and confirm it fails**

Run: `pnpm exec vitest run tests/thread-execution-registry.test.ts`

Expected: FAIL because `src/slack/execution/thread-execution-registry.ts` does not exist yet.

- [ ] **Step 3: Implement the registry**

Create `src/slack/execution/thread-execution-registry.ts`:

```typescript
export type ThreadExecutionStopReason = 'user_stop';

export interface RegisteredThreadExecution {
  executionId: string;
  threadTs: string;
  channelId: string;
  userId: string;
  providerId: string;
  startedAt: string;
  stop: (reason: ThreadExecutionStopReason) => Promise<void>;
}

export interface StopAllResult {
  failed: number;
  stopped: number;
}

export interface ThreadExecutionRegistry {
  listActive: (threadTs: string) => RegisteredThreadExecution[];
  register: (execution: RegisteredThreadExecution) => () => void;
  stopAll: (threadTs: string, reason: ThreadExecutionStopReason) => Promise<StopAllResult>;
}

export function createThreadExecutionRegistry(): ThreadExecutionRegistry {
  const executionsByThread = new Map<string, Map<string, RegisteredThreadExecution>>();

  const listActive = (threadTs: string): RegisteredThreadExecution[] => [
    ...(executionsByThread.get(threadTs)?.values() ?? []),
  ];

  const register = (execution: RegisteredThreadExecution): (() => void) => {
    const threadMap = executionsByThread.get(execution.threadTs) ?? new Map();
    threadMap.set(execution.executionId, execution);
    executionsByThread.set(execution.threadTs, threadMap);

    return () => {
      const existing = executionsByThread.get(execution.threadTs);
      if (!existing) return;
      existing.delete(execution.executionId);
      if (existing.size === 0) {
        executionsByThread.delete(execution.threadTs);
      }
    };
  };

  const stopAll = async (
    threadTs: string,
    reason: ThreadExecutionStopReason,
  ): Promise<StopAllResult> => {
    const active = listActive(threadTs);
    let stopped = 0;
    let failed = 0;

    await Promise.all(
      active.map(async (execution) => {
        try {
          await execution.stop(reason);
          stopped += 1;
        } catch {
          failed += 1;
        }
      }),
    );

    return { failed, stopped };
  };

  return {
    listActive,
    register,
    stopAll,
  };
}
```

- [ ] **Step 4: Re-run the registry test**

Run: `pnpm exec vitest run tests/thread-execution-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/thread-execution-registry.test.ts src/slack/execution/thread-execution-registry.ts
git commit -m "feat: add thread execution registry"
```

---

### Task 2: Add abort-driven stop semantics to the executor

**Files:**

- Modify: `src/agent/types.ts`
- Modify: `src/agent/providers/claude-code/adapter.ts`
- Test: `tests/slack-loading-status.test.ts`

- [ ] **Step 1: Write the failing executor stop test**

Add this test to `tests/slack-loading-status.test.ts` near the other `ClaudeAgentSdkExecutor` tests:

```typescript
it('emits a stopped lifecycle event when the request abort signal fires', async () => {
  const logger = createTestLogger();
  const memoryStore = createMemoryStore();
  const executor = new ClaudeAgentSdkExecutor(logger, memoryStore);
  const events: AgentExecutionEvent[] = [];
  const controller = new AbortController();

  sdkMocks.query.mockImplementation(() =>
    createAbortableMessageStream(controller.signal, [
      {
        type: 'system',
        subtype: 'init',
        cwd: '/tmp/kagura',
        model: 'claude-sonnet-test',
        session_id: 'session-stop',
      },
    ]),
  );

  const execution = executor.execute(
    {
      ...createExecutionRequest(),
      abortSignal: controller.signal,
    },
    {
      onEvent: async (event) => {
        events.push(event);
      },
    },
  );

  controller.abort();
  await execution;

  expect(events).toContainEqual({ type: 'lifecycle', phase: 'started' });
  expect(events).toContainEqual({
    type: 'lifecycle',
    phase: 'stopped',
    reason: 'user_stop',
    resumeHandle: 'session-stop',
  });
  expect(events).not.toContainEqual(
    expect.objectContaining({ type: 'lifecycle', phase: 'failed' }),
  );
});
```

Add this helper near `createFailingMessageStream()`:

```typescript
async function* createAbortableMessageStream(
  signal: AbortSignal,
  messages: readonly unknown[],
): AsyncIterable<unknown> {
  for (const message of messages) {
    yield message;
  }

  await new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return;
}
```

- [ ] **Step 2: Run the executor test and confirm it fails**

Run: `pnpm exec vitest run tests/slack-loading-status.test.ts`

Expected: FAIL because `AgentExecutionRequest` does not accept `abortSignal` and no `stopped` lifecycle event exists.

- [ ] **Step 3: Extend agent types for stop**

Update `src/agent/types.ts`:

```typescript
export interface AgentExecutionRequest {
  abortSignal?: AbortSignal;
  channelId: string;
  contextMemories?: ContextMemories;
  mentionText: string;
  resumeHandle?: string;
  threadContext: NormalizedThreadContext;
  threadTs: string;
  userId: string;
  workspaceLabel?: string;
  workspacePath?: string;
  workspaceRepoId?: string;
}

export type AgentExecutionEvent =
  | {
      type: 'lifecycle';
      phase: 'started';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'completed';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'stopped';
      reason: 'user_stop';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'failed';
      resumeHandle?: string;
      error: string;
    };
```

- [ ] **Step 4: Make the Claude adapter abortable**

Update `src/agent/providers/claude-code/adapter.ts` with these helpers and loop changes:

```typescript
function createAbortError(): Error {
  return Object.assign(new Error('Execution stopped by user'), { name: 'AbortError' });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function nextMessageOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (!signal) {
    return iterator.next();
  }

  if (signal.aborted) {
    throw createAbortError();
  }

  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
```

Then replace the `for await (const message of session)` loop with:

```typescript
const iterator = session[Symbol.asyncIterator]();
while (true) {
  const next = await nextMessageOrAbort(iterator, request.abortSignal);
  if (next.done) {
    break;
  }

  const message = next.value;
  if (firstMessage) {
    firstMessage = false;
    this.logger.info(
      'First Claude SDK message (thread %s, type=%s)',
      request.threadTs,
      message.type,
    );
  }

  await handleClaudeSdkMessage(this.logger, message, sink, handlers);
}
```

Finally, update the `catch` block:

```typescript
    } catch (error) {
      if (isAbortError(error)) {
        await sink.onEvent({
          type: 'lifecycle',
          phase: 'stopped',
          reason: 'user_stop',
          ...(sessionId ? { resumeHandle: sessionId } : {}),
        });
        return;
      }

      const errorMessage = this.describeUnknownError(error);
      this.logger.error('Claude Agent SDK execution failed: %s', redact(errorMessage));
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'failed',
        ...(sessionId ? { resumeHandle: sessionId } : {}),
        error: errorMessage,
      });
    }
```

- [ ] **Step 5: Re-run the executor test**

Run: `pnpm exec vitest run tests/slack-loading-status.test.ts`

Expected: PASS, including the new stop test.

- [ ] **Step 6: Commit**

```bash
git add src/agent/types.ts src/agent/providers/claude-code/adapter.ts tests/slack-loading-status.test.ts
git commit -m "feat: add abortable executor stop lifecycle"
```

---

### Task 3: Teach rendering and activity sink how to finalize a stopped run

**Files:**

- Modify: `src/slack/render/status-probe.ts`
- Modify: `src/slack/render/slack-renderer.ts`
- Modify: `src/slack/ingress/activity-sink.ts`
- Test: `tests/activity-sink.test.ts`

- [ ] **Step 1: Write the failing stopped-finalization tests**

Add these tests to `tests/activity-sink.test.ts`:

```typescript
it('does not post the generic error message on lifecycle stopped', async () => {
  const renderer = createRendererStub();
  const sink = createActivitySink({
    channel: 'C123',
    client: createMockClient(),
    logger: createTestLogger(),
    renderer,
    sessionStore: createMockSessionStore(),
    threadTs: 'ts1',
  });

  await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'user_stop' });

  expect(renderer.postThreadReply).toHaveBeenCalledWith(
    expect.anything(),
    'C123',
    'ts1',
    '_Stopped by user._',
  );
  expect(renderer.postThreadReply).not.toHaveBeenCalledWith(
    expect.anything(),
    'C123',
    'ts1',
    'An error occurred while processing your request.',
  );
});

it('finalizes a progress message with stopped text when no assistant reply was posted', async () => {
  const renderer = createRendererStub();
  const sink = createActivitySink({
    channel: 'C123',
    client: createMockClient(),
    logger: createTestLogger(),
    renderer,
    sessionStore: createMockSessionStore(),
    threadTs: 'ts1',
  });

  await sink.onEvent({
    type: 'activity-state',
    state: {
      threadTs: 'ts1',
      status: 'Reading files...',
      activities: ['Reading src/index.ts...'],
      clear: false,
    },
  });
  await sink.onEvent({ type: 'lifecycle', phase: 'stopped', reason: 'user_stop' });
  await sink.finalize();

  expect(renderer.finalizeThreadProgressMessageStopped).toHaveBeenCalledWith(
    expect.anything(),
    'C123',
    'ts1',
    'progress-ts',
    expect.any(Map),
  );
});
```

Also extend `createRendererStub()` with:

```typescript
    finalizeThreadProgressMessageStopped: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 2: Run the activity-sink test and confirm it fails**

Run: `pnpm exec vitest run tests/activity-sink.test.ts`

Expected: FAIL because the stopped lifecycle phase and stopped progress finalizer do not exist yet.

- [ ] **Step 3: Add a stopped progress finalizer to the renderer**

Update `src/slack/render/status-probe.ts`:

```typescript
export interface SlackStatusProbeProgressRecord {
  action: 'post' | 'update' | 'delete' | 'finalize' | 'stopped';
  channelId: string;
  kind: 'progress-message';
  messageTs?: string;
  recordedAt: string;
  text?: string;
  threadTs: string;
}
```

Add this method to `src/slack/render/slack-renderer.ts`:

```typescript
  async finalizeThreadProgressMessageStopped(
    client: SlackWebClientLike,
    channelId: string,
    threadTs: string,
    progressMessageTs: string,
    toolHistory?: Map<string, number>,
  ): Promise<void> {
    const historySummary = formatToolHistorySummary(toolHistory);
    const text = 'Stopped by user.';
    const blocks: SlackBlock[] = [
      ...(historySummary
        ? [
            {
              type: 'context' as const,
              elements: [{ type: 'mrkdwn' as const, text: historySummary }],
            },
          ]
        : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text }],
      },
    ];

    await client.chat.update({
      channel: channelId,
      ts: progressMessageTs,
      text,
      blocks,
    });
    await this.statusProbe?.recordProgressMessage({
      action: 'stopped',
      channelId,
      kind: 'progress-message',
      messageTs: progressMessageTs,
      recordedAt: new Date().toISOString(),
      text,
      threadTs,
    });
  }
```

- [ ] **Step 4: Update the activity sink to track terminal phase**

Update `src/slack/ingress/activity-sink.ts`:

```typescript
let terminalPhase: 'completed' | 'failed' | 'stopped' | undefined;
```

Inside `handleLifecycleEvent()`:

```typescript
if (event.phase === 'started') return;
if (event.phase === 'completed') {
  terminalPhase = 'completed';
  return;
}
if (event.phase === 'stopped') {
  terminalPhase = 'stopped';
  if (!progressMessageTs) {
    await renderer.postThreadReply(client, channel, threadTs, '_Stopped by user._');
  }
  return;
}
if (event.phase === 'failed') {
  terminalPhase = 'failed';
  runtimeError(
    logger,
    'Execution failed for thread %s: %s',
    threadTs,
    redact(String(event.error ?? '')),
  );
  await renderer.postThreadReply(
    client,
    channel,
    threadTs,
    'An error occurred while processing your request.',
  );
}
```

Replace `finalize()` with:

```typescript
    async finalize(): Promise<void> {
      await renderer.clearUiState(client, channel, threadTs).catch((err) => {
        logger.warn('Failed to clear UI state: %s', String(err));
      });

      if (!progressMessageTs) {
        return;
      }

      if (terminalPhase === 'stopped') {
        await renderer
          .finalizeThreadProgressMessageStopped(
            client,
            channel,
            threadTs,
            progressMessageTs,
            toolHistory,
          )
          .catch((err) => {
            logger.warn('Failed to finalize stopped progress message: %s', String(err));
          });
        return;
      }

      await renderer
        .finalizeThreadProgressMessage(client, channel, threadTs, progressMessageTs, toolHistory)
        .catch((err) => {
          logger.warn('Failed to finalize progress message: %s', String(err));
        });
    },
```

- [ ] **Step 5: Re-run the activity-sink test**

Run: `pnpm exec vitest run tests/activity-sink.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/slack/render/status-probe.ts src/slack/render/slack-renderer.ts src/slack/ingress/activity-sink.ts tests/activity-sink.test.ts
git commit -m "feat: render stopped lifecycle distinctly in Slack"
```

---

### Task 4: Wire the registry into the conversation pipeline and application

**Files:**

- Modify: `src/slack/ingress/types.ts`
- Modify: `src/slack/commands/types.ts`
- Modify: `src/slack/ingress/conversation-pipeline.ts`
- Modify: `src/slack/app.ts`
- Modify: `src/application.ts`
- Test: `tests/conversation-pipeline.test.ts`

- [ ] **Step 1: Write the failing pipeline registration test**

Add this test to `tests/conversation-pipeline.test.ts` and export `executeAgent` from the existing import list if needed:

```typescript
import { executeAgent } from '~/slack/ingress/conversation-pipeline.js';

it('registers the execution, passes abortSignal, and unregisters in finally', async () => {
  const unregister = vi.fn();
  const register = vi.fn().mockReturnValue(unregister);
  const execute = vi.fn().mockResolvedValue(undefined);
  const ctx = createMinimalPipelineContext();

  ctx.threadContext = {
    channelId: 'C123',
    messages: [],
    renderedPrompt: '',
    threadTs: 'ts1',
  };
  ctx.deps.threadExecutionRegistry = {
    listActive: vi.fn().mockReturnValue([]),
    register,
    stopAll: vi.fn(),
  };
  ctx.deps.claudeExecutor = {
    providerId: 'claude-code',
    execute,
    drain: vi.fn(),
  } as unknown as AgentExecutor;

  await executeAgent(ctx);

  expect(register).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
      threadTs: 'ts1',
    }),
    expect.any(Object),
  );
  expect(unregister).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the pipeline test and confirm it fails**

Run: `pnpm exec vitest run tests/conversation-pipeline.test.ts`

Expected: FAIL because ingress deps do not include a thread execution registry and the pipeline does not register executions.

- [ ] **Step 3: Add the registry to shared dependency types**

Update `src/slack/ingress/types.ts`:

```typescript
import type { ThreadExecutionRegistry } from '../execution/thread-execution-registry.js';

export interface SlackIngressDependencies {
  claudeExecutor: AgentExecutor;
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry?: AgentProviderRegistry;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
  threadExecutionRegistry: ThreadExecutionRegistry;
  workspaceResolver: WorkspaceResolver;
}
```

Update `src/slack/commands/types.ts`:

```typescript
import type { ThreadExecutionRegistry } from '../execution/thread-execution-registry.js';

export interface SlashCommandDependencies {
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry: AgentProviderRegistry;
  sessionStore: SessionStore;
  threadExecutionRegistry: ThreadExecutionRegistry;
  workspaceResolver: WorkspaceResolver;
}
```

- [ ] **Step 4: Register executions around `executeAgent()`**

Update `src/slack/ingress/conversation-pipeline.ts`:

```typescript
import { randomUUID } from 'node:crypto';
```

Inside `executeAgent()` before `await executor.execute(...)`:

```typescript
const controller = new AbortController();
const unregisterExecution = deps.threadExecutionRegistry.register({
  executionId: randomUUID(),
  threadTs,
  channelId: message.channel,
  userId: message.user,
  providerId: executor.providerId,
  startedAt: new Date().toISOString(),
  stop: async () => {
    controller.abort();
  },
});
```

Pass the signal into the request:

```typescript
        abortSignal: controller.signal,
```

And update the `finally` block:

```typescript
  } finally {
    unregisterExecution();
    await sink.finalize();
  }
```

- [ ] **Step 5: Instantiate and pass the registry through app composition**

Update `src/slack/app.ts`:

```typescript
export interface SlackApplicationDependencies {
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry: AgentProviderRegistry;
  sessionStore: SessionStore;
  statusProbe?: SlackStatusProbe;
  threadExecutionRegistry: ThreadExecutionRegistry;
  workspaceResolver: WorkspaceResolver;
}
```

Update the `ingressDeps` and `registerSlashCommands()` calls:

```typescript
    threadExecutionRegistry: deps.threadExecutionRegistry,
```

Update `src/application.ts`:

```typescript
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
```

Create the singleton:

```typescript
const threadExecutionRegistry = createThreadExecutionRegistry();
```

Pass it into `createSlackApp()`:

```typescript
    threadExecutionRegistry,
```

- [ ] **Step 6: Re-run the pipeline test**

Run: `pnpm exec vitest run tests/conversation-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/slack/ingress/types.ts src/slack/commands/types.ts src/slack/ingress/conversation-pipeline.ts src/slack/app.ts src/application.ts tests/conversation-pipeline.test.ts
git commit -m "feat: wire thread execution tracking into ingress"
```

---

### Task 5: Add `/stop` command handling and manifest registration

**Files:**

- Create: `src/slack/commands/stop-command.ts`
- Modify: `src/slack/commands/register.ts`
- Modify: `src/slack/commands/manifest-sync.ts`
- Modify: `tests/slash-commands.test.ts`
- Modify: `tests/manifest-sync.test.ts`

- [ ] **Step 1: Write the failing slash-command tests**

Add these tests to `tests/slash-commands.test.ts`:

```typescript
import { handleStopCommand } from '~/slack/commands/stop-command.js';

describe('handleStopCommand', () => {
  it('requires a thread context', async () => {
    const deps = createTestDeps();
    const result = await handleStopCommand({
      ...deps,
      channelId: 'C123',
      threadTs: undefined,
    });

    expect(result).toEqual({
      response_type: 'ephemeral',
      text: 'Use `/stop` inside the thread you want to stop.',
    });
  });

  it('returns a no-op message when the thread has no active executions', async () => {
    const deps = createTestDeps();
    const result = await handleStopCommand({
      ...deps,
      channelId: 'C123',
      threadTs: 'ts1',
    });

    expect(result).toEqual({
      response_type: 'ephemeral',
      text: 'There is no in-progress reply in this thread.',
    });
  });

  it('reports how many executions were stopped', async () => {
    const deps = createTestDeps({
      stopAllResult: { failed: 1, stopped: 2 },
    });
    const result = await handleStopCommand({
      ...deps,
      channelId: 'C123',
      threadTs: 'ts1',
    });

    expect(result).toEqual({
      response_type: 'ephemeral',
      text: 'Stopped 2 in-progress replies in this thread. Failed to stop 1 reply.',
    });
  });
});
```

Update `createTestDeps()` in the same file to include:

```typescript
    threadExecutionRegistry: {
      listActive: vi.fn().mockReturnValue([]),
      register: vi.fn(),
      stopAll: vi.fn().mockResolvedValue(options?.stopAllResult ?? { failed: 0, stopped: 0 }),
    },
```

and extend its options:

```typescript
  stopAllResult?: { failed: number; stopped: number };
```

Update `tests/manifest-sync.test.ts` expected command lists from 5 commands to 6 and include `'/stop'`.

- [ ] **Step 2: Run the slash-command tests and confirm they fail**

Run: `pnpm exec vitest run tests/slash-commands.test.ts tests/manifest-sync.test.ts`

Expected: FAIL because `handleStopCommand()` and manifest support do not exist yet.

- [ ] **Step 3: Implement the stop command**

Create `src/slack/commands/stop-command.ts`:

```typescript
import type { AppLogger } from '~/logger/index.js';

import type { ThreadExecutionRegistry } from '../execution/thread-execution-registry.js';
import type { SlashCommandResponse } from './types.js';

export interface StopCommandDependencies {
  channelId?: string | undefined;
  logger: AppLogger;
  threadExecutionRegistry: ThreadExecutionRegistry;
  threadTs?: string | undefined;
}

export async function handleStopCommand(
  deps: StopCommandDependencies,
): Promise<SlashCommandResponse> {
  if (!deps.threadTs) {
    return {
      response_type: 'ephemeral',
      text: 'Use `/stop` inside the thread you want to stop.',
    };
  }

  const result = await deps.threadExecutionRegistry.stopAll(deps.threadTs, 'user_stop');
  if (result.stopped === 0 && result.failed === 0) {
    return {
      response_type: 'ephemeral',
      text: 'There is no in-progress reply in this thread.',
    };
  }

  const parts = [
    `Stopped ${result.stopped} in-progress repl${result.stopped === 1 ? 'y' : 'ies'} in this thread.`,
  ];
  if (result.failed > 0) {
    parts.push(`Failed to stop ${result.failed} repl${result.failed === 1 ? 'y' : 'ies'}.`);
  }

  return {
    response_type: 'ephemeral',
    text: parts.join(' '),
  };
}
```

- [ ] **Step 4: Register `/stop` like `/provider`**

Update `src/slack/commands/register.ts`:

```typescript
import { handleStopCommand } from './stop-command.js';
```

Add this command registration:

```typescript
app.command('/stop', async ({ ack, command }) => {
  deps.logger.info('Slash command /stop invoked by %s', command.user_id);
  try {
    const threadTs =
      typeof command.thread_ts === 'string' && command.thread_ts.trim()
        ? command.thread_ts.trim()
        : undefined;
    const response = await handleStopCommand({
      ...deps,
      channelId: command.channel_id,
      threadTs,
    });
    await ack(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.error('Slash command /stop failed: %s', message);
    await ack({
      response_type: 'ephemeral',
      text: 'An error occurred while processing `/stop`. Please try again.',
    });
  }
});
```

Update `allCommandNames` to include `'/stop'`.

Update `src/slack/commands/manifest-sync.ts`:

```typescript
  {
    command: '/stop',
    description: 'Stop all in-progress bot replies in the current thread',
    usage_hint: ' ',
  },
```

- [ ] **Step 5: Re-run the slash-command tests**

Run: `pnpm exec vitest run tests/slash-commands.test.ts tests/manifest-sync.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/slack/commands/stop-command.ts src/slack/commands/register.ts src/slack/commands/manifest-sync.ts tests/slash-commands.test.ts tests/manifest-sync.test.ts
git commit -m "feat: add thread-scoped stop slash command"
```

---

### Task 6: Add a live Slack stop scenario and run full verification

**Files:**

- Create: `src/e2e/live/run-stop-slash-command.ts`
- Modify: `src/application.ts`

- [ ] **Step 1: Expose the registry from the runtime application for E2E use**

Update `src/application.ts`:

```typescript
import type { ThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';

export interface RuntimeApplication {
  readonly logger: AppLogger;
  readonly threadExecutionRegistry: ThreadExecutionRegistry;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}
```

Return the registry:

```typescript
  return {
    logger,
    threadExecutionRegistry,
    async start() {
```

- [ ] **Step 2: Write the live stop scenario**

Create `src/e2e/live/run-stop-slash-command.ts`:

```typescript
import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';
import { handleStopCommand } from '~/slack/commands/stop-command.js';
import { readSlackStatusProbeFile, resetSlackStatusProbeFile } from './file-slack-status-probe.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED || !env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Set Slack live E2E environment variables before running stop-slash-command.');
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const app = createApplication();
  await app.start();

  try {
    const root = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `<@${botIdentity.user_id}> STOP_E2E ${runId} Read package.json, then read src/index.ts, then read src/application.ts, and reply with STOP_OK ${runId}.`,
      unfurl_links: false,
      unfurl_media: false,
    });

    await waitForActiveExecution(app.threadExecutionRegistry, root.ts);

    await handleStopCommand({
      channelId: env.SLACK_E2E_CHANNEL_ID,
      logger: app.logger.withTag('e2e:stop'),
      threadExecutionRegistry: app.threadExecutionRegistry,
      threadTs: root.ts,
    });

    await delay(3_000);

    const replies = await botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID,
      inclusive: true,
      limit: 50,
      ts: root.ts,
    });
    const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
    const threadProbeRecords = probeRecords.filter((record) => record.threadTs === root.ts);

    if (replies.messages?.some((message) => message.text?.includes(`STOP_OK ${runId}`))) {
      throw new Error('Assistant completed after /stop was issued.');
    }
    if (!replies.messages?.some((message) => message.text?.includes('Stopped by user'))) {
      throw new Error('Thread is missing the stopped marker.');
    }
    if (
      threadProbeRecords.some(
        (record) => record.kind === 'progress-message' && record.action === 'stopped',
      ) === false &&
      replies.messages?.some((message) => message.text?.includes('Stopped by user')) === false
    ) {
      throw new Error('Neither a stopped progress update nor a stopped reply marker was recorded.');
    }

    await writeResult(runId, root.ts, threadProbeRecords);
  } finally {
    await app.stop();
  }
}

async function waitForActiveExecution(
  registry: ReturnType<typeof createApplication>['threadExecutionRegistry'],
  threadTs: string,
): Promise<void> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (registry.listActive(threadTs).length > 0) return;
    await delay(500);
  }
  throw new Error('Timed out waiting for an active execution to appear.');
}

async function writeResult(
  runId: string,
  threadTs: string,
  probeRecords: unknown[],
): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'stop-slash-command-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(
    absolutePath,
    `${JSON.stringify({ passed: true, probeRecords, runId, threadTs }, null, 2)}\n`,
    'utf8',
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'stop-slash-command',
  title: 'Stop Slash Command',
  description:
    'Trigger a real thread reply, stop it through the shared registry-backed stop handler, and verify the thread shows a stopped marker.',
  keywords: ['stop', 'slash', 'thread', 'cancel', 'interrupt'],
  run: main,
};

runDirectly(scenario);
```

- [ ] **Step 3: Run focused validation**

Run:

```bash
pnpm exec vitest run tests/thread-execution-registry.test.ts tests/slash-commands.test.ts tests/manifest-sync.test.ts tests/conversation-pipeline.test.ts tests/activity-sink.test.ts tests/slack-loading-status.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run repo-level verification**

Run:

```bash
pnpm build
pnpm test
pnpm e2e -- stop-slash-command
```

Expected:

- `pnpm build`: exits 0
- `pnpm test`: all tests pass
- `pnpm e2e -- stop-slash-command`: scenario passes and writes `stop-slash-command-result.json`

- [ ] **Step 5: Commit**

```bash
git add src/application.ts src/e2e/live/run-stop-slash-command.ts
git commit -m "test: add live stop slash command coverage"
```

---

## Self-Review

- **Spec coverage:** This plan covers `/stop` command handling, thread-scoped stop-all semantics, registry tracking, executor cancellation, stopped UI finalization, manifest registration, unit tests, and live Slack verification.
- **Placeholder scan:** No `TODO`, `TBD`, or “implement later” steps remain. Every code-changing step includes concrete file paths and code.
- **Type consistency:** The same names are used throughout: `ThreadExecutionRegistry`, `abortSignal`, `phase: 'stopped'`, `reason: 'user_stop'`, and `handleStopCommand()`.
