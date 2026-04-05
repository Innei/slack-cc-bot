import type { AgentProviderRegistry } from '~/agent/registry.js';
import type { AgentExecutor } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import type { ContextMemories, MemoryStore } from '~/memory/types.js';
import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import type { ResolvedWorkspace } from '~/workspace/types.js';

import type {
  NormalizedThreadContext,
  SlackThreadContextLoader,
} from '../context/thread-context-loader.js';
import type { SlackRenderer } from '../render/slack-renderer.js';
import type { SlackWebClientLike } from '../types.js';

export interface SlackIngressDependencies {
  claudeExecutor: AgentExecutor;
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry?: AgentProviderRegistry;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
  workspaceResolver: WorkspaceResolver;
}

export interface ThreadConversationMessage {
  channel: string;
  team: string;
  text: string;
  thread_ts?: string | undefined;
  ts: string;
  user: string;
}

export interface ThreadConversationOptions {
  addAcknowledgementReaction: boolean;
  forceNewSession?: boolean;
  logLabel: string;
  rootMessageTs: string;
  workspaceOverride?: ResolvedWorkspace;
}

export interface ConversationPipelineContext {
  client: SlackWebClientLike;
  contextMemories?: ContextMemories | undefined;
  deps: SlackIngressDependencies;
  existingSession?: SessionRecord | undefined;
  message: ThreadConversationMessage;

  options: ThreadConversationOptions;
  resumeHandle?: string | undefined;
  threadContext?: NormalizedThreadContext | undefined;
  threadTs: string;
  workspace?: ResolvedWorkspace | undefined;
}

export type PipelineStepResult = { action: 'continue' } | { action: 'done'; reason: string };

export type PipelineStep = (ctx: ConversationPipelineContext) => Promise<PipelineStepResult>;
