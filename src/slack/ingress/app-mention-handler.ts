import type { AssistantThreadStartedMiddleware, AssistantUserMessageMiddleware } from '@slack/bolt';

import type { AgentProviderRegistry } from '~/agent/registry.js';
import type { AgentActivityState, AgentExecutionEvent, AgentExecutor } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import type { MemoryStore } from '~/memory/types.js';
import { SlackAppMentionEventSchema } from '~/schemas/slack/app-mention-event.js';
import { SlackMessageSchema } from '~/schemas/slack/message.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { ResolvedWorkspace, WorkspaceResolution } from '~/workspace/types.js';

import type { SlackThreadContextLoader } from '../context/thread-context-loader.js';
import { encodeWorkspacePickerButtonValue } from '../interactions/workspace-picker-payload.js';
import type { SlackRenderer } from '../render/slack-renderer.js';
import type { SlackBlock, SlackWebClientLike } from '../types.js';

export interface SlackIngressDependencies {
  claudeExecutor: AgentExecutor;
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry?: AgentProviderRegistry;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
  workspaceResolver: WorkspaceResolver;
}

export interface ThreadConversationMessage {
  channel: string;
  team: string;
  text: string;
  thread_ts?: string | undefined;
  ts: string;
  user: string;
}

interface ThreadConversationOptions {
  addAcknowledgementReaction: boolean;
  forceNewSession?: boolean;
  logLabel: string;
  rootMessageTs: string;
  workspaceOverride?: ResolvedWorkspace;
}

const DEFAULT_ASSISTANT_PROMPTS = [
  {
    title: 'Summarize a thread',
    message: 'Please summarize the latest discussion in this thread.',
  },
  {
    title: 'Review code changes',
    message: 'Please review the recent code changes and call out risks.',
  },
  {
    title: 'Draft a plan',
    message: 'Please create an implementation plan for this task.',
  },
] as const;

const SLACK_USER_MENTION_PATTERN = /<@([\dA-Z]+)>/g;

export function createAppMentionHandler(deps: SlackIngressDependencies) {
  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const mention = SlackAppMentionEventSchema.parse(args.event);
    await handleThreadConversation(args.client as SlackWebClientLike, mention, deps, {
      logLabel: 'app mention',
      addAcknowledgementReaction: true,
      rootMessageTs: mention.ts,
    });
  };
}

export function createThreadReplyHandler(deps: SlackIngressDependencies) {
  const getBotUserId = createBotUserIdResolver(deps.logger);

  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const parsed = SlackMessageSchema.safeParse(args.event);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    const threadTs = message.thread_ts;
    const client = args.client as SlackWebClientLike;

    if (!threadTs) {
      return;
    }

    const session = deps.sessionStore.get(threadTs);
    if (!session) {
      return;
    }

    const channelId = typeof message.channel === 'string' ? message.channel : undefined;
    const teamId = typeof message.team === 'string' ? message.team : undefined;
    if (!channelId || !teamId) {
      runtimeError(
        deps.logger,
        'Skipping thread reply without channel/team id for thread %s',
        threadTs,
      );
      return;
    }

    const botUserId = await getBotUserId(client);
    const senderId = message.user?.trim() || message.bot_id?.trim();
    if (!senderId) {
      return;
    }

    if (shouldSkipBotAuthoredMessage(deps.logger, 'thread reply', threadTs, message, botUserId)) {
      return;
    }

    if (
      shouldSkipMessageForForeignMention(
        deps.logger,
        'thread reply',
        threadTs,
        message.text,
        botUserId,
      )
    ) {
      return;
    }

    await handleThreadConversation(
      client,
      {
        channel: channelId,
        team: teamId,
        text: message.text,
        thread_ts: threadTs,
        ts: message.ts,
        user: senderId,
      },
      deps,
      {
        logLabel: 'thread reply',
        addAcknowledgementReaction: false,
        rootMessageTs: session.rootMessageTs,
      },
    );
  };
}

