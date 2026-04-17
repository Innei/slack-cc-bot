import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  threadTs: text('thread_ts').primaryKey(),
  channelId: text('channel_id').notNull(),
  rootMessageTs: text('root_message_ts').notNull(),
  bootstrapMessageTs: text('bootstrap_message_ts'),
  streamMessageTs: text('stream_message_ts'),
  // Physical column name is kept for backward compatibility with existing SQLite files.
  providerSessionId: text('claude_session_id'),
  agentProvider: text('agent_provider'),
  workspaceRepoId: text('workspace_repo_id'),
  workspaceRepoPath: text('workspace_repo_path'),
  workspacePath: text('workspace_path'),
  workspaceLabel: text('workspace_label'),
  workspaceSource: text('workspace_source', { enum: ['auto', 'manual'] }),
  lastTurnTriggerTs: text('last_turn_trigger_ts'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  repoId: text('repo_id'),
  threadTs: text('thread_ts'),
  category: text('category', {
    enum: ['task_completed', 'decision', 'context', 'observation', 'preference'],
  }).notNull(),
  content: text('content').notNull(),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
});

export const sessionAnalytics = sqliteTable('session_analytics', {
  id: text('id').primaryKey(),
  threadTs: text('thread_ts').notNull(),
  userId: text('user_id'),
  totalCostUSD: real('total_cost_usd'),
  durationMs: integer('duration_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadInputTokens: integer('cache_read_input_tokens'),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  modelUsageJson: text('model_usage_json'),
  createdAt: text('created_at').notNull(),
});

export const channelPreferences = sqliteTable('channel_preferences', {
  channelId: text('channel_id').primaryKey(),
  defaultWorkspaceInput: text('default_workspace_input'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
