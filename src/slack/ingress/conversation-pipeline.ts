import { randomUUID } from 'node:crypto';

import type { AgentExecutor } from '~/agent/types.js';
import { redact } from '~/logger/redact.js';
import { runtimeError, runtimeInfo, runtimeWarn } from '~/logger/runtime.js';
import type { SessionRecord } from '~/session/types.js';

import type { SlackWebClientLike } from '../types.js';
import { createActivitySink } from './activity-sink.js';
import { resolveAndPersistSession } from './session-manager.js';
import type {
  ConversationPipelineContext,
  PipelineStep,
  PipelineStepResult,
  SlackIngressDependencies,
  ThreadConversationMessage,
  ThreadConversationOptions,
} from './types.js';
import {
  buildWorkspaceResolutionBlocks,
  resolveWorkspaceForConversation,
} from './workspace-resolution.js';

export async function runConversationPipeline(
  ctx: ConversationPipelineContext,
  steps: PipelineStep[],
): Promise<void> {
  for (const step of steps) {
    const result = await step(ctx);
    if (result.action === 'done') return;
  }
}

export async function handleThreadConversation(
  client: SlackWebClientLike,
  message: ThreadConversationMessage,
  deps: SlackIngressDependencies,
  options: ThreadConversationOptions,
): Promise<void> {
  const ctx: ConversationPipelineContext = {
    client,
    deps,
    message,
    options,
    threadTs: message.thread_ts ?? message.ts,
  };
  await runConversationPipeline(ctx, DEFAULT_CONVERSATION_STEPS);
}

const CONTINUE: PipelineStepResult = { action: 'continue' };

export async function acknowledgeAndLog(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, message, options, threadTs } = ctx;

  runtimeInfo(
    deps.logger,
    'Received %s in channel %s, root ts %s, thread ts %s',
    options.logLabel,
    message.channel,
    message.ts,
    threadTs,
  );

  ctx.existingSession = deps.sessionStore.get(threadTs);

  if (options.addAcknowledgementReaction) {
    await deps.renderer.addAcknowledgementReaction(ctx.client, message.channel, message.ts);
  }

  return CONTINUE;
}

export async function resolveWorkspaceStep(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, message, threadTs } = ctx;

  const workspaceResolution = resolveWorkspaceForConversation(
    message.text,
    ctx.existingSession,
    deps.workspaceResolver,
    ctx.options.workspaceOverride,
  );

  if (workspaceResolution.status === 'ambiguous') {
    runtimeWarn(
      deps.logger,
      'Ambiguous workspace for thread %s (%s)',
      threadTs,
      workspaceResolution.reason,
    );
    const { blocks, text } = buildWorkspaceResolutionBlocks(workspaceResolution, message.text);
    await ctx.client.chat.postMessage({
      blocks,
      channel: message.channel,
      text,
      thread_ts: threadTs,
    });
    return { action: 'done', reason: 'ambiguous workspace' };
  }

  ctx.workspace =
    workspaceResolution.status === 'unique' ? workspaceResolution.workspace : undefined;

  if (workspaceResolution.status === 'missing') {
    runtimeInfo(
      deps.logger,
      'No workspace detected for thread %s — proceeding without workspace (%s)',
      threadTs,
      workspaceResolution.reason,
    );
  }

  return CONTINUE;
}

export async function resolveSessionStep(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, message, options, threadTs, workspace } = ctx;

  const { resumeHandle } = resolveAndPersistSession(
    threadTs,
    message.channel,
    options.rootMessageTs,
    workspace,
    options.forceNewSession === true,
    deps.sessionStore,
  );
  ctx.resumeHandle = resumeHandle;

  return CONTINUE;
}

export async function prepareThreadContext(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { client, deps, message, threadTs, workspace } = ctx;

  await deps.renderer.showThinkingIndicator(client, message.channel, threadTs).catch((error) => {
    deps.logger.warn('Failed to show Slack thinking indicator: %s', String(error));
  });

  runtimeInfo(deps.logger, 'Loading thread context for %s', threadTs);
  ctx.threadContext = await deps.threadContextLoader.loadThread(client, message.channel, threadTs);
  runtimeInfo(
    deps.logger,
    'Thread context loaded for %s (%d messages)',
    threadTs,
    ctx.threadContext.messages.length,
  );

  ctx.contextMemories = deps.memoryStore.listForContext(workspace?.repo.id);

  return CONTINUE;
}

export async function executeAgent(ctx: ConversationPipelineContext): Promise<PipelineStepResult> {
  const {
    client,
    deps,
    message,
    threadTs,
    workspace,
    resumeHandle,
    threadContext,
    contextMemories,
  } = ctx;

  if (!threadContext) {
    throw new Error('Pipeline invariant: threadContext must be set before executeAgent');
  }

  const executor = resolveExecutor(ctx.existingSession, deps);
  const sink = createActivitySink({
    channel: message.channel,
    client,
    logger: deps.logger,
    renderer: deps.renderer,
    sessionStore: deps.sessionStore,
    threadTs,
    ...(workspace ? { workspaceLabel: workspace.workspaceLabel } : {}),
  });

  const controller = new AbortController();
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  let executionReleasedFromRegistry = false;
  const releaseExecutionFromRegistry = () => {
    if (executionReleasedFromRegistry) {
      return;
    }
    executionReleasedFromRegistry = true;
    unregisterExecution();
  };

  const unregisterExecution = deps.threadExecutionRegistry.register({
    channelId: message.channel,
    executionId,
    providerId: executor.providerId,
    startedAt,
    stop: async () => {
      releaseExecutionFromRegistry();
      controller.abort();
    },
    threadTs,
    userId: message.user,
  });

  deps.threadExecutionRegistry.trackMessage(message.ts, threadTs);

  try {
    runtimeInfo(
      deps.logger,
      'Starting agent execution for thread %s (provider=%s)',
      threadTs,
      executor.providerId,
    );
    await executor.execute(
      {
        abortSignal: controller.signal,
        channelId: message.channel,
        threadTs,
        userId: message.user,
        mentionText: message.text,
        threadContext,
        ...(contextMemories ? { contextMemories } : {}),
        ...(workspace
          ? {
              workspaceLabel: workspace.workspaceLabel,
              workspacePath: workspace.workspacePath,
              workspaceRepoId: workspace.repo.id,
            }
          : {}),
        ...(resumeHandle ? { resumeHandle } : {}),
      },
      sink,
    );
    runtimeInfo(deps.logger, 'Agent execution completed for thread %s', threadTs);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    runtimeError(
      deps.logger,
      'Agent execution failed for thread %s: %s',
      threadTs,
      redact(errorMessage),
    );
    await deps.renderer.postThreadReply(
      client,
      message.channel,
      threadTs,
      'An error occurred while processing your request.',
    );
  } finally {
    releaseExecutionFromRegistry();
    await sink.finalize();
  }

  return CONTINUE;
}

function resolveExecutor(
  session: SessionRecord | undefined,
  deps: SlackIngressDependencies,
): AgentExecutor {
  if (session?.agentProvider && deps.providerRegistry?.has(session.agentProvider)) {
    return deps.providerRegistry.getExecutor(session.agentProvider);
  }
  return deps.claudeExecutor;
}

export const DEFAULT_CONVERSATION_STEPS: PipelineStep[] = [
  acknowledgeAndLog,
  resolveWorkspaceStep,
  resolveSessionStep,
  prepareThreadContext,
  executeAgent,
];
