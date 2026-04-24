import fs from 'node:fs';
import path from 'node:path';

import { resolveKaguraPaths } from '@kagura/cli/config/paths';
import type { App } from '@slack/bolt';

import { ClaudeAgentSdkExecutor } from '~/agent/providers/claude-code/adapter.js';
import { CodexCliExecutor } from '~/agent/providers/codex-cli/adapter.js';
import { createProviderRegistry } from '~/agent/registry.js';
import type { AgentExecutor } from '~/agent/types.js';
import { SqliteAnalyticsStore } from '~/analytics/sqlite-analytics-store.js';
import { SqliteChannelPreferenceStore } from '~/channel-preference/sqlite-channel-preference-store.js';
import { createDatabase } from '~/db/index.js';
import { FileClaudeExecutionProbe } from '~/e2e/live/file-claude-execution-probe.js';
import { FileSlackStatusProbe } from '~/e2e/live/file-slack-status-probe.js';
import { env, validateLiveE2EEnv } from '~/env/server.js';
import { type AppLogger, createRootLogger } from '~/logger/index.js';
import { SqliteMemoryStore } from '~/memory/memory-store.js';
import { SqliteSessionStore } from '~/session/sqlite-session-store.js';
import { createSlackApp } from '~/slack/app.js';
import { syncSlashCommands } from '~/slack/commands/manifest-sync.js';
import {
  createThreadExecutionRegistry,
  type ThreadExecutionRegistry,
} from '~/slack/execution/thread-execution-registry.js';
import { SlackPermissionBridge } from '~/slack/interaction/permission-bridge.js';
import { SlackUserInputBridge } from '~/slack/interaction/user-input-bridge.js';
import { startSlackAppWithRetry } from '~/slack/network-guard.js';
import { WorkspaceResolver } from '~/workspace/resolver.js';

export interface RuntimeApplication {
  readonly logger: AppLogger;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  readonly threadExecutionRegistry: ThreadExecutionRegistry;
}

export function createApplication(): RuntimeApplication {
  const logger = createRootLogger().withTag('bootstrap');
  validateLiveE2EEnv();

  const kaguraPaths = resolveKaguraPaths();
  const dbPath =
    env.SESSION_DB_PATH === './data/sessions.db'
      ? kaguraPaths.dbPath
      : path.resolve(process.cwd(), env.SESSION_DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { db, sqlite } = createDatabase(dbPath);
  const sessionStore = new SqliteSessionStore(db, logger.withTag('session'));
  const memoryStore = new SqliteMemoryStore(db, logger.withTag('memory'));
  const channelPreferenceStore = new SqliteChannelPreferenceStore(
    db,
    logger.withTag('channel-preference'),
  );
  const analyticsStore = new SqliteAnalyticsStore(db, logger.withTag('analytics'));
  memoryStore.pruneAll();
  const workspaceResolver = new WorkspaceResolver({
    repoRootDir: env.REPO_ROOT_DIR,
    scanDepth: env.REPO_SCAN_DEPTH,
  });
  const statusProbe = env.SLACK_E2E_ENABLED
    ? new FileSlackStatusProbe(env.SLACK_E2E_STATUS_PROBE_PATH)
    : undefined;
  const executionProbe = env.SLACK_E2E_ENABLED
    ? new FileClaudeExecutionProbe(env.SLACK_E2E_EXECUTION_PROBE_PATH)
    : undefined;
  const permissionBridge = new SlackPermissionBridge(logger.withTag('slack:permission'));
  const userInputBridge = new SlackUserInputBridge(logger.withTag('slack:user-input'));

  const ccExecutor = new ClaudeAgentSdkExecutor(
    logger.withTag('claude:session'),
    memoryStore,
    channelPreferenceStore,
    executionProbe,
  );
  const codexExecutor = new CodexCliExecutor(logger.withTag('codex:session'), memoryStore);
  const providerRegistry = createProviderRegistry(
    env.AGENT_DEFAULT_PROVIDER,
    new Map<string, AgentExecutor>([
      ['claude-code', ccExecutor],
      ['codex-cli', codexExecutor],
    ]),
  );

  const threadExecutionRegistry = createThreadExecutionRegistry({
    logger: logger.withTag('slack:execution'),
  });

  const slackApp: App = createSlackApp({
    analyticsStore,
    channelPreferenceStore,
    logger,
    memoryStore,
    permissionBridge,
    sessionStore,
    providerRegistry,
    threadExecutionRegistry,
    userInputBridge,
    workspaceResolver,
    ...(statusProbe ? { statusProbe } : {}),
  });

  return {
    logger,
    threadExecutionRegistry,
    async start() {
      if (env.SLACK_APP_ID && (env.SLACK_CONFIG_TOKEN || env.SLACK_CONFIG_REFRESH_TOKEN)) {
        await syncSlashCommands({
          appId: env.SLACK_APP_ID,
          configToken: env.SLACK_CONFIG_TOKEN,
          refreshToken: env.SLACK_CONFIG_REFRESH_TOKEN,
          logger: logger.withTag('manifest'),
        }).catch((error) => {
          logger.warn(
            'Slash command manifest sync failed (non-fatal): %s',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      await startSlackAppWithRetry(() => slackApp.start(), logger.withTag('slack:socket'));
      logger.info('Slack Socket Mode application started.');
    },
    async stop() {
      await slackApp.stop();
      await providerRegistry.drain();
      sqlite.close();
      logger.info('Slack Socket Mode application stopped.');
    },
  };
}
