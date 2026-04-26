import type { AssistantThreadStartedMiddleware, AssistantUserMessageMiddleware } from '@slack/bolt';

import { redact } from '~/logger/redact.js';
import { runtimeError, runtimeInfo, runtimeWarn } from '~/logger/runtime.js';
import { zodParse } from '~/schemas/safe-parse.js';
import { SlackAppMentionEventSchema } from '~/schemas/slack/app-mention-event.js';
import { SlackMessageSchema } from '~/schemas/slack/message.js';
import type { SessionRecord } from '~/session/types.js';

import type { SlackWebClientLike } from '../types.js';
import type { A2AAssignmentRecord } from './a2a-coordinator-store.js';
import type { A2AThreadContext } from './a2a-routing.js';
import {
  buildA2AThreadContext,
  getA2AContextFromSession,
  getMentionedA2AParticipants,
  identityMatchesA2AParticipant,
  resolveA2AThreadReplyDecision,
  serializeA2AParticipants,
} from './a2a-routing.js';
import { resolveMentionCoordinationDecision } from './agent-team-routing.js';
import { handleThreadConversation } from './conversation-pipeline.js';
import {
  createBotIdentityResolver,
  shouldSkipBotAuthoredMessage,
  shouldSkipBotAuthoredMessageFromUnjoinedSender,
  shouldSkipMessageForForeignMention,
} from './message-filter.js';
import type { SlackIngressDependencies } from './types.js';

export { handleThreadConversation } from './conversation-pipeline.js';
export type { SlackIngressDependencies, ThreadConversationMessage } from './types.js';
export { WORKSPACE_PICKER_ACTION_ID } from './workspace-resolution.js';

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

export function startA2ASummaryPoller(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  intervalMs = 5_000,
): (() => void) | undefined {
  if (!deps.a2aCoordinatorStore) {
    return undefined;
  }

  const getBotIdentity = createBotIdentityResolver(deps.logger);
  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const botIdentity = await getBotIdentity(client);
      if (!botIdentity?.userId) {
        return;
      }
      await runReadyA2ASummary(client, deps, {
        currentBotUserId: botIdentity.userId,
        currentBotUserName: botIdentity.userName,
      });
    } catch (error) {
      deps.logger.warn('Failed to poll ready A2A summaries: %s', String(error));
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();

  return () => {
    clearInterval(timer);
  };
}

export function createAppMentionHandler(deps: SlackIngressDependencies) {
  const getBotIdentity = createBotIdentityResolver(deps.logger);

  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const mention = zodParse(SlackAppMentionEventSchema, args.event, 'SlackAppMentionEvent');
    const client = args.client as SlackWebClientLike;
    const threadTs = mention.thread_ts ?? mention.ts;
    const botIdentity = await getBotIdentity(client);
    const botUserId = botIdentity?.userId;
    const rawMention = mention as {
      bot_id?: string | undefined;
      subtype?: string | undefined;
    };
    const botAuthored = Boolean(rawMention.bot_id) || rawMention.subtype === 'bot_message';

    if (
      shouldSkipBotAuthoredMessage(
        deps.logger,
        'app mention',
        threadTs,
        {
          bot_id: rawMention.bot_id,
          subtype: rawMention.subtype,
          text: mention.text,
          user: mention.user,
        },
        botUserId,
      )
    ) {
      return;
    }

    const existingSession = deps.sessionStore.get(threadTs);
    if (
      botAuthored &&
      existingSession &&
      (await shouldSkipBotAuthoredMessageFromUnjoinedSender(
        deps.logger,
        'app mention',
        client,
        mention.channel,
        threadTs,
        mention.user,
        deps.agentTeams,
      ))
    ) {
      return;
    }

    const coordinationDecision = resolveMentionCoordinationDecision(
      mention.text,
      {
        userId: botUserId,
        userName: botIdentity?.userName,
      },
      deps.agentTeams,
    );
    const a2aContext = buildA2AThreadContext(mention.text, coordinationDecision, deps.agentTeams);
    if (coordinationDecision.action === 'standby') {
      if (a2aContext) {
        persistA2ASession(deps, {
          channelId: mention.channel,
          rootMessageTs: threadTs,
          threadTs,
          context: a2aContext,
        });
      }
      runtimeInfo(
        deps.logger,
        'Skipping app mention for thread %s because current bot is standby for lead %s',
        threadTs,
        coordinationDecision.lead,
      );
      return;
    }

    const a2aAssignment = maybeCreateA2AAssignment({
      botAuthored,
      botUserId,
      deps,
      messageText: mention.text,
      senderUserId: mention.user,
      session: existingSession,
      threadTs,
      triggerTs: mention.ts,
      channelId: mention.channel,
    });

    await handleThreadConversation(
      client,
      {
        channel: mention.channel,
        files: mention.files,
        team: mention.team,
        text: mention.text,
        thread_ts: mention.thread_ts,
        ts: mention.ts,
        user: mention.user,
      },
      deps,
      {
        logLabel: 'app mention',
        addAcknowledgementReaction: true,
        ...(a2aAssignment ? { a2aAssignmentId: a2aAssignment.assignmentId } : {}),
        ...(a2aContext ? { a2aContext } : {}),
        ...(a2aContext && deps.providerRegistry
          ? { agentProviderOverride: deps.providerRegistry.defaultProviderId }
          : {}),
        currentBotUserName: botIdentity?.userName,
        currentBotUserId: botUserId,
        rootMessageTs: mention.ts,
      },
    );
  };
}

