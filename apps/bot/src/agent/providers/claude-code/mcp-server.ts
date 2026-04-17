import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentExecutionRequest,
  AgentExecutionSink,
  GeneratedOutputFile,
} from '~/agent/types.js';
import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryRecord, MemoryScope, MemoryStore } from '~/memory/types.js';

import { SetChannelDefaultWorkspaceToolInputSchema } from './schemas/channel-preference-tools.js';
import { RecallMemoryToolInputSchema, SaveMemoryToolInputSchema } from './schemas/memory-tools.js';
import { UploadSlackFileToolInputSchema } from './schemas/upload-slack-file.js';
import {
  parseRecallMemoryToolInput,
  RECALL_MEMORY_TOOL_DESCRIPTION,
  RECALL_MEMORY_TOOL_NAME,
} from './tools/recall-memory.js';
import {
  parseSaveMemoryToolInput,
  SAVE_MEMORY_TOOL_DESCRIPTION,
  SAVE_MEMORY_TOOL_NAME,
} from './tools/save-memory.js';
import {
  parseSetChannelDefaultWorkspaceToolInput,
  SET_CHANNEL_DEFAULT_WORKSPACE_TOOL_DESCRIPTION,
  SET_CHANNEL_DEFAULT_WORKSPACE_TOOL_NAME,
} from './tools/set-channel-default-workspace.js';
import {
  parseUploadSlackFileToolInput,
  UPLOAD_SLACK_FILE_TOOL_DESCRIPTION,
  UPLOAD_SLACK_FILE_TOOL_NAME,
} from './tools/upload-slack-file.js';
import type { ResolvedMemoryScope } from './types.js';

export function createAnthropicAgentSdkMcpServer(
  logger: AppLogger,
  memoryStore: MemoryStore,
  channelPreferenceStore: ChannelPreferenceStore,
  request: AgentExecutionRequest,
  sink: AgentExecutionSink,
) {
  return createSdkMcpServer({
    name: 'slack-ui',
    tools: [
      createRecallMemoryTool(logger, memoryStore, request),
      createSaveMemoryTool(logger, memoryStore, request),
      createSetChannelDefaultWorkspaceTool(logger, channelPreferenceStore, request),
      createUploadSlackFileTool(logger, request, sink),
    ],
  });
}

function createRecallMemoryTool(
  logger: AppLogger,
  memoryStore: MemoryStore,
  request: AgentExecutionRequest,
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
  request: AgentExecutionRequest,
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

function createSetChannelDefaultWorkspaceTool(
  logger: AppLogger,
  channelPreferenceStore: ChannelPreferenceStore,
  request: AgentExecutionRequest,
) {
  return tool(
    SET_CHANNEL_DEFAULT_WORKSPACE_TOOL_NAME,
    SET_CHANNEL_DEFAULT_WORKSPACE_TOOL_DESCRIPTION,
    SetChannelDefaultWorkspaceToolInputSchema.shape,
    async (args) => {
      try {
        const input = parseSetChannelDefaultWorkspaceToolInput(args);
        channelPreferenceStore.upsert(request.channelId, input.workspaceInput);
        return createTextToolResult(
          `Channel ${request.channelId} default workspace set to: ${input.workspaceInput}`,
        );
      } catch (error) {
        return createToolValidationErrorResult(
          logger,
          SET_CHANNEL_DEFAULT_WORKSPACE_TOOL_NAME,
          error,
        );
      }
    },
  );
}

function createUploadSlackFileTool(
  logger: AppLogger,
  request: AgentExecutionRequest,
  sink: AgentExecutionSink,
) {
  return tool(
    UPLOAD_SLACK_FILE_TOOL_NAME,
    UPLOAD_SLACK_FILE_TOOL_DESCRIPTION,
    UploadSlackFileToolInputSchema.shape,
    async (args) => {
      try {
        const input = parseUploadSlackFileToolInput(args);
        const resolved = await resolveUploadTargetPath(request, input.path);
        const fileMeta: GeneratedOutputFile = {
          fileName: path.basename(resolved.absolutePath),
          path: resolved.absolutePath,
          providerFileId: `manual-upload:${resolved.relativePath}`,
        };

        const eventType = isGeneratedImageFilename(fileMeta.fileName)
          ? 'generated-images'
          : 'generated-files';
        await sink.onEvent({
          type: eventType,
          files: [fileMeta],
        });

        return createTextToolResult(`Queued ${fileMeta.fileName} for Slack upload.`);
      } catch (error) {
        return createToolValidationErrorResult(logger, UPLOAD_SLACK_FILE_TOOL_NAME, error);
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

const GENERATED_IMAGE_FILENAME = /\.(?:gif|jpe?g|png|webp)$/i;

function isGeneratedImageFilename(filename: string): boolean {
  return GENERATED_IMAGE_FILENAME.test(path.basename(filename));
}

async function resolveUploadTargetPath(
  request: AgentExecutionRequest,
  inputPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const sessionRoot = path.resolve(request.workspacePath ?? process.cwd());
  const candidatePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(sessionRoot, inputPath);

  const fileStat = await stat(candidatePath).catch((error: unknown) => {
    throw new Error(
      `Cannot upload ${inputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!fileStat.isFile()) {
    throw new Error(`Cannot upload ${inputPath}: path is not a regular file.`);
  }

  const [realSessionRoot, realCandidatePath] = await Promise.all([
    realpath(sessionRoot).catch(() => sessionRoot),
    realpath(candidatePath),
  ]);

  const relativePath = path.relative(realSessionRoot, realCandidatePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(
      `Cannot upload ${inputPath}: path must stay inside the current workspace/session root (${realSessionRoot}).`,
    );
  }

  return {
    absolutePath: realCandidatePath,
    relativePath: normalizeUploadRelativePath(relativePath || path.basename(realCandidatePath)),
  };
}

function normalizeUploadRelativePath(relativePath: string): string {
  return relativePath.replaceAll(path.sep, '/');
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
