import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutor } from '~/agent/types.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import { createThreadExecutionRegistry } from '~/slack/execution/thread-execution-registry.js';
import type { A2ACoordinatorStore } from '~/slack/ingress/a2a-coordinator-store.js';
import { MemoryA2ACoordinatorStore } from '~/slack/ingress/a2a-coordinator-store.js';
import type { AgentTeamsConfig } from '~/slack/ingress/agent-team-routing.js';
import {
  createAppMentionHandler,
  createThreadReplyHandler,
} from '~/slack/ingress/app-mention-handler.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
import type { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';

describe('thread reply ingress', () => {
  it('ignores thread replies that mention another user instead of the bot', async () => {
    const threadTs = '1712345678.000100';
    const { claudeExecutor, client, handler, logger, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'please ask <@U456> to review this',
        thread_ts: threadTs,
        ts: '1712345678.000101',
        type: 'message',
        user: 'U123',
      },
    });

    expect(client.auth.test).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping %s for thread %s because mention targets another user: %s',
      'thread reply',
      threadTs,
      'U456',
    );
  });

  it('ignores bot-authored thread replies when they do not mention the bot', async () => {
    const threadTs = '1712345678.000101';
    const { claudeExecutor, client, handler, logger, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'status update from the bot itself',
        thread_ts: threadTs,
        ts: '1712345678.000102',
        type: 'message',
        user: 'U_BOT',
      },
    });

    expect(client.auth.test).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping %s for thread %s because message was authored by this app itself',
      'thread reply',
      threadTs,
    );
  });

  it('ignores self-authored bot thread replies even when they mention the bot explicitly', async () => {
    const threadTs = '1712345678.000103';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> please continue the thread',
        thread_ts: threadTs,
        ts: '1712345678.000104',
        type: 'message',
        user: 'U_BOT',
      },
    });

    expect(client.auth.test).toHaveBeenCalledOnce();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('deduplicates a thread self-mention that arrives through both app_mention and message ingress', async () => {
    const threadTs = '1712345678.000105';
    const messageTs = '1712345678.000106';
    const registry = createThreadExecutionRegistry();
    const { appMentionHandler, claudeExecutor, client, threadReplyHandler } =
      createDualIngressTestHarness(threadTs, registry);

    await appMentionHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> continue with the deliverable',
        thread_ts: threadTs,
        ts: messageTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    await threadReplyHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> continue with the deliverable',
        thread_ts: threadTs,
        ts: messageTs,
        type: 'message',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('processes a root Slack user-group mention only for the configured lead', async () => {
    const threadTs = '1712345678.000115';
    const { claudeExecutor, client, handler, renderer, sessionStore, threadContextLoader } =
      createThreadReplyTestHarness(threadTs, {
        agentTeams: {
          SAGENTS: {
            defaultLead: 'U_BOT',
            members: ['U_BOT', 'U_OTHER_BOT'],
          },
        },
        initialSessions: [],
      });

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<!subteam^SAGENTS|@agents> coordinate this task',
        ts: threadTs,
        type: 'message',
        user: 'U123',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(sessionStore.get(threadTs)).toMatchObject({
      a2aLead: 'U_BOT',
      channelId: 'C123',
      conversationMode: 'a2a',
      rootMessageTs: threadTs,
      threadTs,
    });
  });

  it('records a root Slack user-group mention on standby for non-lead members', async () => {
    const threadTs = '1712345678.000116';
    const { claudeExecutor, client, handler, renderer, sessionStore, threadContextLoader } =
      createThreadReplyTestHarness(threadTs, {
        agentTeams: {
          SAGENTS: {
            defaultLead: 'U_OTHER_BOT',
            members: ['U_BOT', 'U_OTHER_BOT'],
          },
        },
        initialSessions: [],
      });

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<!subteam^SAGENTS|@agents> coordinate this task',
        ts: threadTs,
        type: 'message',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
    expect(sessionStore.get(threadTs)).toMatchObject({
      a2aLead: 'U_OTHER_BOT',
      channelId: 'C123',
      conversationMode: 'a2a',
      rootMessageTs: threadTs,
      threadTs,
    });
  });

  it('lets the lead handle an A2A thread reply without an explicit mention', async () => {
    const threadTs = '1712345678.000118';
    const { claudeExecutor, client, handler } = createThreadReplyTestHarness(threadTs, {
      initialSessions: [createA2ASession(threadTs, { lead: 'U_BOT' })],
    });

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'please continue',
        thread_ts: threadTs,
        ts: '1712345678.000119',
        type: 'message',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('lets the A2A lead handle a root-authored bot reply without an explicit mention', async () => {
    const threadTs = '1712345678.000129';
    const { claudeExecutor, client, handler } = createThreadReplyTestHarness(threadTs, {
      initialSessions: [createA2ASession(threadTs, { lead: 'U_BOT' })],
    });
    client.conversations.replies.mockResolvedValue({
      messages: [{ ts: threadTs, user: 'U_TRIGGER', text: 'root' }],
    });

    await handler({
      client,
      event: {
        bot_id: 'B_TRIGGER',
        channel: 'C123',
        team: 'T123',
        text: 'please continue',
        thread_ts: threadTs,
        ts: '1712345678.000130',
        type: 'message',
        user: 'U_TRIGGER',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('keeps the A2A lead idle for non-root bot-authored participant replies', async () => {
    const threadTs = '1712345678.000131';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs, {
        initialSessions: [createA2ASession(threadTs, { lead: 'U_BOT' })],
      });
    client.conversations.replies.mockResolvedValue({
      messages: [{ ts: threadTs, user: 'U_TRIGGER', text: 'root' }],
    });

    await handler({
      client,
      event: {
        bot_id: 'B_OTHER',
        channel: 'C123',
        team: 'T123',
        text: 'A2A worker finished',
        thread_ts: threadTs,
        ts: '1712345678.000132',
        type: 'message',
        user: 'U_OTHER_BOT',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
  });

  it('keeps non-lead A2A participants idle when a user reply has no explicit mention', async () => {
    const threadTs = '1712345678.000120';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs, {
        initialSessions: [createA2ASession(threadTs, { lead: 'U_OTHER_BOT' })],
      });

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'please continue',
        thread_ts: threadTs,
        ts: '1712345678.000121',
        type: 'message',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(renderer.showThinkingIndicator).not.toHaveBeenCalled();
    expect(threadContextLoader.loadThread).not.toHaveBeenCalled();
  });

  it('lets an explicitly mentioned standby participant handle an A2A user reply', async () => {
    const threadTs = '1712345678.000122';
    const { claudeExecutor, client, handler } = createThreadReplyTestHarness(threadTs, {
      initialSessions: [createA2ASession(threadTs, { lead: 'U_OTHER_BOT' })],
    });

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> please take this part',
        thread_ts: threadTs,
        ts: '1712345678.000123',
        type: 'message',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('routes user replies that mention multiple A2A participants back to the lead', async () => {
    const threadTs = '1712345678.000124';
    const leadHarness = createThreadReplyTestHarness(threadTs, {
      initialSessions: [createA2ASession(threadTs, { lead: 'U_BOT' })],
    });
    const standbyHarness = createThreadReplyTestHarness(threadTs, {
      initialSessions: [createA2ASession(threadTs, { lead: 'U_OTHER_BOT' })],
    });
    const event = {
      channel: 'C123',
      team: 'T123',
      text: '<@U_BOT> <@U_OTHER_BOT> who should take this?',
      thread_ts: threadTs,
      ts: '1712345678.000125',
      type: 'message',
      user: 'U123',
    };

    await leadHarness.handler({ client: leadHarness.client, event });
    await standbyHarness.handler({ client: standbyHarness.client, event });

    expect(
      leadHarness.claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
    expect(
      standbyHarness.claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it('allows lead-authored A2A handoffs to wake a mentioned standby participant', async () => {
    const threadTs = '1712345678.000126';
    const a2aCoordinatorStore = new MemoryA2ACoordinatorStore();
    const { claudeExecutor, client, handler } = createThreadReplyTestHarness(threadTs, {
      a2aCoordinatorStore,
      initialSessions: [createA2ASession(threadTs, { lead: 'U_OTHER_BOT' })],
    });

    await handler({
      client,
      event: {
        bot_id: 'B_OTHER',
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> please handle the implementation',
        thread_ts: threadTs,
        ts: '1712345678.000127',
        type: 'message',
        user: 'U_OTHER_BOT',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(a2aCoordinatorStore.getAssignmentByTrigger(threadTs, '1712345678.000127')).toMatchObject(
      {
        agentStates: [{ agentId: 'U_BOT' }],
        leadId: 'U_OTHER_BOT',
      },
    );
  });

  it('automatically wakes the lead to summarize after failed or stopped A2A assignees are terminal', async () => {
    vi.useFakeTimers();
    try {
      const threadTs = '1712345678.000128';
      const a2aCoordinatorStore = new MemoryA2ACoordinatorStore();
      const assignment = a2aCoordinatorStore.createAssignment({
        agentIds: ['U_OTHER_BOT', 'U_THIRD_BOT'],
        channelId: 'C123',
        leadId: 'U_BOT',
        leadProviderId: 'claude-code',
        threadTs,
        triggerTs: '1712345678.000127',
      });
      a2aCoordinatorStore.markAgentTerminal(assignment.assignmentId, 'U_OTHER_BOT', 'failed');
      a2aCoordinatorStore.markAgentTerminal(assignment.assignmentId, 'U_THIRD_BOT', 'stopped');
      const { claudeExecutor, client, handler } = createThreadReplyTestHarness(threadTs, {
        a2aCoordinatorStore,
        initialSessions: [createA2ASession(threadTs, { lead: 'U_BOT' })],
      });

      await handler({
        client,
        event: {
          bot_id: 'B_OTHER',
          channel: 'C123',
          team: 'T123',
          text: 'A2A worker finished',
          thread_ts: threadTs,
          ts: '1712345678.000129',
          type: 'message',
          user: 'U_OTHER_BOT',
        },
      });
      expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.runOnlyPendingTimersAsync();

      expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
      const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(request.mentionText).toContain(`A2A_FINAL_SUMMARY ${assignment.assignmentId}`);
      expect(request.mentionText).toContain('<@U_OTHER_BOT>: failed');
      expect(request.mentionText).toContain('<@U_THIRD_BOT>: stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps direct co-mentioned app mentions on standby when another bot is first', async () => {
    const threadTs = '1712345678.000117';
    const { appMentionHandler, claudeExecutor, client } = createDualIngressTestHarness(threadTs);

    await appMentionHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '<@U_OTHER_BOT> <@U_BOT> coordinate this task',
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('processes bot-authored thread replies that mention this bot before a local session exists', async () => {
    const threadTs = '1712345678.000106';
    const messageTs = '1712345678.000107';
    const { claudeExecutor, client, handler, renderer, sessionStore, threadContextLoader } =
      createThreadReplyTestHarness(threadTs, {
        initialSessions: [],
      });
    client.conversations.replies.mockResolvedValue({
      messages: [
        {
          text: '<@U_OTHER_BOT> please join this thread',
          ts: threadTs,
          user: 'U_HUMAN',
        },
        {
          bot_id: 'B_OTHER',
          text: '<@U_BOT> please inspect the history',
          thread_ts: threadTs,
          ts: messageTs,
          user: 'U_OTHER_BOT',
        },
      ],
    });

    await handler({
      client,
      event: {
        bot_id: 'B_OTHER',
        channel: 'C123',
        team: 'T123',
        text: '<@U_BOT> please inspect the history',
        thread_ts: threadTs,
        ts: messageTs,
        type: 'message',
        user: 'U_OTHER_BOT',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(sessionStore.get(threadTs)).toMatchObject({
      channelId: 'C123',
      rootMessageTs: threadTs,
      threadTs,
    });
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      botUserId: 'U_BOT',
      botUserName: 'kagura',
      channelId: 'C123',
      mentionText: '<@U_BOT> please inspect the history',
      threadTs,
      userId: 'U_OTHER_BOT',
    });
  });

  it('allows app mentions even when Slack omits the team id', async () => {
    const threadTs = '1712345678.000107';
    const { appMentionHandler, claudeExecutor, client } = createDualIngressTestHarness(threadTs);

    await appMentionHandler({
      client,
      event: {
        channel: 'C123',
        text: '<@U_BOT> continue with the deliverable',
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      mentionText: '<@U_BOT> continue with the deliverable',
      threadTs,
      userId: 'U123',
    });
  });

  it('processes thread replies with image attachments only (no text)', async () => {
    const threadTs = '1712345678.000108';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '',
        subtype: 'file_share',
        files: [
          {
            id: 'F123ABC',
            mimetype: 'image/png',
            name: 'screenshot.png',
            url_private: 'https://files.slack.com/files-pri/T123-F123ABC/screenshot.png',
          },
        ],
        thread_ts: threadTs,
        ts: '1712345678.000109',
        type: 'message',
        user: 'U123',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('processes thread replies with text and image attachments', async () => {
    const threadTs = '1712345678.000110';
    const { claudeExecutor, client, handler, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: 'Here is the screenshot',
        subtype: 'file_share',
        files: [
          {
            id: 'F123DEF',
            mimetype: 'image/jpeg',
            name: 'photo.jpg',
            url_private: 'https://files.slack.com/files-pri/T123-F123DEF/photo.jpg',
          },
        ],
        thread_ts: threadTs,
        ts: '1712345678.000111',
        type: 'message',
        user: 'U123',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      mentionText: 'Here is the screenshot',
      threadTs,
    });
  });

  it('processes thread uploads when Slack omits channel and team ids', async () => {
    const threadTs = '1712345678.000113';
    const { claudeExecutor, client, handler, logger, renderer, threadContextLoader } =
      createThreadReplyTestHarness(threadTs);

    await handler({
      client,
      event: {
        text: 'Please inspect this upload',
        subtype: 'file_share',
        files: [
          {
            id: 'F123JKL',
            mimetype: 'image/png',
            name: 'upload.png',
            url_private: 'https://files.slack.com/files-pri/T123-F123JKL/upload.png',
          },
        ],
        thread_ts: threadTs,
        ts: '1712345678.000114',
        type: 'message',
        user: 'U123',
      },
    });

    expect(renderer.showThinkingIndicator).toHaveBeenCalledOnce();
    expect(threadContextLoader.loadThread).toHaveBeenCalledOnce();
    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      mentionText: 'Please inspect this upload',
      threadTs,
      userId: 'U123',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Thread reply missing channel id for thread %s; falling back to session channel %s',
      threadTs,
      'C123',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Thread reply missing team id for thread %s; continuing without it',
      threadTs,
    );
  });

  it('processes app mentions with image attachments only', async () => {
    const threadTs = '1712345678.000112';
    const { appMentionHandler, claudeExecutor, client } = createDualIngressTestHarness(threadTs);

    await appMentionHandler({
      client,
      event: {
        channel: 'C123',
        team: 'T123',
        text: '',
        files: [
          {
            id: 'F123GHI',
            mimetype: 'image/png',
            name: 'diagram.png',
            url_private: 'https://files.slack.com/files-pri/T123-F123GHI/diagram.png',
          },
        ],
        ts: threadTs,
        type: 'app_mention',
        user: 'U123',
      },
    });

    expect(claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [request] = (claudeExecutor.execute as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(request).toMatchObject({
      channelId: 'C123',
      threadTs,
      userId: 'U123',
    });
  });
});

function createThreadReplyTestHarness(
  threadTs: string,
  options: {
    a2aCoordinatorStore?: A2ACoordinatorStore;
    agentTeams?: AgentTeamsConfig;
    initialSessions?: SessionRecord[];
  } = {},
): {
  claudeExecutor: AgentExecutor;
  client: SlackWebClientLike & {
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
    conversations: {
      replies: ReturnType<typeof vi.fn>;
    };
  };
  handler: ReturnType<typeof createThreadReplyHandler>;
  logger: AppLogger;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
} {
  const logger = createTestLogger();
  const sessionStore = createMemorySessionStore(
    options.initialSessions ?? [
      {
        channelId: 'C123',
        createdAt: new Date().toISOString(),
        rootMessageTs: threadTs,
        threadTs,
        updatedAt: new Date().toISOString(),
      },
    ],
  );
  const claudeExecutor = {
    providerId: 'claude-code',
    execute: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentExecutor;
  const renderer = createRendererStub();
  const threadContextLoader = {
    loadThread: vi.fn().mockResolvedValue({
      channelId: 'C123',
      fileLoadFailures: [],
      loadedFiles: [],
      messages: [],
      renderedPrompt: 'Slack thread context:',
      threadTs,
      loadedImages: [],
      imageLoadFailures: [],
    }),
  } as unknown as SlackThreadContextLoader;
  const workspaceResolver = {
    resolveFromText: vi.fn().mockReturnValue({
      query: '',
      reason: 'unused in this test',
      status: 'missing',
    }),
  } as unknown as WorkspaceResolver;
  const handler = createThreadReplyHandler({
    a2aCoordinatorStore: options.a2aCoordinatorStore,
    analyticsStore: { upsert: vi.fn() } as unknown as SessionAnalyticsStore,
    agentTeams: options.agentTeams,
    channelPreferenceStore: { get: vi.fn().mockReturnValue(undefined), upsert: vi.fn() },
    claudeExecutor,
    logger,
    memoryStore: createMemoryStore(),
    renderer,
    sessionStore,
    threadContextLoader,
    threadExecutionRegistry: createThreadExecutionRegistry(),
    userInputBridge: new SlackUserInputBridge(logger),
    workspaceResolver,
  });
  const client = createSlackClientFixture();

  return {
    claudeExecutor,
    client,
    handler,
    logger,
    renderer,
    sessionStore,
    threadContextLoader,
  };
}

function createDualIngressTestHarness(
  threadTs: string,
  threadExecutionRegistry = createThreadExecutionRegistry(),
  options: { agentTeams?: AgentTeamsConfig } = {},
): {
  appMentionHandler: ReturnType<typeof createAppMentionHandler>;
  claudeExecutor: AgentExecutor;
  client: SlackWebClientLike & {
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
    conversations: {
      replies: ReturnType<typeof vi.fn>;
    };
  };
  threadReplyHandler: ReturnType<typeof createThreadReplyHandler>;
} {
  const logger = createTestLogger();
  const sessionStore = createMemorySessionStore([
    {
      channelId: 'C123',
      createdAt: new Date().toISOString(),
      rootMessageTs: threadTs,
      threadTs,
      updatedAt: new Date().toISOString(),
    },
  ]);
  const claudeExecutor = {
    providerId: 'claude-code',
    execute: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentExecutor;
  const renderer = createRendererStub();
  const threadContextLoader = {
    loadThread: vi.fn().mockResolvedValue({
      channelId: 'C123',
      fileLoadFailures: [],
      loadedFiles: [],
      messages: [],
      renderedPrompt: 'Slack thread context:',
      threadTs,
      loadedImages: [],
      imageLoadFailures: [],
    }),
  } as unknown as SlackThreadContextLoader;
  const workspaceResolver = {
    resolveFromText: vi.fn().mockReturnValue({
      query: '',
      reason: 'unused in this test',
      status: 'missing',
    }),
  } as unknown as WorkspaceResolver;
  const deps = {
    analyticsStore: { upsert: vi.fn() } as unknown as SessionAnalyticsStore,
    agentTeams: options.agentTeams,
    channelPreferenceStore: { get: vi.fn().mockReturnValue(undefined), upsert: vi.fn() },
    claudeExecutor,
    logger,
    memoryStore: createMemoryStore(),
    renderer,
    sessionStore,
    threadContextLoader,
    threadExecutionRegistry,
    userInputBridge: new SlackUserInputBridge(logger),
    workspaceResolver,
  };

  return {
    appMentionHandler: createAppMentionHandler(deps),
    claudeExecutor,
    client: createSlackClientFixture(),
    threadReplyHandler: createThreadReplyHandler(deps),
  };
}

function createSlackClientFixture(): SlackWebClientLike & {
  auth: {
    test: ReturnType<typeof vi.fn>;
  };
  conversations: {
    replies: ReturnType<typeof vi.fn>;
  };
} {
  return {
    assistant: {
      threads: {
        setStatus: vi.fn().mockResolvedValue({}),
      },
    },
    auth: {
      test: vi.fn().mockResolvedValue({ user: 'kagura', user_id: 'U_BOT' }),
    },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({ ts: '1712345678.000200' }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({}),
    },
  };
}

function createRendererStub(): SlackRenderer {
  return {
    addAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
    clearUiState: vi.fn().mockResolvedValue(undefined),
    deleteThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    finalizeThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
    removeAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
    postGeneratedFiles: vi.fn().mockResolvedValue([]),
    postGeneratedImages: vi.fn().mockResolvedValue([]),
    postThreadReply: vi.fn().mockResolvedValue(undefined),
    setUiState: vi.fn().mockResolvedValue(undefined),
    showThinkingIndicator: vi.fn().mockResolvedValue(undefined),
    upsertThreadProgressMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackRenderer;
}

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

function createMemorySessionStore(records: SessionRecord[] = []): SessionStore {
  const store = new Map(records.map((record) => [record.threadTs, { ...record }]));

  return {
    countAll: () => store.size,
    get: (threadTs) => {
      const record = store.get(threadTs);
      return record ? { ...record } : undefined;
    },
    patch: (threadTs, patch) => {
      const existing = store.get(threadTs);
      if (!existing) {
        return undefined;
      }

      const next: SessionRecord = {
        ...existing,
        ...patch,
        threadTs,
        updatedAt: new Date().toISOString(),
      };
      store.set(threadTs, next);
      return { ...next };
    },
    upsert: (record) => {
      const next = { ...record };
      store.set(record.threadTs, next);
      return { ...next };
    },
  };
}

function createA2ASession(
  threadTs: string,
  options: { lead: string; participants?: string[] },
): SessionRecord {
  return {
    a2aLead: options.lead,
    a2aParticipantsJson: JSON.stringify(options.participants ?? ['U_BOT', 'U_OTHER_BOT']),
    channelId: 'C123',
    conversationMode: 'a2a',
    createdAt: new Date().toISOString(),
    rootMessageTs: threadTs,
    threadTs,
    updatedAt: new Date().toISOString(),
  };
}

function createMemoryStore(): MemoryStore {
  return {
    countAll: vi.fn().mockReturnValue(0),
    delete: vi.fn().mockReturnValue(false),
    deleteAll: vi.fn().mockReturnValue(0),
    listRecent: vi.fn().mockReturnValue([]),
    listForContext: vi.fn().mockReturnValue({ global: [], workspace: [], preferences: [] }),
    prune: vi.fn().mockReturnValue(0),
    pruneAll: vi.fn().mockReturnValue(0),
    save: vi.fn().mockImplementation((input) => ({
      ...input,
      scope: input.repoId ? 'workspace' : 'global',
      createdAt: new Date().toISOString(),
      id: 'memory-1',
    })),
    saveWithDedup: vi.fn().mockImplementation((input) => ({
      ...input,
      scope: input.repoId ? 'workspace' : 'global',
      createdAt: new Date().toISOString(),
      id: 'memory-1',
    })),
    search: vi.fn().mockReturnValue([]),
  };
}
