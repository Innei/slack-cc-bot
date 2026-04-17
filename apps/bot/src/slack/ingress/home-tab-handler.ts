import type { AgentProviderRegistry } from '~/agent/registry.js';
import type { SessionAnalyticsStore } from '~/analytics/types.js';
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
  analyticsStore: SessionAnalyticsStore;
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry: AgentProviderRegistry;
  sessionStore: SessionStore;
  workspaceResolver: WorkspaceResolver;
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem > 0 ? ` ${rem}s` : ''}`;
}

function fmtPercent(n: number): string {
  return `${Math.round(n * 100)}%`;
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

      let userName: string | undefined;
      try {
        const slackClient = client as any;
        if (slackClient.users?.info) {
          const userInfo = await slackClient.users.info({ user: userId });
          userName = resolveUserName(userInfo?.user?.profile);
        }
      } catch {
        // fall through
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

      // --- Analytics data ---
      const overview = deps.analyticsStore.getOverview();
      const byModel = deps.analyticsStore.getByModel();
      const recentSessions = deps.analyticsStore.getRecentSessions(5);

      const blocks: unknown[] = [
        // --- Greeting ---
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${greeting}*\n🎭 *Kagura* (神楽) — the divine dance of AI in Slack. Every thread a stage, every response a dance.`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_Named after the celestial dance that drew Amaterasu from the heavenly rock cave — bringing light where there was darkness._',
            },
          ],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: timestamp }],
        },
        { type: 'divider' },

        // --- Getting Started ---
        {
          type: 'header',
          text: { type: 'plain_text', text: '⚡ How to Use', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `📌 *Mention* — Type ${botMention} in any channel to ask a question`,
              '💬 *Chat* — Click the *Messages* tab above to start a conversation',
              '🧵 *Thread* — Reply in an existing thread to continue the conversation',
            ].join('\n'),
          },
        },
        { type: 'divider' },

        // --- Overview ---
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

        // --- Analytics Overview ---
        {
          type: 'header',
          text: { type: 'plain_text', text: '📈 Session Analytics', emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Total Cost*\n${fmtUSD(overview.totalCostUSD)}` },
            { type: 'mrkdwn', text: `*Total Sessions*\n${overview.totalSessions}` },
            { type: 'mrkdwn', text: `*Avg Duration*\n${fmtDuration(overview.avgDurationMs)}` },
            { type: 'mrkdwn', text: `*Cache Hit Rate*\n${fmtPercent(overview.cacheHitRate)}` },
            { type: 'mrkdwn', text: `*Input Tokens*\n${fmtTokens(overview.totalInputTokens)}` },
            { type: 'mrkdwn', text: `*Output Tokens*\n${fmtTokens(overview.totalOutputTokens)}` },
          ],
        },
      ];

      // --- By Model ---
      if (byModel.length > 0) {
        blocks.push({ type: 'divider' });
        blocks.push({
          type: 'header',
          text: { type: 'plain_text', text: '🤖 By Model', emoji: true },
        });
        for (const m of byModel) {
          blocks.push({
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Model*\n\`${m.model}\`` },
              { type: 'mrkdwn', text: `*Sessions*\n${m.sessions}` },
              { type: 'mrkdwn', text: `*Cost*\n${fmtUSD(m.totalCostUSD)}` },
              { type: 'mrkdwn', text: `*Cache Hit*\n${fmtPercent(m.cacheHitRate)}` },
              {
                type: 'mrkdwn',
                text: `*In/Out Tokens*\n${fmtTokens(m.inputTokens)} / ${fmtTokens(m.outputTokens)}`,
              },
              { type: 'mrkdwn', text: `*Cache Read*\n${fmtTokens(m.cacheReadTokens)}` },
            ],
          });
        }
      }

      // --- Recent Sessions ---
      if (recentSessions.length > 0) {
        blocks.push({ type: 'divider' });
        blocks.push({
          type: 'header',
          text: { type: 'plain_text', text: '📜 Recent Sessions', emoji: true },
        });
        for (const s of recentSessions) {
          const cost = fmtUSD(s.totalCostUSD);
          const dur = fmtDuration(s.durationMs);
          const inTok = fmtTokens(s.inputTokens);
          const outTok = fmtTokens(s.outputTokens);
          const cacheRate =
            s.inputTokens > 0 ? fmtPercent(s.cacheReadInputTokens / s.inputTokens) : 'N/A';
          const date = `<!date^${Math.floor(new Date(s.createdAt).getTime() / 1000)}^{date_short} {time}|${s.createdAt}>`;

          let modelSummary = '';
          try {
            const models = JSON.parse(s.modelUsageJson) as Array<{ model: string }>;
            modelSummary = [...new Set(models.map((m) => m.model))].join(', ');
          } catch {
            modelSummary = 'unknown';
          }

          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `*${date}*  ·  ${cost}  ·  ${dur}`,
                `Tokens: ${inTok} in / ${outTok} out  ·  Cache: ${cacheRate}`,
                modelSummary ? `_Models: ${modelSummary}_` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          });
        }
      }

      // --- Provider + Version + Refresh ---
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: '🔌 Providers', emoji: true },
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${providerList}`,
        },
      });
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              '🎭 Kagura `' +
              gitShort +
              '`  ·  `/usage` stats  ·  `/workspace` repos  ·  `/memory` memories  ·  `/version` build info',
          },
        ],
      });
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔄 Refresh', emoji: true },
            action_id: HOME_TAB_REFRESH_ACTION_ID,
          },
        ],
      });

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
