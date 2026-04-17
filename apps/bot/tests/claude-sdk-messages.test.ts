import path from 'node:path';

import type { SDKFilesPersistedEvent, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleClaudeSdkMessage } from '~/agent/providers/claude-code/messages.js';
import { createRuntimeUiStateTracker } from '~/agent/providers/claude-code/runtime-ui.js';
import type { MessageHandlers } from '~/agent/providers/claude-code/types.js';
import type { AgentExecutionEvent, AgentExecutionSink } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';

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

function minimalInitMessage(cwd: string): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-test',
    cwd,
    model: 'test-model',
    apiKeySource: 'project',
    claude_code_version: '0.0.0',
    tools: [],
    mcp_servers: [],
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '00000000-0000-4000-8000-000000000000',
  };
}

describe('handleClaudeSdkMessage — files_persisted', () => {
  let sessionCwd: string | undefined;
  let handlers: MessageHandlers;
  let events: AgentExecutionEvent[];
  let sink: AgentExecutionSink;

  beforeEach(() => {
    sessionCwd = undefined;
    events = [];
    sink = {
      onEvent: async (event) => {
        events.push(event);
      },
    };
    handlers = {
      collectAssistantText: vi.fn(),
      publishUiState: vi.fn().mockResolvedValue(undefined),
      runtimeUi: createRuntimeUiStateTracker(),
      setSessionId: vi.fn(),
      getSessionCwd: () => sessionCwd,
      setSessionCwd: (cwd: string) => {
        sessionCwd = cwd;
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits generated-images for persisted image files with paths resolved from session cwd', async () => {
    const root = '/tmp/claude-session-root';
    await handleClaudeSdkMessage(createTestLogger(), minimalInitMessage(root), sink, handlers);

    const persisted: SDKFilesPersistedEvent = {
      type: 'system',
      subtype: 'files_persisted',
      session_id: 'sess-test',
      uuid: '00000000-0000-4000-8000-000000000001',
      processed_at: new Date().toISOString(),
      failed: [],
      files: [
        { filename: 'out/screenshot.png', file_id: 'file-abc' },
        { filename: 'notes/readme.txt', file_id: 'file-txt' },
      ],
    };

    await handleClaudeSdkMessage(createTestLogger(), persisted, sink, handlers);

    const imgEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-images' }> =>
        e.type === 'generated-images',
    );
    const fileEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-files' }> =>
        e.type === 'generated-files',
    );
    expect(imgEvents).toHaveLength(1);
    expect(imgEvents[0]!.files).toEqual([
      {
        fileName: 'out/screenshot.png',
        path: path.resolve(root, 'out/screenshot.png'),
        providerFileId: 'file-abc',
      },
    ]);
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]!.files).toEqual([
      {
        fileName: 'notes/readme.txt',
        path: path.resolve(root, 'notes/readme.txt'),
        providerFileId: 'file-txt',
      },
    ]);
  });

  it('emits generated-files for persisted non-image files', async () => {
    await handleClaudeSdkMessage(createTestLogger(), minimalInitMessage('/tmp/ws'), sink, handlers);

    const persisted: SDKFilesPersistedEvent = {
      type: 'system',
      subtype: 'files_persisted',
      session_id: 'sess-test',
      uuid: '00000000-0000-4000-8000-000000000002',
      processed_at: new Date().toISOString(),
      failed: [],
      files: [{ filename: 'data.csv', file_id: 'id-1' }],
    };

    await handleClaudeSdkMessage(createTestLogger(), persisted, sink, handlers);

    expect(events.filter((e) => e.type === 'generated-images')).toHaveLength(0);
    const fileEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-files' }> =>
        e.type === 'generated-files',
    );
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]!.files).toEqual([
      {
        fileName: 'data.csv',
        path: path.resolve('/tmp/ws', 'data.csv'),
        providerFileId: 'id-1',
      },
    ]);
  });

  it('resolves paths against process.cwd() when session cwd was not set', async () => {
    const fallback = '/fallback/cwd';
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(fallback);

    const persisted: SDKFilesPersistedEvent = {
      type: 'system',
      subtype: 'files_persisted',
      session_id: 'sess-test',
      uuid: '00000000-0000-4000-8000-000000000003',
      processed_at: new Date().toISOString(),
      failed: [],
      files: [{ filename: 'img.JPEG', file_id: 'id-2' }],
    };

    await handleClaudeSdkMessage(createTestLogger(), persisted, sink, handlers);

    expect(spy).toHaveBeenCalled();
    const imgEvents = events.filter(
      (e): e is Extract<AgentExecutionEvent, { type: 'generated-images' }> =>
        e.type === 'generated-images',
    );
    expect(imgEvents).toHaveLength(1);
    expect(imgEvents[0]!.files[0]!.path).toBe(path.resolve(fallback, 'img.JPEG'));

    spy.mockRestore();
  });
});
