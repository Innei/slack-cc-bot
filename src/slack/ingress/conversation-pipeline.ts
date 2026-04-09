import { randomUUID } from 'node:crypto';

import type { AgentExecutor } from '~/agent/types.js';
import { redact } from '~/logger/redact.js';
import { runtimeError, runtimeInfo, runtimeWarn } from '~/logger/runtime.js';
import type { SessionRecord } from '~/session/types.js';

import type { ThreadExecutionStopReason } from '../execution/thread-execution-registry.js';
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

  if (!deps.threadExecutionRegistry.claimMessage(message.ts, threadTs)) {
    runtimeInfo(
      deps.logger,
      'Skipping %s for thread %s because message %s was already claimed by ingress',
      options.logLabel,
      threadTs,
      message.ts,
    );
    return { action: 'done', reason: 'duplicate ingress message' };
  }

  if (options.addAcknowledgementReaction) {
    await deps.renderer.addAcknowledgementReaction(ctx.client, message.channel, message.ts);
  }

  return CONTINUE;
}

export async function stopActiveExecutionsStep(
  ctx: ConversationPipelineContext,
): Promise<PipelineStepResult> {
  const { deps, threadTs } = ctx;
  const active = deps.threadExecutionRegistry.listActive(threadTs);
  const result = await deps.threadExecutionRegistry.stopAll(threadTs, 'superseded');
  if (active.length === 0 && result.stopped === 0 && result.failed === 0) {
    return CONTINUE;
  }

  if (active.length > 0) {
    runtimeInfo(
      deps.logger,
      'Stopping %d active execution(s) in thread %s before processing new message',
      active.length,
      threadTs,
    );
  } else {
    runtimeInfo(
      deps.logger,
      'Waiting for in-flight execution shutdown to finish in thread %s before processing new message',
      threadTs,
    );
  }
  runtimeInfo(
    deps.logger,
    'Stopped %d execution(s) in thread %s (failed=%d)',
    result.stopped,
    threadTs,
    result.failed,
  );

  // Refresh session from store — the stopped execution may have persisted a new providerSessionId
  ctx.existingSession = deps.sessionStore.get(threadTs);

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

  if (ctx.options.addAcknowledgementReaction) {
    await deps.renderer
      .removeAcknowledgementReaction(client, message.channel, message.ts)
      .catch((error) => {
        deps.logger.warn('Failed to remove acknowledgement reaction: %s', String(error));
      });
  }

  const executor = resolveExecutor(ctx.existingSession, deps);
  const sink = createActivitySink({
    analyticsStore: deps.analyticsStore,
    channel: message.channel,
    client,
    logger: deps.logger,
    renderer: deps.renderer,
    sessionStore: deps.sessionStore,
    threadTs,
    userId: message.user,
    userInputBridge: deps.userInputBridge,
    ...(workspace ? { workspaceLabel: workspace.workspaceLabel } : {}),
  });

  const controller = new AbortController();
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  let executionReleasedFromRegistry = false;
  let resolveExecutionDone: () => void;
  const executionDone = new Promise<void>((resolve) => {
    resolveExecutionDone = resolve;
  });
  const releaseExecutionFromRegistry = () => {
    if (executionReleasedFromRegistry) {
      return;
    }
    executionReleasedFromRegistry = true;
    unregisterExecution();
  };

  const unregisterExecution = deps.threadExecutionRegistry.register({
    channelId: message.channel,
    completionPromise: executionDone,
    executionId,
    providerId: executor.providerId,
    startedAt,
    stop: async (reason?: ThreadExecutionStopReason) => {
      runtimeInfo(
        deps.logger,
        'Abort requested for execution %s in thread %s (reason=%s)',
        executionId,
        threadTs,
        reason ?? 'user_stop',
      );
      releaseExecutionFromRegistry();
      controller.abort(reason ?? 'user_stop');
    },
    threadTs,
    userId: message.user,
  });

  deps.threadExecutionRegistry.trackMessage(message.ts, threadTs);

  try {
    runtimeInfo(
      deps.logger,
      'Starting agent execution %s for thread %s (provider=%s resume=%s workspace=%s)',
      executionId,
      threadTs,
      executor.providerId,
      resumeHandle ?? 'none',
      workspace?.workspaceLabel ?? '(none)',
    );
    await executor.execute(
      {
        abortSignal: controller.signal,
        channelId: message.channel,
        executionId,
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
    runtimeInfo(deps.logger, 'Agent execution %s completed for thread %s', executionId, threadTs);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    runtimeError(
      deps.logger,
      'Agent execution %s failed for thread %s: %s',
      executionId,
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
    runtimeInfo(
      deps.logger,
      'Finalizing agent execution %s for thread %s (terminalPhase=%s)',
      executionId,
      threadTs,
      sink.terminalPhase ?? 'unknown',
    );
    releaseExecutionFromRegistry();
    await sink.finalize();
    if (ctx.options.addAcknowledgementReaction && sink.terminalPhase === 'completed') {
      await deps.renderer
        .addCompletionReaction(client, message.channel, message.ts)
        .catch((error) => {
          deps.logger.warn('Failed to add completion reaction: %s', String(error));
        });
    }
    resolveExecutionDone!();
    runtimeInfo(
      deps.logger,
      'Execution %s finalize completed for thread %s',
      executionId,
      threadTs,
    );
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
  stopActiveExecutionsStep,
  resolveWorkspaceStep,
  resolveSessionStep,
  prepareThreadContext,
  executeAgent,
];