export function createAssistantThreadStartedHandler(
  deps: SlackIngressDependencies,
): AssistantThreadStartedMiddleware {
  return async ({ logger, setSuggestedPrompts }) => {
    try {
      await setSuggestedPrompts({
        title: 'Try asking me to...',
        prompts: [...DEFAULT_ASSISTANT_PROMPTS],
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      runtimeError(
        deps.logger,
        'Failed to configure assistant thread prompts: %s',
        redact(errorMessage),
      );
      logger.error('Failed to configure assistant thread prompts: %s', errorMessage);
    }
  };
}

export function createAssistantUserMessageHandler(
  deps: SlackIngressDependencies,
): AssistantUserMessageMiddleware {
  const getBotUserId = createBotUserIdResolver(deps.logger);

  return async (args) => {
    const parsed = SlackMessageSchema.safeParse(args.message);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    const threadTs = message.thread_ts;
    const channelId = typeof message.channel === 'string' ? message.channel : undefined;
    const teamId =
      typeof args.context.teamId === 'string'
        ? args.context.teamId
        : typeof args.body.team_id === 'string'
          ? args.body.team_id
          : undefined;
    const userId =
      typeof args.context.userId === 'string'
        ? args.context.userId
        : typeof message.user === 'string'
          ? message.user
          : undefined;

    if (!threadTs || !channelId || !teamId || !userId || !message.text.trim()) {
      runtimeError(
        deps.logger,
        'Skipping assistant message without required identifiers (channel=%s thread=%s team=%s user=%s)',
        channelId ?? 'missing',
        threadTs ?? 'missing',
        teamId ?? 'missing',
        userId ?? 'missing',
      );
      return;
    }

    const client = args.client as unknown as SlackWebClientLike;
    const botUserId = await getBotUserId(client);
    if (
      shouldSkipMessageForForeignMention(
        deps.logger,
        'assistant user message',
        threadTs,
        message.text,
        botUserId,
      )
    ) {
      return;
    }

    const existingSession = deps.sessionStore.get(threadTs);
    if (!existingSession) {
      await args.setTitle(message.text).catch((error: unknown) => {
        deps.logger.warn('Failed to set assistant thread title: %s', String(error));
      });
    }

    await handleThreadConversation(
      client,
      {
        channel: channelId,
        team: teamId,
        text: message.text,
        thread_ts: threadTs,
        ts: message.ts,
        user: userId,
      },
      deps,
      {
        logLabel: 'assistant user message',
        addAcknowledgementReaction: false,
        rootMessageTs: threadTs,
      },
    );
  };
}

export async function handleThreadConversation(
  client: SlackWebClientLike,
  message: ThreadConversationMessage,
  deps: SlackIngressDependencies,
  options: ThreadConversationOptions,
): Promise<void> {
  const threadTs = message.thread_ts ?? message.ts;

  runtimeInfo(
    deps.logger,
    'Received %s in channel %s, root ts %s, thread ts %s',
    options.logLabel,
    message.channel,
    message.ts,
    threadTs,
  );

  const existingSession = deps.sessionStore.get(threadTs);

  if (options.addAcknowledgementReaction) {
    await deps.renderer.addAcknowledgementReaction(client, message.channel, message.ts);
  }

  const workspaceResolution = resolveWorkspaceForConversation(
    message.text,
    existingSession,
    deps.workspaceResolver,
    options.workspaceOverride,
  );

  if (workspaceResolution.status === 'ambiguous') {
    runtimeWarn(
      deps.logger,
      'Ambiguous workspace for thread %s (%s)',
      threadTs,
      workspaceResolution.reason,
    );
    const { blocks, text } = buildWorkspaceResolutionBlocks(workspaceResolution, message.text);
    await client.chat.postMessage({
      blocks,
      channel: message.channel,
      text,
      thread_ts: threadTs,
    });
    return;
  }

  const workspace =
    workspaceResolution.status === 'unique' ? workspaceResolution.workspace : undefined;

  if (workspaceResolution.status === 'missing') {
    runtimeInfo(
      deps.logger,
      'No workspace detected for thread %s — proceeding without workspace (%s)',
      threadTs,
      workspaceResolution.reason,
    );
  }

  const shouldResetSession =
    options.forceNewSession === true ||
    Boolean(
      workspace &&
      existingSession?.claudeSessionId &&
      existingSession.workspacePath !== workspace.workspacePath,
    );
  const resumeHandle = shouldResetSession ? undefined : existingSession?.claudeSessionId;

  if (existingSession) {
    deps.sessionStore.patch(threadTs, {
      channelId: message.channel,
      rootMessageTs: options.rootMessageTs,
      ...(workspace
        ? {
            workspaceLabel: workspace.workspaceLabel,
            workspacePath: workspace.workspacePath,
            workspaceRepoId: workspace.repo.id,
            workspaceRepoPath: workspace.repo.repoPath,
            workspaceSource: workspace.source,
          }
        : {}),
      ...(shouldResetSession ? { claudeSessionId: undefined } : {}),
    });
  } else {
    deps.sessionStore.upsert({
      channelId: message.channel,
      threadTs,
      rootMessageTs: options.rootMessageTs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(workspace
        ? {
            workspaceLabel: workspace.workspaceLabel,
            workspacePath: workspace.workspacePath,
            workspaceRepoId: workspace.repo.id,
            workspaceRepoPath: workspace.repo.repoPath,
            workspaceSource: workspace.source,
          }
        : {}),
    });
  }

  let activeActivityState: AgentActivityState | undefined = createDefaultThinkingState(threadTs);
  let progressMessageTs: string | undefined;
  let progressMessageActive = false;
  const toolHistory = new Map<string, number>();
  const seenActivities = new Set<string>();

  await deps.renderer.showThinkingIndicator(client, message.channel, threadTs).catch((error) => {
    deps.logger.warn('Failed to show Slack thinking indicator: %s', String(error));
  });

  runtimeInfo(deps.logger, 'Loading thread context for %s', threadTs);
  const threadContext = await deps.threadContextLoader.loadThread(
    client,
    message.channel,
    threadTs,
  );
  runtimeInfo(
    deps.logger,
    'Thread context loaded for %s (%d messages)',
    threadTs,
    threadContext.messages.length,
  );

  const contextMemories = deps.memoryStore.listForContext(workspace?.repo.id);

  let lastStateKey: string | undefined;
  const defaultThinkingState = createDefaultThinkingState(threadTs);
  const defaultThinkingStateKey = JSON.stringify(defaultThinkingState);
  const isMeaningfulActivityState = (state: AgentActivityState): boolean => {
    if (state.clear) {
      return false;
    }

    if (JSON.stringify(state) === defaultThinkingStateKey) {
      return false;
    }

    const normalizedStatus = state.status?.trim();
    if (normalizedStatus && normalizedStatus !== defaultThinkingState.status) {
      return true;
    }

    const meaningfulActivity = state.activities?.some((activity) => {
      const normalizedActivity = activity.trim();
      return (
        normalizedActivity.length > 0 &&
        normalizedActivity !== normalizedStatus &&
        !(defaultThinkingState.activities ?? []).includes(normalizedActivity)
      );
    });

    return meaningfulActivity === true;
  };

  const toRendererState = (state: AgentActivityState) => ({
    threadTs: state.threadTs,
    ...(state.status != null ? { status: state.status } : {}),
    ...(state.activities != null ? { loadingMessages: state.activities } : {}),
    ...(state.composing != null ? { composing: state.composing } : {}),
    ...(toolHistory.size > 0 ? { toolHistory } : {}),
    clear: state.clear ?? false,
  });

  const updateInFlightIndicator = async (state: AgentActivityState): Promise<void> => {
    if (progressMessageActive) {
      progressMessageTs = await deps.renderer.upsertThreadProgressMessage(
        client,
        message.channel,
        threadTs,
        toRendererState(state),
        progressMessageTs,
      );
      return;
    }

    await deps.renderer.setUiState(client, message.channel, toRendererState(state));
  };
  const activateProgressMessage = async (state: AgentActivityState): Promise<void> => {
    if (!progressMessageActive) {
      progressMessageActive = true;
      await deps.renderer.clearUiState(client, message.channel, threadTs).catch((error) => {
        deps.logger.warn('Failed to clear fallback Slack thinking indicator: %s', String(error));
      });
    }

    progressMessageTs = await deps.renderer.upsertThreadProgressMessage(
      client,
      message.channel,
      threadTs,
      toRendererState(state),
      progressMessageTs,
    );
  };
  const sink = {
    onEvent: async (event: AgentExecutionEvent): Promise<void> => {
      if (event.type === 'assistant-message') {
        await deps.renderer.postThreadReply(client, message.channel, threadTs, event.text, {
          ...(workspace ? { workspaceLabel: workspace.workspaceLabel } : {}),
          ...(toolHistory.size > 0 ? { toolHistory } : {}),
        });
        if (progressMessageActive && progressMessageTs) {
          await deps.renderer
            .deleteThreadProgressMessage(client, message.channel, threadTs, progressMessageTs)
            .catch((error) => {
              deps.logger.warn(
                'Failed to delete thread progress message after assistant reply: %s',
                String(error),
              );
            });
          progressMessageTs = undefined;
          progressMessageActive = false;
        }
        activeActivityState = undefined;
        lastStateKey = undefined;
        toolHistory.clear();
        seenActivities.clear();
        await deps.renderer.clearUiState(client, message.channel, threadTs).catch((error) => {
          deps.logger.warn('Failed to clear UI state after assistant reply: %s', String(error));
        });
        return;
      }

      if (event.type === 'activity-state') {
        const nextStateKey = JSON.stringify(event.state);
        if (nextStateKey === lastStateKey) {
          return;
        }
        lastStateKey = nextStateKey;
        activeActivityState = event.state.clear ? undefined : event.state;

        if (!event.state.clear) {
          collectToolActivity(event.state, toolHistory, seenActivities);
        }

        if (event.state.composing && !event.state.clear) {
          if (progressMessageActive && progressMessageTs) {
            await deps.renderer
              .upsertThreadProgressMessage(
                client,
                message.channel,
                threadTs,
                {
                  threadTs,
                  status: 'Composing response...',
                  loadingMessages: ['Composing response...'],
                  ...(toolHistory.size > 0 ? { toolHistory } : {}),
                  clear: false,
                },
                progressMessageTs,
              )
              .catch((error) => {
                deps.logger.warn(
                  'Failed to update progress message on composing: %s',
                  String(error),
                );
              });
          } else {
            await deps.renderer
              .setUiState(client, message.channel, {
                threadTs,
                status: 'Composing response...',
                clear: false,
              })
              .catch((error) => {
                deps.logger.warn('Failed to set composing status: %s', String(error));
              });
          }
          return;
        }

        if (event.state.clear) {
          if (progressMessageActive && progressMessageTs) {
            await deps.renderer.deleteThreadProgressMessage(
              client,
              message.channel,
              threadTs,
              progressMessageTs,
            );
            progressMessageTs = undefined;
            progressMessageActive = false;
            return;
          }

          await deps.renderer.clearUiState(client, message.channel, threadTs);
          return;
        }

        if (!progressMessageActive && isMeaningfulActivityState(event.state)) {
          await activateProgressMessage(event.state);
          return;
        }

        await updateInFlightIndicator(event.state);
        return;
      }

      if (event.type === 'task-update') {
        return;
      }

      if (event.resumeHandle) {
        deps.sessionStore.patch(threadTs, { claudeSessionId: event.resumeHandle });
      }

      if (event.phase === 'started') {
        return;
      }

      if (event.phase === 'completed') {
        return;
      }

      if (event.phase === 'failed') {
        runtimeError(
          deps.logger,
          'Execution failed for thread %s: %s',
          threadTs,
          redact(String(event.error ?? '')),
        );
        activeActivityState = undefined;
        await deps.renderer.postThreadReply(
          client,
          message.channel,
          threadTs,
          'An error occurred while processing your request.',
        );
      }
    },
  };

  try {
    const executor = resolveExecutor(existingSession, deps);
    runtimeInfo(
      deps.logger,
      'Starting agent execution for thread %s (provider=%s)',
      threadTs,
      executor.providerId,
    );
    await executor.execute(
      {
        channelId: message.channel,
        threadTs,
        userId: message.user,
        mentionText: message.text,
        threadContext,
        contextMemories,
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
    activeActivityState = undefined;
    await deps.renderer.postThreadReply(
      client,
      message.channel,
      threadTs,
      'An error occurred while processing your request.',
    );
  } finally {
    await deps.renderer.clearUiState(client, message.channel, threadTs).catch((err) => {
      deps.logger.warn('Failed to clear UI state: %s', String(err));
    });
    if (progressMessageTs) {
      await deps.renderer
        .finalizeThreadProgressMessage(
          client,
          message.channel,
          threadTs,
          progressMessageTs,
          toolHistory,
        )
        .catch((err) => {
          deps.logger.warn('Failed to finalize progress message: %s', String(err));
        });
    }
  }
}

const TOOL_VERB_PATTERN =
  /^(Reading|Searching|Finding|Fetching|Calling|Running|Exploring|Recalling|Saving|Checking|Applying|Editing|Generating|Waiting|Using) (.+?)(?:\.{3})?$/;

function collectToolActivity(
  state: AgentActivityState,
  history: Map<string, number>,
  seenActivities: Set<string>,
): void {
  const candidates = [...(state.activities ?? [])];
  if (state.status?.trim()) {
    candidates.push(state.status);
  }

  for (const msg of candidates) {
    const trimmed = msg.trim();
    if (!trimmed || seenActivities.has(trimmed)) continue;
    const match = trimmed.match(TOOL_VERB_PATTERN);
    if (!match) continue;
    seenActivities.add(trimmed);
    const verb = match[1]!;
    const label = verb === 'Using' ? (match[2]!.split(/\s/)[0] ?? verb) : verb;
    history.set(label, (history.get(label) ?? 0) + 1);
  }
}

function runtimeInfo(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.info(message, ...args);
  console.info(message, ...args);
}

function runtimeError(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.error(message, ...args);
  console.error(message, ...args);
}

function runtimeWarn(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.warn(message, ...args);
  console.warn(message, ...args);
}

function createDefaultThinkingState(threadTs: string): AgentActivityState {
  return {
    threadTs,
    status: 'Thinking...',
    activities: [
      'Reading the thread context...',
      'Planning the next steps...',
      'Generating a response...',
    ],
    clear: false,
  };
}

function createBotUserIdResolver(
  logger: AppLogger,
): (client: SlackWebClientLike) => Promise<string | undefined> {
  let cachedBotUserId: Promise<string | undefined> | undefined;

  return async (client: SlackWebClientLike): Promise<string | undefined> => {
    if (!cachedBotUserId) {
      cachedBotUserId = resolveBotUserId(client, logger);
    }

    return cachedBotUserId;
  };
}

async function resolveBotUserId(
  client: SlackWebClientLike,
  logger: AppLogger,
): Promise<string | undefined> {
  if (!client.auth?.test) {
    runtimeWarn(logger, 'Slack client does not expose auth.test; mention filtering disabled');
    return undefined;
  }

  try {
    const identity = await client.auth.test();
    const botUserId = identity.user_id?.trim();
    if (!botUserId) {
      runtimeWarn(
        logger,
        'Slack auth.test did not return a bot user id; mention filtering disabled',
      );
      return undefined;
    }

    return botUserId;
  } catch (error) {
    runtimeWarn(logger, 'Failed to resolve bot user id for mention filtering: %s', String(error));
    return undefined;
  }
}

function shouldSkipBotAuthoredMessage(
  logger: AppLogger,
  logLabel: string,
  threadTs: string,
  message: {
    bot_id?: string | undefined;
    subtype?: string | undefined;
    text: string;
    user?: string | undefined;
  },
  botUserId: string | undefined,
): boolean {
  if (message.subtype && message.subtype !== 'bot_message') {
    return true;
  }

  const botAuthored =
    Boolean(message.bot_id) || message.subtype === 'bot_message' || message.user === botUserId;
  if (!botAuthored) {
    return false;
  }

  if (mentionsUser(message.text, botUserId)) {
    return false;
  }

  runtimeInfo(
    logger,
    'Skipping %s for thread %s because bot-authored message does not mention this app',
    logLabel,
    threadTs,
  );
  return true;
}

function shouldSkipMessageForForeignMention(
  logger: AppLogger,
  logLabel: string,
  threadTs: string,
  messageText: string,
  botUserId: string | undefined,
): boolean {
  if (!messageText.includes('<@') || !botUserId) {
    return false;
  }

  const foreignMentionedUserId = getForeignMentionedUserId(messageText, botUserId);
  if (!foreignMentionedUserId) {
    return false;
  }

  runtimeInfo(
    logger,
    'Skipping %s for thread %s because mention targets another user: %s',
    logLabel,
    threadTs,
    foreignMentionedUserId,
  );
  return true;
}

function getForeignMentionedUserId(messageText: string, botUserId: string): string | undefined {
  for (const match of messageText.matchAll(SLACK_USER_MENTION_PATTERN)) {
    const mentionedUserId = match[1]?.trim();
    if (mentionedUserId && mentionedUserId !== botUserId) {
      return mentionedUserId;
    }
  }

  return undefined;
}

function mentionsUser(messageText: string, userId: string | undefined): boolean {
  if (!userId) {
    return false;
  }

  return messageText.includes(`<@${userId}>`);
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

function resolveWorkspaceForConversation(
  messageText: string,
  existingSession: SessionRecord | undefined,
  workspaceResolver: WorkspaceResolver,
  workspaceOverride?: ResolvedWorkspace,
): WorkspaceResolution {
  if (workspaceOverride) {
    return {
      status: 'unique',
      workspace: workspaceOverride,
    };
  }

  if (
    existingSession?.workspacePath &&
    existingSession.workspaceRepoId &&
    existingSession.workspaceRepoPath &&
    existingSession.workspaceLabel
  ) {
    return {
      status: 'unique',
      workspace: {
        input: existingSession.workspacePath,
        matchKind:
          existingSession.workspacePath === existingSession.workspaceRepoPath ? 'repo' : 'path',
        repo: {
          aliases: [],
          id: existingSession.workspaceRepoId,
          label: existingSession.workspaceRepoId,
          name:
            existingSession.workspaceRepoId.split('/').at(-1) ?? existingSession.workspaceRepoId,
          repoPath: existingSession.workspaceRepoPath,
          relativePath: existingSession.workspaceRepoId,
        },
        source: existingSession.workspaceSource ?? 'manual',
        workspaceLabel: existingSession.workspaceLabel,
        workspacePath: existingSession.workspacePath,
      },
    };
  }

  return workspaceResolver.resolveFromText(messageText, 'auto');
}

export const WORKSPACE_PICKER_ACTION_ID = 'workspace_picker_open_modal';

function buildWorkspaceResolutionBlocks(
  resolution: Extract<WorkspaceResolution, { status: 'ambiguous' }>,
  originalMessageText: string,
): { blocks: SlackBlock[]; text: string } {
  const labels = resolution.candidates
    .slice(0, 5)
    .map((candidate) => `\`${candidate.label}\``)
    .join(', ');
  const text = `I couldn't tell which repository to use — matched: ${labels}`;

  return {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        block_id: 'workspace_picker',
        elements: [
          {
            action_id: WORKSPACE_PICKER_ACTION_ID,
            style: 'primary',
            text: { type: 'plain_text' as const, text: 'Choose Workspace' },
            type: 'button' as const,
            value: encodeWorkspacePickerButtonValue(originalMessageText),
          },
        ],
      },
    ],
    text,
  };
}
