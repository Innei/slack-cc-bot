import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexCliExecutor } from '~/agent/providers/codex-cli/adapter.js';
import {
  buildCodexPrompt,
  CODEX_GENERATED_ARTIFACTS_DIR,
  getCodexMemoryOpsRelativePath,
} from '~/agent/providers/codex-cli/prompt.js';
import type { AgentExecutionEvent, AgentExecutionRequest } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryRecord, MemoryStore, SaveMemoryInput } from '~/memory/types.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

class FakeCodexProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  readonly stdin: Writable;

  constructor(private readonly onPrompt: (prompt: string, child: FakeCodexProcess) => void) {
    super();
    let prompt = '';
    this.stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += String(chunk);
        callback();
      },
      final: (callback) => {
        this.onPrompt(prompt, this);
        callback();
      },
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', null, signal ?? 'SIGTERM');
    });
    return true;
  }
}

function createRequest(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    channelId: 'C1',
    mentionText: 'hello',
    threadContext: {
      channelId: 'C1',
      fileLoadFailures: [],
      imageLoadFailures: [],
      loadedFiles: [],
      loadedImages: [],
      messages: [],
      renderedPrompt: '',
      threadTs: '1712345678.000100',
    },
    threadTs: '1712345678.000100',
    userId: 'U1',
    ...overrides,
  };
}

