import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionStore } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';

import type { SlackWebClientLike } from '../types.js';

export interface HomeTabDependencies {
  logger: AppLogger;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  workspaceResolver: WorkspaceResolver;
}

export function createHomeTabHandler(deps: HomeTabDependencies) {
  return async (args: { client: unknown; event: unknown }): Promise<void> => {
    const event = args.event as { user: string; tab: string };
    if (event.tab !== 'home') return;

    const client = args.client as SlackWebClientLike;
    const userId = event.user;

    try {
      const botInfo = await client.auth!.test();
      const botMention = botInfo.user_id ? `<@${botInfo.user_id}>` : 'the bot';

      const sessionCount = deps.sessionStore.countAll();
      const memoryCount = deps.memoryStore.countAll();
      const repos = deps.workspaceResolver.listRepos();

      await client.views.publish({
        user_id: userId,
        view: {
          type: 'home',
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '🤖 Code Assistant', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Your AI-powered coding companion in Slack. Mention me, start a thread, or use the Messages tab to get started.',
              },
            },
            { type: 'divider' },
            {
              type: 'header',
              text: { type: 'plain_text', text: '⚡ Getting Started', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  '💬 *Chat* — Click the *Messages* tab above to start a conversation',
                  `📌 *Mention* — Type ${botMention} in any channel to ask a question`,
                  '🧵 *Thread* — Reply in an existing thread to continue the conversation',
                ].join('\n'),
              },
            },
            { type: 'divider' },
            {
              type: 'header',
              text: { type: 'plain_text', text: '📊 Overview', emoji: true },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Sessions*\n${sessionCount}` },
                { type: 'mrkdwn', text: `*Memories*\n${memoryCount}` },
                { type: 'mrkdwn', text: `*Repositories*\n${repos.length}` },
              ],
            },
            { type: 'divider' },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '`/usage` detailed stats  ·  `/workspace` manage repos  ·  `/memory` manage memories',
                },
              ],
            },
          ],
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error('Failed to publish Home tab for user %s: %s', userId, message);
    }
  };
}