export function createThreadReplyHandler(deps: SlackIngressDependencies) {
  const getBotIdentity = createBotIdentityResolver(deps.logger);

  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const parsed = SlackMessageSchema.safeParse(args.event);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    const threadTs = message.thread_ts;
    const client = args.client as SlackWebClientLike;

    if (message.user && !message.bot_id && !message.subtype) {
      const handledUserInput = await maybeHandlePendingUserInputReply(
        client,
        {
          channelId: typeof message.channel === 'string' ? message.channel : undefined,
          text: message.text,
          threadTs: threadTs ?? message.ts,
          userId: message.user,
        },
        deps,
      );
      if (handledUserInput) {
        return;
      }
    }

    const botIdentity = await getBotIdentity(client);
    const botUserId = botIdentity?.userId;
    const mentionsCurrentBot = mentionsUser(message.text, botUserId);
    const coordinationDecision = resolveMentionCoordinationDecision(
      message.text,
      {
        userId: botUserId,
        userName: botIdentity?.userName,
      },
      deps.agentTeams,
    );
    const rootA2AContext = buildA2AThreadContext(
      message.text,
      coordinationDecision,
      deps.agentTeams,
    );
    if (coordinationDecision.action === 'standby') {
      if (!threadTs && rootA2AContext) {
        const channelId = typeof message.channel === 'string' ? message.channel : undefined;
        if (channelId) {
          persistA2ASession(deps, {
            channelId,
            rootMessageTs: message.ts,
            threadTs: message.ts,
            context: rootA2AContext,
          });
        }
      }
      runtimeInfo(
        deps.logger,
        'Skipping thread reply for thread %s because current bot is standby for lead %s',
        threadTs ?? message.ts,
        coordinationDecision.lead,
      );
      return;
    }

    if (!threadTs) {
      if (coordinationDecision.action !== 'run') {
        runtimeInfo(
          deps.logger,
          'Ignoring message event %s because it is not a thread reply',
          message.ts,
        );
        return;
      }

      const channelId = typeof message.channel === 'string' ? message.channel : undefined;
      const senderId = message.user?.trim() || message.bot_id?.trim();
      if (!channelId || !senderId) {
        runtimeWarn(
          deps.logger,
          'Ignoring root team mention %s because channel or sender id is missing',
          message.ts,
        );
        return;
      }

      if (
        shouldSkipBotAuthoredMessage(deps.logger, 'root message', message.ts, message, botUserId)
      ) {
        return;
      }

      await handleThreadConversation(
        client,
        {
          channel: channelId,
          files: message.files,
          team: typeof message.team === 'string' ? message.team : undefined,
          text: message.text,
          ts: message.ts,
          user: senderId,
        },
        deps,
        {
          logLabel: 'root team mention',
          addAcknowledgementReaction: false,
          ...(rootA2AContext ? { a2aContext: rootA2AContext } : {}),
          ...(rootA2AContext && deps.providerRegistry
            ? { agentProviderOverride: deps.providerRegistry.defaultProviderId }
            : {}),
          currentBotUserName: botIdentity?.userName,
          currentBotUserId: botUserId,
          rootMessageTs: message.ts,
        },
      );
      return;
    }

    const session = deps.sessionStore.get(threadTs);
    const a2aContext = session ? getA2AContextFromSession(session) : undefined;
    if (!session && !mentionsCurrentBot && coordinationDecision.action !== 'run') {
      runtimeWarn(
        deps.logger,
        'Ignoring thread reply %s in thread %s because no persisted session was found',
        message.ts,
        threadTs,
      );
      return;
    }

    const channelId =
      typeof message.channel === 'string' && message.channel.trim()
        ? message.channel
        : session?.channelId;
    const teamId = typeof message.team === 'string' ? message.team : undefined;
    if (!channelId) {
      runtimeError(deps.logger, 'Skipping thread reply without channel id for thread %s', threadTs);
      return;
    }
    if (typeof message.channel !== 'string' || !message.channel.trim()) {
      runtimeWarn(
        deps.logger,
        'Thread reply missing channel id for thread %s; falling back to session channel %s',
        threadTs,
        session?.channelId,
      );
    }
    if (!teamId) {
      runtimeWarn(
        deps.logger,
        'Thread reply missing team id for thread %s; continuing without it',
        threadTs,
      );
    }

    const senderId = message.user?.trim() || message.bot_id?.trim();
    if (!senderId) {
      runtimeWarn(
        deps.logger,
        'Ignoring thread reply %s in thread %s because sender id is missing',
        message.ts,
        threadTs,
      );
      return;
    }

    const botAuthored = Boolean(message.bot_id) || message.subtype === 'bot_message';
    if (a2aContext) {
      const rootAuthoredBotReply =
        botAuthored && message.user !== botUserId
          ? await isA2AThreadRootAuthoredBotReply(client, channelId, threadTs, message.user)
          : false;
      const effectiveBotAuthored = botAuthored && !rootAuthoredBotReply;
      const mentionedA2AParticipants = getMentionedA2AParticipants(message.text, a2aContext);
      const a2aDecision = resolveA2AThreadReplyDecision(
        message.text,
        {
          userId: botUserId,
          userName: botIdentity?.userName,
        },
        a2aContext,
      );
      const a2aAssignment = maybeCreateA2AAssignment({
        botAuthored: effectiveBotAuthored,
        botUserId,
        deps,
        messageText: message.text,
        senderUserId: typeof message.user === 'string' ? message.user : undefined,
        session,
        threadTs,
        triggerTs: message.ts,
        channelId,
      });

      if (effectiveBotAuthored) {
        scheduleReadyA2ASummaryCheck(client, deps, session, {
          currentBotUserId: botUserId,
          currentBotUserName: botIdentity?.userName,
        });
      }

      if (effectiveBotAuthored && !a2aAssignment && shouldSkipA2ABotAuthoredMessage(deps, threadTs, message, botUserId)) {
          return;
        }

      if (
        !effectiveBotAuthored &&
        mentionedA2AParticipants.length > 1 &&
        !identityMatchesA2AParticipant(
          { userId: botUserId, userName: botIdentity?.userName },
          a2aContext.lead,
        )
      ) {
        runtimeInfo(
          deps.logger,
          'Skipping A2A thread reply for thread %s because multiple agents were mentioned; lead %s will coordinate',
          threadTs,
          a2aContext.lead,
        );
        return;
      }

      if (a2aDecision.action === 'standby' && !a2aAssignment) {
        runtimeInfo(
          deps.logger,
          'Skipping A2A thread reply for thread %s because current bot is standby for lead %s (%s)',
          threadTs,
          a2aDecision.lead,
          a2aDecision.reason,
        );
        return;
      }

      await handleThreadConversation(
        client,
        {
          channel: channelId,
          files: message.files,
          team: teamId,
          text: message.text,
          thread_ts: threadTs,
          ts: message.ts,
          user: senderId,
        },
        deps,
        {
          logLabel: a2aAssignment ? 'A2A assignment' : 'A2A thread reply',
          addAcknowledgementReaction: false,
          ...(a2aAssignment ? { a2aAssignmentId: a2aAssignment.assignmentId } : {}),
          a2aContext,
          currentBotUserName: botIdentity?.userName,
          currentBotUserId: botUserId,
          rootMessageTs: session?.rootMessageTs ?? threadTs,
        },
      );
      return;
    }

    if (shouldSkipBotAuthoredMessage(deps.logger, 'thread reply', threadTs, message, botUserId)) {
      return;
    }

    if (
      botAuthored &&
      (await shouldSkipBotAuthoredMessageFromUnjoinedSender(
        deps.logger,
        'thread reply',
        client,
        channelId,
        threadTs,
        typeof message.user === 'string' ? message.user : undefined,
        deps.agentTeams,
      ))
    ) {
      return;
    }

    if (
      coordinationDecision.action !== 'run' &&
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
        files: message.files,
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
        currentBotUserName: botIdentity?.userName,
        currentBotUserId: botUserId,
        rootMessageTs: session?.rootMessageTs ?? threadTs,
      },
    );
  };
}

