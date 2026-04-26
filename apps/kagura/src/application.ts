import fs from 'node:fs';
import path from 'node:path';

import { resolveKaguraPaths } from '@kagura/cli/config/paths';

import { ClaudeAgentSdkExecutor } from '~/agent/providers/claude-code/adapter.js';
import { CodexCliExecutor } from '~/agent/providers/codex-cli/adapter.js';
import { createProviderRegistry } from '~/agent/registry.js';
import type { AgentExecutor } from '~/agent/types.js';
import { SqliteAnalyticsStore } from '~/analytics/sqlite-analytics-store.js';
import { SqliteChannelPreferenceStore } from '~/channel-preference/sqlite-channel-preference-store.js';
import { createDatabase } from '~/db/index.js';
import { FileClaudeExecutionProbe } from '~/e2e/live/file-claude-execution-probe.js';
import { FileSlackStatusProbe } from '~/e2e/live/file-slack-status-probe.js';
import { appConfigAgentTeams, env, validateLiveE2EEnv } from '~/env/server.js';
import { type AppLogger, createRootLogger } from '~/logger/index.js';
import { SqliteMemoryStore } from '~/memory/memory-store.js';
import { SqliteSessionStore } from '~/session/sqlite-session-store.js';
import { createSlackApp, type KaguraSlackApp, type SlackAppCredentials } from '~/slack/app.js';
import { syncSlashCommands } from '~/slack/commands/manifest-sync.js';
import {
  createThreadExecutionRegistry,
  type ThreadExecutionRegistry,
} from '~/slack/execution/thread-execution-registry.js';
import { SqliteA2ACoordinatorStore } from '~/slack/ingress/a2a-coordinator-store.js';
import type { AgentTeamsConfig } from '~/slack/ingress/agent-team-routing.js';
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

export interface RuntimeApplicationOptions {
  a2aCoordinatorDbPath?: string | undefined;
  agentTeams?: AgentTeamsConfig | undefined;
  claudePermissionMode?: typeof env.CLAUDE_PERMISSION_MODE | undefined;
  defaultProviderId?: 'claude-code' | 'codex-cli' | undefined;
  executionProbePath?: string | undefined;
  instanceLabel?: string | undefined;
  sessionDbPath?: string | undefined;
  skipManifestSync?: boolean | undefined;
  slackCredentials?: SlackAppCredentials | undefined;
  statusProbePath?: string | undefined;
}

export function createApplication(options?: RuntimeApplicationOptions): RuntimeApplication {
  const logger = createRootLogger().withTag(options?.instanceLabel ?? 'bootstrap');
  validateLiveE2EEnv();

  const kaguraPaths = resolveKaguraPaths();
  const dbPath =
    options?.sessionDbPath !== undefined
      ? path.resolve(process.cwd(), options.sessionDbPath)
      : env.SESSION_DB_PATH === './data/sessions.db'
        ? kaguraPaths.dbPath
        : path.resolve(process.cwd(), env.SESSION_DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { db, sqlite } = createDatabase(dbPath);
  const a2aCoordinatorDbPath = path.resolve(
    process.cwd(),
    options?.a2aCoordinatorDbPath ?? env.A2A_COORDINATOR_DB_PATH,
  );
  fs.mkdirSync(path.dirname(a2aCoordinatorDbPath), { recursive: true });
  const a2aCoordinatorStore = new SqliteA2ACoordinatorStore(a2aCoordinatorDbPath);
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
    ? new FileSlackStatusProbe(options?.statusProbePath ?? env.SLACK_E2E_STATUS_PROBE_PATH)
    : undefined;
  const executionProbe = env.SLACK_E2E_ENABLED
    ? new FileClaudeExecutionProbe(
        options?.executionProbePath ?? env.SLACK_E2E_EXECUTION_PROBE_PATH,
      )
    : undefined;
  const permissionBridge = new SlackPermissionBridge(logger.withTag('slack:permission'));
  const userInputBridge = new SlackUserInputBridge(logger.withTag('slack:user-input'));

  const ccExecutor = new ClaudeAgentSdkExecutor(
    logger.withTag('claude:session'),
    memoryStore,
    channelPreferenceStore,
    executionProbe,
    options?.claudePermissionMode ? { permissionMode: options.claudePermissionMode } : undefined,
  );
  const codexExecutor = new CodexCliExecutor(
    logger.withTag('codex:session'),
    memoryStore,
    channelPreferenceStore,
  );
  const providerRegistry = createProviderRegistry(
    options?.defaultProviderId ?? env.AGENT_DEFAULT_PROVIDER,
    new Map<string, AgentExecutor>([
      ['claude-code', ccExecutor],
      ['codex-cli', codexExecutor],
    ]),
  );

  const threadExecutionRegistry = createThreadExecutionRegistry({
    logger: logger.withTag('slack:execution'),
  });

  const slackApp: KaguraSlackApp = createSlackApp(
    {
      a2aCoordinatorStore,
      analyticsStore,
      agentTeams: options?.agentTeams ?? appConfigAgentTeams,
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
    },
    options?.slackCredentials ? { credentials: options.slackCredentials } : undefined,
  );

  return {
    logger,
    threadExecutionRegistry,
    async start() {
      if (
        !options?.skipManifestSync &&
        env.SLACK_APP_ID &&
        (env.SLACK_CONFIG_TOKEN || env.SLACK_CONFIG_REFRESH_TOKEN)
      ) {
        await syncSlashCommands({
          appId: env.SLACK_APP_ID,
          configToken: env.SLACK_CONFIG_TOKEN,
          refreshToken: env.SLACK_CONFIG_REFRESH_TOKEN,
          tokenStorePath: env.SLACK_CONFIG_TOKEN_STORE_PATH,
          logger: logger.withTag('manifest'),
        }).catch((error) => {
          logger.warn(
            'Slash command manifest sync failed (non-fatal): %s',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      await startSlackAppWithRetry(() => slackApp.start(), logger.withTag('slack:socket'));
      slackApp.startA2ASummaryPoller?.();
      logger.info('Slack Socket Mode application started.');
    },
    async stop() {
      slackApp.stopA2ASummaryPoller?.();
      await slackApp.stop();
      await providerRegistry.drain();
      a2aCoordinatorStore.close?.();
      sqlite.close();
      logger.info('Slack Socket Mode application stopped.');
    },
  };
}
