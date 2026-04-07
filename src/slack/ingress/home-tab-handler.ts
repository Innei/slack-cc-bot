import type { AgentProviderRegistry } from '~/agent/registry.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionStore } from '~/session/types.js';
import { formatUptime } from '~/util/format.js';
import { resolveGitHash } from '~/util/version.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';

import type { SlackWebClientLike } from '../types.js';
import { resolveUserName } from '../user-profile.js';

export const HOME_TAB_REFRESH_ACTION_ID = 'home_tab_refresh';

const startTime = Date.now();

export interface HomeTabDependencies {
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry: AgentProviderRegistry;
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

      // Fetch user profile for personalized greeting
      let userName: string | undefined;
      try {
        const slackClient = client as any;
        if (slackClient.users?.info) {
          const userInfo = await slackClient.users.info({ user: userId });
          userName = resolveUserName(userInfo?.user?.profile);
        }
      } catch {
        // Silently fall back to generic greeting
      }

      const sessionCount = deps.sessionStore.countAll();
      const memoryCount = deps.memoryStore.countAll();
      const repos = deps.workspaceResolver.listRepos();
      const uptimeMs = Date.now() - startTime;
      const uptimeFormatted = formatUptime(uptimeMs);
      const gitHash = resolveGitHash();
      const gitShort = gitHash.length >= 7 ? gitHash.slice(0, 7) : gitHash;

      const greeting = userName ? `Hey ${userName}! 👋` : 'Hey there! 👋';
      const now = new Date();
      const timestamp = `<!date^${Math.floor(now.getTime() / 1000)}^Last visited {date_short_pretty} at {time}|${now.toISOString()}>`;

      const providerIds = deps.providerRegistry.providerIds;
      const defaultProvider = deps.providerRegistry.defaultProviderId;
      const providerList = providerIds
        .map((id) => (id === defaultProvider ? `\`${id}\` _(default)_` : `\`${id}\``))
        .join(', ');

      const blocks: unknown[] = [
        // --- Personalized greeting ---
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${greeting}*\nYour AI-powered coding companion in Slack. Mention me, start a thread, or use the Messages tab to get started.`,
          },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: timestamp }],
        },
        { type: 'divider' },

        // --- Getting Started ---
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

        // --- Overview stats ---
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
            { type: 'mrkdwn', text: `*Uptime*\n${uptimeFormatted}` },
          ],
        },
        { type: 'divider' },

        // --- Provider status ---
        {
          type: 'header',
          text: { type: 'plain_text', text: '🔌 Providers', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${providerList}`,
          },
        },
        { type: 'divider' },

        // --- Version info ---
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text:
                'Version `' +
                gitShort +
                '`  ·  `/usage` detailed stats  ·  `/workspace` manage repos  ·  `/memory` manage memories',
            },
          ],
        },

        // --- Refresh button ---
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '🔄 Refresh', emoji: true },
              action_id: HOME_TAB_REFRESH_ACTION_ID,
            },
          ],
        },
      ];

      await client.views.publish({
        user_id: userId,
        view: {
          type: 'home',
          blocks,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error('Failed to publish Home tab for user %s: %s', userId, message);
    }
  };
}
