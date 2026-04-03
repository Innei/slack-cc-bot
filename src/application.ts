import fs from 'node:fs';
import path from 'node:path';

import type { App } from '@slack/bolt';

import { ClaudeAgentSdkExecutor } from './claude/executor/anthropic-agent-sdk.js';
import { createDatabase } from './db/index.js';
import { env } from './env/server.js';
import { type AppLogger, createRootLogger } from './logger/index.js';
import { SqliteSessionStore } from './session/sqlite-session-store.js';
import { createSlackApp } from './slack/app.js';

export interface RuntimeApplication {
  readonly logger: AppLogger;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createApplication(): RuntimeApplication {
  const logger = createRootLogger().withTag('bootstrap');

  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { db, sqlite } = createDatabase(dbPath);
  const sessionStore = new SqliteSessionStore(db, logger.withTag('session'));

  const claudeExecutor = new ClaudeAgentSdkExecutor(logger.withTag('claude:session'));
  const slackApp: App = createSlackApp({
    logger,
    sessionStore,
    claudeExecutor,
  });

  return {
    logger,
    async start() {
      await slackApp.start();
      logger.info('Slack Socket Mode application started.');
    },
    async stop() {
      await slackApp.stop();
      sqlite.close();
      logger.info('Slack Socket Mode application stopped.');
    },
  };
}
