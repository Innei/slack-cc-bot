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

      const repoLines =
        repos.length > 0
          ? repos.map((r) => `\`${r.label ?? r.name}\``).join(', ')
          : '_No repositories configured_';

      await client.views.publish({
        user_id: userId,
        view: {
          type: 'home',
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: 'AI Assistant', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Your AI coding assistant in Slack. Mention me in a channel, or start a chat from the *Chat* tab.',
              },
            },
            { type: 'divider' },
            {
              type: 'header',
              text: { type: 'plain_text', text: 'Quick Start', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  '*Chat* \u2014 Click the *Chat* tab above to start a conversation',
                  `*Mention* \u2014 ${botMention} in any channel to ask a question`,
                  '*Thread* \u2014 Reply in an existing thread to continue the conversation',
                ].join('\n'),
              },
            },
            { type: 'divider' },
            {
              type: 'header',
              text: { type: 'plain_text', text: 'Stats', emoji: true },
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
              type: 'header',
              text: { type: 'plain_text', text: 'Repositories', emoji: true },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: repoLines },
            },
            { type: 'divider' },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: 'Use `/usage` for detailed stats \u2022 `/workspace` to manage repos \u2022 `/memory` to manage memories',
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