function mentionsUser(messageText: string, userId: string | undefined): boolean {
  return Boolean(userId && messageText.includes(`<@${userId}>`));
}

function shouldSkipA2ABotAuthoredMessage(
  deps: SlackIngressDependencies,
  threadTs: string,
  message: {
    bot_id?: string | undefined;
    subtype?: string | undefined;
    text: string;
    user?: string | undefined;
  },
  botUserId: string | undefined,
): boolean {
  if (message.subtype && message.subtype !== 'bot_message' && message.subtype !== 'file_share') {
    return true;
  }

  if (botUserId && message.user === botUserId) {
    runtimeInfo(
      deps.logger,
      'Skipping A2A thread reply for thread %s because message was authored by this app itself',
      threadTs,
    );
    return true;
  }

  runtimeInfo(
    deps.logger,
    'Skipping A2A thread reply for thread %s because bot-authored message is not a lead assignment or root-authored user simulation',
    threadTs,
  );
  return true;
}

async function isA2AThreadRootAuthoredBotReply(
  client: SlackWebClientLike,
  channelId: string,
  threadTs: string,
  senderUserId: string | undefined,
): Promise<boolean> {
  if (!senderUserId) {
    return false;
  }
  try {
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: 1,
    });
    const root = response.messages?.[0] as { ts?: unknown; user?: unknown } | undefined;
    return root?.ts === threadTs && root.user === senderUserId;
  } catch {
    return false;
  }
}

