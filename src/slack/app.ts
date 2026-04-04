import { App, Assistant } from '@slack/bolt';

import type { ClaudeExecutor } from '../claude/executor/types.js';
import { env } from '../env/server.js';
import type { AppLogger } from '../logger/index.js';
import type { MemoryStore } from '../memory/types.js';
import type { SessionStore } from '../session/types.js';
import type { WorkspaceResolver } from '../workspace/resolver.js';
import { SlackThreadContextLoader } from './context/thread-context-loader.js';
import {
  createAppMentionHandler,
  createAssistantThreadStartedHandler,
  createAssistantUserMessageHandler,
  createThreadReplyHandler,
  WORKSPACE_PICKER_ACTION_ID,
} from './ingress/app-mention-handler.js';
import {
  createWorkspaceMessageActionHandler,
  createWorkspaceSelectionViewHandler,
  WORKSPACE_MESSAGE_ACTION_CALLBACK_ID,
  WORKSPACE_MODAL_CALLBACK_ID,
} from './interactions/workspace-message-action.js';
import { createWorkspacePickerActionHandler } from './interactions/workspace-picker-action.js';
import { SlackRenderer } from './render/slack-renderer.js';
import type { SlackStatusProbe } from './render/status-probe.js';

export interface SlackApplicationDependencies {
  claudeExecutor: ClaudeExecutor;
  logger: AppLogger;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  statusProbe?: SlackStatusProbe;
  workspaceResolver: WorkspaceResolver;
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
    memoryStore: deps.memoryStore,
    renderer,
    threadContextLoader,
    sessionStore: deps.sessionStore,
    claudeExecutor: deps.claudeExecutor,
    workspaceResolver: deps.workspaceResolver,
  };
  const assistant = new Assistant({
    threadStarted: createAssistantThreadStartedHandler(ingressDeps),
    userMessage: createAssistantUserMessageHandler(ingressDeps),
  });

  app.event('app_mention', createAppMentionHandler(ingressDeps));
  app.event('message', createThreadReplyHandler(ingressDeps));
  app.shortcut(
    { callback_id: WORKSPACE_MESSAGE_ACTION_CALLBACK_ID, type: 'message_action' },
    createWorkspaceMessageActionHandler(ingressDeps),
  );
  app.view(WORKSPACE_MODAL_CALLBACK_ID, createWorkspaceSelectionViewHandler(ingressDeps));
  app.action(WORKSPACE_PICKER_ACTION_ID, createWorkspacePickerActionHandler(ingressDeps) as any);
  app.assistant(assistant);

  app.error(async (error) => {
    deps.logger.error('Slack Bolt unhandled error: %s', error.message ?? String(error));
  });

  return app;
}