function createLogger(): AppLogger {
  return {
    child: () => createLogger(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: () => createLogger(),
  } as unknown as AppLogger;
}

function createSink(events: AgentExecutionEvent[]) {
  return {
    onEvent: vi.fn(async (event: AgentExecutionEvent) => {
      events.push(event);
    }),
  };
}

function writeJson(child: FakeCodexProcess, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

function createMemoryStore(saved: MemoryRecord[] = []): MemoryStore {
  return {
    countAll: vi.fn(),
    delete: vi.fn(),
    deleteAll: vi.fn(),
    listForContext: vi.fn(),
    listRecent: vi.fn(),
    prune: vi.fn(),
    pruneAll: vi.fn(),
    save: vi.fn((input: SaveMemoryInput) => {
      const record: MemoryRecord = {
        category: input.category,
        content: input.content,
        createdAt: '2026-04-24T00:00:00.000Z',
        id: `memory-${saved.length + 1}`,
        scope: input.repoId ? 'workspace' : 'global',
        ...(input.repoId ? { repoId: input.repoId } : {}),
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      };
      saved.push(record);
      return record;
    }),
    saveWithDedup: vi.fn(),
    search: vi.fn(),
  } as unknown as MemoryStore;
}

describe('CodexCliExecutor', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('maps Codex JSONL events to agent execution events', async () => {
    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, { type: 'turn.started' });
            writeJson(child, {
              type: 'item.started',
              item: {
                id: 'cmd-1',
                type: 'command_execution',
                command: '/bin/zsh -lc pwd',
                status: 'in_progress',
              },
            });
            writeJson(child, {
              type: 'item.completed',
              item: {
                id: 'cmd-1',
                type: 'command_execution',
                command: '/bin/zsh -lc pwd',
                aggregated_output: '/tmp/project\n',
                exit_code: 0,
                status: 'completed',
              },
            });
            writeJson(child, {
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text: 'done' },
            });
            writeJson(child, {
              type: 'turn.completed',
              usage: {
                cached_input_tokens: 20,
                input_tokens: 100,
                output_tokens: 5,
              },
            });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(createRequest(), createSink(events));

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', '--json', '--sandbox', 'danger-full-access']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(events).toContainEqual({
      type: 'lifecycle',
      phase: 'started',
      resumeHandle: 'codex-thread-1',
    });
    expect(events).toContainEqual({
      type: 'assistant-message',
      text: 'done',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-update',
        taskId: 'cmd-1',
        status: 'complete',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage-info',
        usage: expect.objectContaining({
          modelUsage: [
            expect.objectContaining({
              cacheHitRate: 20,
              inputTokensIncludeCache: true,
              inputTokens: 100,
              outputTokens: 5,
            }),
          ],
        }),
      }),
    );
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'completed',
      resumeHandle: 'codex-thread-1',
    });
  });

  it('uses codex exec resume when a resume handle exists', async () => {
    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((_prompt, child) => {
          queueMicrotask(() => {
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    await new CodexCliExecutor(createLogger()).execute(
      createRequest({ resumeHandle: 'codex-thread-1' }),
      createSink([]),
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', 'resume', 'codex-thread-1', '-']),
      expect.any(Object),
    );
  });

  it('retries without resume when Codex no longer has the saved rollout', async () => {
    spawnMock
      .mockImplementationOnce(
        () =>
          new FakeCodexProcess((_prompt, child) => {
            queueMicrotask(() => {
              child.stderr.write(
                'Error: thread/resume: thread/resume failed: no rollout found for thread id codex-thread-1\n',
              );
              child.stdout.end();
              child.stderr.end();
              child.emit('exit', 1, null);
            });
          }),
      )
      .mockImplementationOnce(
        () =>
          new FakeCodexProcess((_prompt, child) => {
            queueMicrotask(() => {
              writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-2' });
              writeJson(child, {
                type: 'item.completed',
                item: { id: 'msg-1', type: 'agent_message', text: 'fresh session' },
              });
              writeJson(child, { type: 'turn.completed', usage: {} });
              child.stdout.end();
              child.stderr.end();
              child.emit('exit', 0, null);
            });
          }),
      );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(
      createRequest({ resumeHandle: 'codex-thread-1' }),
      createSink(events),
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['exec', 'resume', 'codex-thread-1', '-']),
    );
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(
      expect.not.arrayContaining(['resume', 'codex-thread-1']),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ phase: 'failed' }));
    expect(events).toContainEqual({
      type: 'assistant-message',
      text: 'fresh session',
    });
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'completed',
      resumeHandle: 'codex-thread-2',
    });
  });

  it('emits generated-images for new Codex artifact files', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'codex-artifacts-'));
    const imagePath = path.join(workspacePath, CODEX_GENERATED_ARTIFACTS_DIR, 'blue.png');

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((prompt, child) => {
          expect(prompt).toContain(CODEX_GENERATED_ARTIFACTS_DIR);
          queueMicrotask(() => {
            writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, {
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text: 'LIVE_E2E_IMAGE_OK OUTBOUND' },
            });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    const events: AgentExecutionEvent[] = [];
    await new CodexCliExecutor(createLogger()).execute(
      createRequest({ workspacePath }),
      createSink(events),
    );

    expect(events).toContainEqual({
      type: 'generated-images',
      files: [
        {
          fileName: 'blue.png',
          path: imagePath,
          providerFileId: 'codex-local:blue.png',
        },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: 'lifecycle',
      phase: 'completed',
      resumeHandle: 'codex-thread-1',
    });
  });

  it('applies Codex save_memory JSONL operations after execution', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'codex-memory-'));
    const request = createRequest({
      executionId: 'exec-memory',
      workspacePath,
      workspaceRepoId: 'repo-a',
    });
    const memoryOpsPath = path.join(workspacePath, getCodexMemoryOpsRelativePath(request));
    const saved: MemoryRecord[] = [];
    const memoryStore = createMemoryStore(saved);

    spawnMock.mockImplementation(
      () =>
        new FakeCodexProcess((prompt, child) => {
          expect(prompt).toContain(getCodexMemoryOpsRelativePath(request));
          queueMicrotask(() => {
            writeFileSync(
              memoryOpsPath,
              `${JSON.stringify({
                tool: 'save_memory',
                category: 'decision',
                scope: 'workspace',
                content: 'remember this decision',
              })}\n`,
            );
            writeJson(child, { type: 'thread.started', thread_id: 'codex-thread-1' });
            writeJson(child, {
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text: 'saved' },
            });
            writeJson(child, { type: 'turn.completed', usage: {} });
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
          });
        }),
    );

    await new CodexCliExecutor(createLogger(), memoryStore).execute(request, createSink([]));

    expect(memoryStore.save).toHaveBeenCalledWith({
      category: 'decision',
      content: 'remember this decision',
      repoId: 'repo-a',
      threadTs: request.threadTs,
    });
    expect(saved).toHaveLength(1);
  });

  it('injects requested workspace skill markdown into the Codex prompt', () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'codex-skill-'));
    const skillDir = path.join(workspacePath, '.claude', 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '# Demo Skill\n\nReply with DEMO_SKILL_OK.',
      'utf8',
    );

    const prompt = buildCodexPrompt(
      createRequest({
        mentionText: 'Invoke /demo-skill exactly once.',
        workspacePath,
        workspaceRepoId: 'repo-a',
      }),
    );

    expect(prompt).toContain('<codex_workspace_skills>');
    expect(prompt).toContain('## /demo-skill');
    expect(prompt).toContain('Reply with DEMO_SKILL_OK.');
  });

  it('kills the Codex process and emits stopped on abort', async () => {
    let child: FakeCodexProcess | undefined;
    spawnMock.mockImplementation(() => {
      child = new FakeCodexProcess(() => {
        // Keep the process open until the abort signal arrives.
      });
      return child;
    });

    const controller = new AbortController();
    const events: AgentExecutionEvent[] = [];
    const execution = new CodexCliExecutor(createLogger()).execute(
      createRequest({ abortSignal: controller.signal }),
      createSink(events),
    );

    await Promise.resolve();
    controller.abort('user_stop');
    await execution;

    expect(child?.killed).toBe(true);
    expect(events).toContainEqual({
      type: 'lifecycle',
      phase: 'stopped',
      reason: 'user_stop',
    });
  });
});
