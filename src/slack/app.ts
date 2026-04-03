import { App, Assistant } from '@slack/bolt';

import type { ClaudeExecutor } from '../claude/executor/types.js';
import { env } from '../env/server.js';
import type { AppLogger } from '../logger/index.js';
import type { SessionStore } from '../session/types.js';
import { SlackThreadContextLoader } from './context/thread-context-loader.js';
import {
  createAppMentionHandler,
  createAssistantThreadStartedHandler,
  createAssistantUserMessageHandler,
  createThreadReplyHandler,
} from './ingress/app-mention-handler.js';
import { SlackRenderer } from './render/slack-renderer.js';
import type { SlackStatusProbe } from './render/status-probe.js';

export interface SlackApplicationDependencies {
  claudeExecutor: ClaudeExecutor;
  logger: AppLogger;
  sessionStore: SessionStore;
  statusProbe?: SlackStatusProbe;
}

export function createSlackApp(deps: SlackApplicationDependencies): App {
  const app = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    socketMode: true,
  });

  const renderer = new SlackRenderer(deps.logger.withTag('slack:render'), deps.statusProbe);
  const threadContextLoader = new SlackThreadContextLoader(deps.logger.withTag('slack:context'));
  const ingressDeps = {
    logger: deps.logger.withTag('slack:ingress'),
    renderer,
    threadContextLoader,
    sessionStore: deps.sessionStore,
    claudeExecutor: deps.claudeExecutor,
  };
  const assistant = new Assistant({
    threadStarted: createAssistantThreadStartedHandler(ingressDeps),
    userMessage: createAssistantUserMessageHandler(ingressDeps),
  });

  app.event('app_mention', createAppMentionHandler(ingressDeps));
  app.event('message', createThreadReplyHandler(ingressDeps));
  app.assistant(assistant);

  app.error(async (error) => {
    deps.logger.error('Slack Bolt unhandled error: %s', error.message ?? String(error));
  });

  return app;
}
