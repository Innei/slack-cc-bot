import { eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { AppLogger } from '../logger/index.js';
import type { SessionRecord, SessionStore } from './types.js';

export class SqliteSessionStore implements SessionStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly logger: AppLogger,
  ) {}

  get(threadTs: string): SessionRecord | undefined {
    const row = this.db.select().from(sessions).where(eq(sessions.threadTs, threadTs)).get();
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  upsert(record: SessionRecord): SessionRecord {
    this.db
      .insert(sessions)
      .values({
        threadTs: record.threadTs,
        channelId: record.channelId,
        rootMessageTs: record.rootMessageTs,
        bootstrapMessageTs: record.bootstrapMessageTs ?? null,
        streamMessageTs: record.streamMessageTs ?? null,
        claudeSessionId: record.claudeSessionId ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: sessions.threadTs,
        set: {
          channelId: record.channelId,
          rootMessageTs: record.rootMessageTs,
          bootstrapMessageTs: record.bootstrapMessageTs ?? null,
          streamMessageTs: record.streamMessageTs ?? null,
          claudeSessionId: record.claudeSessionId ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      })
      .run();

    this.logger.debug('Upserted session record for thread %s', record.threadTs);
    return { ...record };
  }

  patch(threadTs: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const { threadTs: _discarded, ...safePatch } = patch;

    const existing = this.get(threadTs);
    if (!existing) return undefined;

    const next: SessionRecord = {
      ...existing,
      ...safePatch,
      threadTs,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .update(sessions)
      .set({
        channelId: next.channelId,
        rootMessageTs: next.rootMessageTs,
        bootstrapMessageTs: next.bootstrapMessageTs ?? null,
        streamMessageTs: next.streamMessageTs ?? null,
        claudeSessionId: next.claudeSessionId ?? null,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      })
      .where(eq(sessions.threadTs, threadTs))
      .run();

    this.logger.debug('Patched session record for thread %s', threadTs);
    return { ...next };
  }

  private rowToRecord(row: typeof sessions.$inferSelect): SessionRecord {
    const record: SessionRecord = {
      channelId: row.channelId,
      createdAt: row.createdAt,
      rootMessageTs: row.rootMessageTs,
      threadTs: row.threadTs,
      updatedAt: row.updatedAt,
    };
    if (row.bootstrapMessageTs !== null) record.bootstrapMessageTs = row.bootstrapMessageTs;
    if (row.claudeSessionId !== null) record.claudeSessionId = row.claudeSessionId;
    if (row.streamMessageTs !== null) record.streamMessageTs = row.streamMessageTs;
    return record;
  }
}