function persistA2ASession(
  deps: SlackIngressDependencies,
  input: {
    channelId: string;
    context: A2AThreadContext;
    rootMessageTs: string;
    threadTs: string;
  },
): void {
  const now = new Date().toISOString();
  const existing = deps.sessionStore.get(input.threadTs);
  const patch = {
    a2aLead: input.context.lead,
    a2aParticipantsJson: serializeA2AParticipants(input.context.participants),
    ...(input.context.teamId ? { a2aTeamId: input.context.teamId } : {}),
    conversationMode: 'a2a' as const,
    ...(deps.providerRegistry ? { agentProvider: deps.providerRegistry.defaultProviderId } : {}),
  };
  if (existing) {
    deps.sessionStore.patch(input.threadTs, patch);
    return;
  }
  deps.sessionStore.upsert({
    channelId: input.channelId,
    createdAt: now,
    rootMessageTs: input.rootMessageTs,
    threadTs: input.threadTs,
    updatedAt: now,
    ...patch,
  });
}

function maybeCreateA2AAssignment(input: {
  botAuthored: boolean;
  botUserId: string | undefined;
  channelId: string;
  deps: SlackIngressDependencies;
  messageText: string;
  senderUserId: string | undefined;
  session: SessionRecord | undefined;
  threadTs: string;
  triggerTs: string;
}): A2AAssignmentRecord | undefined {
  if (!input.botAuthored || !input.session || !input.deps.a2aCoordinatorStore) {
    return undefined;
  }
  const context = getA2AContextFromSession(input.session);
  if (!context || !identityMatchesA2AParticipant({ userId: input.senderUserId }, context.lead)) {
    return undefined;
  }
  const assignedAgentIds = getMentionedA2AParticipants(input.messageText, context).filter(
    (participant) => !identityMatchesA2AParticipant({ userId: participant }, context.lead),
  );
  if (
    assignedAgentIds.length === 0 ||
    !assignedAgentIds.some((participant) =>
      identityMatchesA2AParticipant({ userId: input.botUserId }, participant),
    )
  ) {
    return undefined;
  }

  return input.deps.a2aCoordinatorStore.createAssignment({
    agentIds: assignedAgentIds,
    channelId: input.channelId,
    leadId: context.lead,
    leadProviderId:
      input.session.agentProvider ??
      input.deps.providerRegistry?.defaultProviderId ??
      input.deps.claudeExecutor.providerId,
    threadTs: input.threadTs,
    triggerTs: input.triggerTs,
  });
}

