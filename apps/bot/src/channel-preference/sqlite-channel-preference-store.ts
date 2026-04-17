import { eq } from 'drizzle-orm';

import type { AppDatabase } from '~/db/index.js';
import { channelPreferences } from '~/db/schema.js';
import type { AppLogger } from '~/logger/index.js';

import type { ChannelPreferenceRecord, ChannelPreferenceStore } from './types.js';

export class SqliteChannelPreferenceStore implements ChannelPreferenceStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly logger: AppLogger,
  ) {}

  get(channelId: string): ChannelPreferenceRecord | undefined {
    const row = this.db
      .select()
      .from(channelPreferences)
      .where(eq(channelPreferences.channelId, channelId))
      .get();
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  upsert(channelId: string, defaultWorkspaceInput: string | undefined): ChannelPreferenceRecord {
    const now = new Date().toISOString();
    const record: ChannelPreferenceRecord = {
      channelId,
      defaultWorkspaceInput,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .insert(channelPreferences)
      .values({
        channelId,
        defaultWorkspaceInput: defaultWorkspaceInput ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: channelPreferences.channelId,
        set: {
          defaultWorkspaceInput: defaultWorkspaceInput ?? null,
          updatedAt: now,
        },
      })
      .run();

    this.logger.debug('Upserted channel preference for %s', channelId);
    return record;
  }

  private rowToRecord(row: typeof channelPreferences.$inferSelect): ChannelPreferenceRecord {
    return {
      channelId: row.channelId,
      createdAt: row.createdAt,
      defaultWorkspaceInput: row.defaultWorkspaceInput ?? undefined,
      updatedAt: row.updatedAt,
    };
  }
}
