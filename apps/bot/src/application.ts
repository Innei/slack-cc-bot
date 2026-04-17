import fs from 'node:fs';
import path from 'node:path';

import type { App } from '@slack/bolt';

import { ClaudeAgentSdkExecutor } from '~/agent/providers/claude-code/adapter.js';
import { createProviderRegistry } from '~/agent/registry.js';
import { SqliteAnalyticsStore } from '~/analytics/sqlite-analytics-store.js';
import { SqliteChannelPreferenceStore } from '~/channel-preference/sqlite-channel-preference-store.js';
import { createDatabase } from '~/db/index.js';
import { FileClaudeExecutionProbe } from '~/e2e/live/file-claude-execution-probe.js';
import { FileSlackStatusProbe } from '~/e2e/live/file-slack-status-probe.js';
import { env, validateLiveE2EEnv } from '~/env/server.js';
import { type AppLogger, createRootLogger } from '~/logger/index.js';
import { SqliteMemoryStore } from '~/memory/memory-store.js';
import { type HttpServerHandle, startHttpServer } from '~/server/http-server.js';
import { SqliteSessionStore } from '~/session/sqlite-session-store.js';
import { createSlackApp } from '~/slack/app.js';
import { syncSlashCommands } from '~/slack/commands/manifest-sync.js';
import {
  createThreadExecutionRegistry,
  type ThreadExecutionRegistry,
} from '~/slack/execution/thread-execution-registry.js';
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

  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
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
  const userInputBridge = new SlackUserInputBridge(logger.withTag('slack:user-input'));

  const ccExecutor = new ClaudeAgentSdkExecutor(
    logger.withTag('claude:session'),
    memoryStore,
    channelPreferenceStore,
    executionProbe,
  );
  const providerRegistry = createProviderRegistry(
    'claude-code',
    new Map([['claude-code', ccExecutor]]),
  );

  const threadExecutionRegistry = createThreadExecutionRegistry({
    logger: logger.withTag('slack:execution'),
  });

  const slackApp: App = createSlackApp({
    analyticsStore,
    channelPreferenceStore,
    logger,
    memoryStore,
    sessionStore,
    providerRegistry,
    threadExecutionRegistry,
    userInputBridge,
    workspaceResolver,
    ...(statusProbe ? { statusProbe } : {}),
  });

  let httpHandle: HttpServerHandle | undefined;

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

      httpHandle = await startHttpServer({
        buildInfo: {
          commitDate: typeof __GIT_COMMIT_DATE__ === 'string' ? __GIT_COMMIT_DATE__ : 'unknown',
          gitHash: typeof __GIT_HASH__ === 'string' ? __GIT_HASH__ : 'unknown',
          nodeEnv: env.NODE_ENV,
          version: '0.1.0',
        },
        deps: {
          analyticsStore,
          db,
          logger: logger.withTag('http'),
          memoryStore,
          sessionStore,
          workspaceResolver,
        },
        port: env.HTTP_PORT,
      });
    },
    async stop() {
      if (httpHandle) {
        await httpHandle.stop().catch((error) => {
          logger.warn(
            'HTTP server stop failed: %s',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      await slackApp.stop();
      await providerRegistry.drain();
      sqlite.close();
      logger.info('Slack Socket Mode application stopped.');
    },
  };
}

declare const __GIT_HASH__: string;
declare const __GIT_COMMIT_DATE__: string;
