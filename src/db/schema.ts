import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  threadTs: text('thread_ts').primaryKey(),
  channelId: text('channel_id').notNull(),
  rootMessageTs: text('root_message_ts').notNull(),
  bootstrapMessageTs: text('bootstrap_message_ts'),
  streamMessageTs: text('stream_message_ts'),
  claudeSessionId: text('claude_session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