function scheduleReadyA2ASummaryCheck(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  session: SessionRecord | undefined,
  identity: { currentBotUserId?: string | undefined; currentBotUserName?: string | undefined },
): void {
  if (!session || !identity.currentBotUserId || !deps.a2aCoordinatorStore) {
    return;
  }
  const context = getA2AContextFromSession(session);
  if (
    !context ||
    !identityMatchesA2AParticipant({ userId: identity.currentBotUserId }, context.lead)
  ) {
    return;
  }

  setTimeout(() => {
    void runReadyA2ASummary(client, deps, {
      ...identity,
      threadTs: session.threadTs,
    }).catch((error) => {
      deps.logger.warn(
        'Failed to run ready A2A summary for thread %s: %s',
        session.threadTs,
        String(error),
      );
    });
  }, 5_000);
}

async function runReadyA2ASummary(
  client: SlackWebClientLike,
  deps: SlackIngressDependencies,
  identity: {
    currentBotUserId?: string | undefined;
    currentBotUserName?: string | undefined;
    threadTs?: string | undefined;
  },
): Promise<void> {
  const store = deps.a2aCoordinatorStore;
  const currentBotUserId = identity.currentBotUserId;
  if (!store || !currentBotUserId) {
    return;
  }
  const ready = store.findReadySummaryForLead(currentBotUserId);
  if (!ready || (identity.threadTs && ready.threadTs !== identity.threadTs)) {
    return;
  }
  const session = deps.sessionStore.get(ready.threadTs);
  if (!session) {
    deps.logger.warn(
      'Skipping ready A2A summary %s because session %s is missing',
      ready.assignmentId,
      ready.threadTs,
    );
    return;
  }
  const running = store.markSummaryRunning(ready.assignmentId);
  if (!running) {
    return;
  }

  const terminalSummary = running.agentStates
    .map((state) => `<@${state.agentId}>: ${state.status}`)
    .join(', ');
  await handleThreadConversation(
    client,
    {
      channel: running.channelId,
      text: [
        `A2A_FINAL_SUMMARY ${running.assignmentId}`,
        `All assigned agents reached terminal states: ${terminalSummary}.`,
        'Read the Slack thread history and post one concise final summary for the user.',
        'Include completed work and call out failed or stopped assignments if any.',
      ].join('\n'),
      thread_ts: running.threadTs,
      ts: `${running.triggerTs}-summary-${Date.now()}`,
      user: currentBotUserId,
    },
    deps,
    {
      addAcknowledgementReaction: false,
      a2aSummaryAssignmentId: running.assignmentId,
      agentProviderOverride: running.leadProviderId,
      currentBotUserId,
      currentBotUserName: identity.currentBotUserName,
      logLabel: 'A2A final summary',
      rootMessageTs: session.rootMessageTs,
    },
  );
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
  const getBotIdentity = createBotIdentityResolver(deps.logger);

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

    const hasTextOrFiles = message.text.trim() || (message.files && message.files.length > 0);
    if (!threadTs || !channelId || !teamId || !userId || !hasTextOrFiles) {
      runtimeError(
        deps.logger,
        'Skipping assistant message without required identifiers (channel=%s thread=%s team=%s user=%s hasContent=%s)',
        channelId ?? 'missing',
        threadTs ?? 'missing',
        teamId ?? 'missing',
        userId ?? 'missing',
        String(hasTextOrFiles),
      );
      return;
    }

    const handledUserInput = await maybeHandlePendingUserInputReply(
      args.client as unknown as SlackWebClientLike,
      {
        channelId,
        text: message.text,
        threadTs,
        userId,
      },
      deps,
    );
    if (handledUserInput) {
      return;
    }

    const client = args.client as unknown as SlackWebClientLike;
    const botIdentity = await getBotIdentity(client);
    const botUserId = botIdentity?.userId;
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
        files: message.files,
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
        currentBotUserName: botIdentity?.userName,
        currentBotUserId: botUserId,
        rootMessageTs: threadTs,
      },
    );
  };
}

async function maybeHandlePendingUserInputReply(
  client: SlackWebClientLike,
  input: {
    channelId?: string | undefined;
    text: string;
    threadTs: string;
    userId: string;
  },
  deps: SlackIngressDependencies,
): Promise<boolean> {
  if (!deps.userInputBridge.hasPending(input.threadTs)) {
    return false;
  }

  const result = deps.userInputBridge.submitReply({
    text: input.text,
    threadTs: input.threadTs,
    userId: input.userId,
  });
  if (!result.handled) {
    return false;
  }

  if (result.feedback && input.channelId) {
    await deps.renderer.postThreadReply(client, input.channelId, input.threadTs, result.feedback);
  }

  return true;
}
