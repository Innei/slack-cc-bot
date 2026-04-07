import { App, Assistant } from '@slack/bolt';

import type { AgentProviderRegistry } from '~/agent/registry.js';
import { env } from '~/env/server.js';
import type { AppLogger } from '~/logger/index.js';
import type { MemoryStore } from '~/memory/types.js';
import type { SessionStore } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';

import { registerSlashCommands } from './commands/register.js';
import { SlackThreadContextLoader } from './context/thread-context-loader.js';
import type { ThreadExecutionRegistry } from './execution/thread-execution-registry.js';
import {
  createAppMentionHandler,
  createAssistantThreadStartedHandler,
  createAssistantUserMessageHandler,
  createThreadReplyHandler,
  WORKSPACE_PICKER_ACTION_ID,
} from './ingress/app-mention-handler.js';
import { createHomeTabHandler } from './ingress/home-tab-handler.js';
import { createReactionStopHandler } from './ingress/reaction-stop-handler.js';
import {
  createStopMessageActionHandler,
  STOP_MESSAGE_ACTION_CALLBACK_ID,
} from './interactions/stop-message-action.js';
import type { SlackUserInputBridge } from './interaction/user-input-bridge.js';
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
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry: AgentProviderRegistry;
  sessionStore: SessionStore;
  statusProbe?: SlackStatusProbe;
  threadExecutionRegistry: ThreadExecutionRegistry;
  userInputBridge: SlackUserInputBridge;
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
  const defaultExecutor = deps.providerRegistry.getExecutor(
    deps.providerRegistry.defaultProviderId,
  );
  const ingressDeps = {
    logger: deps.logger.withTag('slack:ingress'),
    memoryStore: deps.memoryStore,
    renderer,
    threadContextLoader,
    sessionStore: deps.sessionStore,
    claudeExecutor: defaultExecutor,
    providerRegistry: deps.providerRegistry,
    threadExecutionRegistry: deps.threadExecutionRegistry,
    userInputBridge: deps.userInputBridge,
    workspaceResolver: deps.workspaceResolver,
  };
  const assistant = new Assistant({
    threadStarted: createAssistantThreadStartedHandler(ingressDeps),
    userMessage: createAssistantUserMessageHandler(ingressDeps),
  });

  app.event(
    'app_home_opened',
    createHomeTabHandler({
      logger: deps.logger.withTag('slack:home'),
      memoryStore: deps.memoryStore,
      sessionStore: deps.sessionStore,
      workspaceResolver: deps.workspaceResolver,
    }),
  );
  app.event('app_mention', createAppMentionHandler(ingressDeps));
  app.event('message', createThreadReplyHandler(ingressDeps));
  app.event(
    'reaction_added',
    createReactionStopHandler({
      logger: deps.logger.withTag('slack:reaction-stop'),
      threadExecutionRegistry: deps.threadExecutionRegistry,
    }),
  );
  registerSlashCommands(app, {
    logger: deps.logger.withTag('slack:commands'),
    memoryStore: deps.memoryStore,
    providerRegistry: deps.providerRegistry,
    sessionStore: deps.sessionStore,
    threadExecutionRegistry: deps.threadExecutionRegistry,
    workspaceResolver: deps.workspaceResolver,
  });
  app.shortcut(
    { callback_id: WORKSPACE_MESSAGE_ACTION_CALLBACK_ID, type: 'message_action' },
    createWorkspaceMessageActionHandler(ingressDeps),
  );
  app.shortcut(
    { callback_id: STOP_MESSAGE_ACTION_CALLBACK_ID, type: 'message_action' },
    createStopMessageActionHandler({
      logger: deps.logger.withTag('slack:stop-action'),
      threadExecutionRegistry: deps.threadExecutionRegistry,
    }),
  );
  app.view(WORKSPACE_MODAL_CALLBACK_ID, createWorkspaceSelectionViewHandler(ingressDeps));
  app.action(WORKSPACE_PICKER_ACTION_ID, createWorkspacePickerActionHandler(ingressDeps) as any);
  app.assistant(assistant);

  app.error(async (error) => {
    const message = error.message ?? String(error);
    deps.logger.error('Slack Bolt unhandled error: %s', message);
  });

  return app;
}
