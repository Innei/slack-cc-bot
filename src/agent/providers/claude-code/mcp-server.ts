import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import type { AppLogger } from '~/logger/index.js';
import type { MemoryRecord, MemoryScope, MemoryStore } from '~/memory/types.js';
import {
  RecallMemoryToolInputSchema,
  SaveMemoryToolInputSchema,
} from '~/schemas/claude/memory-tools.js';
import { ClaudeUiStateToolInputShape } from '~/schemas/claude/publish-state.js';

import {
  parseSlackUiStateToolInput,
  SLACK_UI_STATE_TOOL_DESCRIPTION,
  SLACK_UI_STATE_TOOL_NAME,
} from '../tools/publish-state.js';
import {
  parseRecallMemoryToolInput,
  RECALL_MEMORY_TOOL_DESCRIPTION,
  RECALL_MEMORY_TOOL_NAME,
} from '../tools/recall-memory.js';
import {
  parseSaveMemoryToolInput,
  SAVE_MEMORY_TOOL_DESCRIPTION,
  SAVE_MEMORY_TOOL_NAME,
} from '../tools/save-memory.js';
import type { ClaudeExecutionRequest, ClaudeExecutionSink, ResolvedMemoryScope } from './types.js';

export function createAnthropicAgentSdkMcpServer(
  logger: AppLogger,
  memoryStore: MemoryStore,
  request: ClaudeExecutionRequest,
  sink: ClaudeExecutionSink,
) {
  return createSdkMcpServer({
    name: 'slack-ui',
    tools: [
      createPublishStateTool(logger, request, sink),
      createRecallMemoryTool(logger, memoryStore, request),
      createSaveMemoryTool(logger, memoryStore, request),
    ],
  });
}

function createPublishStateTool(
  logger: AppLogger,
  request: ClaudeExecutionRequest,
  sink: ClaudeExecutionSink,
) {
  return tool(
    SLACK_UI_STATE_TOOL_NAME,
    SLACK_UI_STATE_TOOL_DESCRIPTION,
    ClaudeUiStateToolInputShape,
    async (args) => {
      try {
        const state = parseSlackUiStateToolInput({
          ...args,
          threadTs: request.threadTs,
        });
        await sink.onEvent({ type: 'ui-state', state });
        return createTextToolResult('UI state published.');
      } catch (error) {
        return createToolValidationErrorResult(logger, SLACK_UI_STATE_TOOL_NAME, error);
      }
    },
  );
}

function createRecallMemoryTool(
  logger: AppLogger,
  memoryStore: MemoryStore,
  request: ClaudeExecutionRequest,
) {
  return tool(
    RECALL_MEMORY_TOOL_NAME,
    RECALL_MEMORY_TOOL_DESCRIPTION,
    RecallMemoryToolInputSchema.shape,
    async (args) => {
      try {
        const input = parseRecallMemoryToolInput(args);
        const resolvedScope = resolveMemoryScope(request.workspaceRepoId, input.scope);
        if (resolvedScope.missingWorkspace) {
          return createMissingWorkspaceToolResult('search');
        }

        const records = memoryStore.search(resolvedScope.repoId, input);
        if (records.length === 0) {
          return createTextToolResult(`No matching ${resolvedScope.scope} memories found.`);
        }

        return createTextToolResult(formatMemorySearchResults(records));
      } catch (error) {
        return createToolValidationErrorResult(logger, RECALL_MEMORY_TOOL_NAME, error);
      }
    },
  );
}

function createSaveMemoryTool(
  logger: AppLogger,
  memoryStore: MemoryStore,
  request: ClaudeExecutionRequest,
) {
  return tool(
    SAVE_MEMORY_TOOL_NAME,
    SAVE_MEMORY_TOOL_DESCRIPTION,
    SaveMemoryToolInputSchema.shape,
    async (args) => {
      try {
        const input = parseSaveMemoryToolInput(args);
        const resolvedScope = resolveMemoryScope(request.workspaceRepoId, input.scope);
        if (resolvedScope.missingWorkspace) {
          return createMissingWorkspaceToolResult('save');
        }

        const saved = memoryStore.save({
          repoId: resolvedScope.repoId,
          threadTs: request.threadTs,
          category: input.category,
          content: input.content,
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        });

        return createTextToolResult(`Memory saved (${resolvedScope.scope}): ${saved.id}`);
      } catch (error) {
        return createToolValidationErrorResult(logger, SAVE_MEMORY_TOOL_NAME, error);
      }
    },
  );
}

function createToolValidationErrorResult(
  logger: AppLogger,
  toolName: string,
  error: unknown,
): {
  content: [{ type: 'text'; text: string }];
  isError: true;
} {
  const message = describeUnknownError(error);
  logger.warn('%s validation failed: %s', toolName, message);
  return createValidationErrorToolResult(message);
}

function createTextToolResult(message: string): {
  content: [{ type: 'text'; text: string }];
} {
  return {
    content: [{ type: 'text', text: message }],
  };
}

function createValidationErrorToolResult(message: string): {
  content: [{ type: 'text'; text: string }];
  isError: true;
} {
  return {
    content: [{ type: 'text', text: `Validation error: ${message}` }],
    isError: true,
  };
}

function resolveMemoryScope(
  workspaceRepoId: string | undefined,
  requestedScope: MemoryScope | undefined,
): ResolvedMemoryScope {
  const scope = requestedScope ?? (workspaceRepoId ? 'workspace' : 'global');
  const missingWorkspace = scope === 'workspace' && !workspaceRepoId;

  return {
    missingWorkspace,
    repoId: scope === 'workspace' ? workspaceRepoId : undefined,
    scope,
  };
}

function createMissingWorkspaceToolResult(action: 'save' | 'search'): {
  content: [{ type: 'text'; text: string }];
} {
  if (action === 'search') {
    return createTextToolResult(
      'No workspace is set. Use scope "global" to search global memories, or mention a repository to set a workspace.',
    );
  }

  return createTextToolResult(
    'No workspace is set. Use scope "global" to save a global memory, or mention a repository to set a workspace.',
  );
}

function formatMemorySearchResults(records: MemoryRecord[]): string {
  return records.map((record, index) => formatMemorySearchResult(record, index)).join('\n');
}

function formatMemorySearchResult(record: MemoryRecord, index: number): string {
  const scopeLabel = record.scope === 'global' ? '🌐' : '📁';
  const header = `${index + 1}. ${scopeLabel} [${record.category}] ${record.createdAt}`;
  const metadata = record.metadata ? `\n   metadata: ${JSON.stringify(record.metadata)}` : '';

  return `${header}\n   ${record.content}${metadata}`;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
