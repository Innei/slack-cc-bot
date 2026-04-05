import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  threadTs: text('thread_ts').primaryKey(),
  channelId: text('channel_id').notNull(),
  rootMessageTs: text('root_message_ts').notNull(),
  bootstrapMessageTs: text('bootstrap_message_ts'),
  streamMessageTs: text('stream_message_ts'),
  claudeSessionId: text('claude_session_id'),
  workspaceRepoId: text('workspace_repo_id'),
  workspaceRepoPath: text('workspace_repo_path'),
  workspacePath: text('workspace_path'),
  workspaceLabel: text('workspace_label'),
  workspaceSource: text('workspace_source', { enum: ['auto', 'manual'] }),
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
